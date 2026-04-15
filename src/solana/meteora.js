import DLMM, { chunkBinRange } from '@meteora-ag/dlmm';
import { PublicKey, Keypair, Transaction, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import db, { savePosition, closePositionWithPnl, enqueueReconcileIssue, updatePositionLifecycle, runInQueue } from '../db/database.js';
import { updatePositionRuntimeState } from '../app/positionRuntimeState.js';
import { fetchWithTimeout, safeNum, withRetry, withExponentialBackoff, stringify, getConservativeSlippage } from '../utils/safeJson.js';
import { toLamports, fromLamports, sumBigInts } from '../utils/units.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { isDryRun } from '../config.js';
import { getWalletPositions as getLPAgentPositions, isLPAgentEnabled } from '../market/lpAgent.js';
import { swapToSol } from '../utils/jupiter.js';
import { getTokenBalance } from './wallet.js';
import { getMarketSnapshot } from '../market/oracle.js';
import crypto from 'crypto';

const METEORA_DLMM_API = 'https://dlmm-api.meteora.ag';

// Strip existing ComputeBudget instructions then inject fresh ones.
// Only works for Legacy Transaction — VersionedTransaction uses compiled format.
function injectPriorityFee(tx, { units = 400_000, microLamports = 200_000 } = {}) {
  if (tx instanceof VersionedTransaction) {
    // VersionedTransaction.message uses compiledInstructions (index-based, not TransactionInstruction[]).
    // Direct mutation causes TypeError: ix.programId is undefined.
    // Meteora SDK already embeds ComputeBudget for VersionedTX internally — skip injection.
    return;
  }

  // Legacy Transaction: strip existing ComputeBudget then prepend fresh limits.
  const CB = ComputeBudgetProgram.programId.toString();
  tx.instructions = (tx.instructions || []).filter(ix => ix.programId.toString() !== CB);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  );
}

// ─── Safe BN conversion — avoids floating point errors ──────────

function toBN(amount, decimals) {
  // Use string manipulation to avoid floating point precision issues
  // Example: 0.1 * 10^9 can be 99999999.99999 which Math.floor makes 99,999,999
  const parts = String(amount).split('.');
  const intPart = parts[0] || '0';
  let decPart = parts[1] || '';
  decPart = decPart.padEnd(decimals, '0').slice(0, decimals);

  const combined = intPart + decPart;
  return new BN(combined.replace(/^0+/, '') || '0');
}

// ─── TX confirmation via polling ─────────────────────────────────
// Lebih reliable dari confirmTransaction (websocket-based) yang sering
// timeout meski TX sudah landing di chain.

async function pollTxConfirm(connection, txHash, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      const val = status?.value;
      if (val?.err) throw new Error(`TX gagal on-chain: ${stringify(val.err)}`);
      if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') {
        return txHash;
      }
    } catch (e) {
      if (e.message?.startsWith('TX gagal')) throw e;
      // getSignatureStatus error (network issue) → terus polling
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error(`TX ${txHash.slice(0, 8)}… belum confirm setelah ${maxWaitMs / 1000}s`);
}

// ─── Bin ID → display price helpers ─────────────────────────────
// activeBinPrice = harga tokenX dalam tokenY (SDK units, decimal-adjusted)
// Untuk pool TOKEN/SOL: activeBinPrice ≈ SOL per TOKEN (misal 0.00574 SOL/USDC)
// Display untuk user: invert menjadi TOKEN/SOL (misal 174 USDC/SOL)

function binPrice(activeBinPrice, binStep, binOffset) {
  return activeBinPrice * Math.pow(1 + binStep / 10000, binOffset);
}

function toDisplayPrice(rawPrice, isSOLPair) {
  if (!rawPrice || rawPrice === 0) return 0;
  return isSOLPair ? 1 / rawPrice : rawPrice;
}

// ─── Pool Info ───────────────────────────────────────────────────

export async function getPoolInfo(poolAddress) {
  // Validate pool address format before attempting SDK calls
  if (!poolAddress || typeof poolAddress !== 'string' || (poolAddress.length !== 43 && poolAddress.length !== 44)) {
    const errorMsg = `Invalid pool address format: "${poolAddress}" (must be 43 or 44 chars, got ${poolAddress?.length || 0})`;
    console.error(`[meteora] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  return withRetry(async () => {
    const connection = getConnection();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const activeBin = await dlmmPool.getActiveBin();
    const binStep = dlmmPool.lbPair.binStep;

    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();

    // Resolve symbols & decimals via Jupiter cache
    const [xMeta, yMeta] = await resolveTokens([xMint, yMint]);

    const isSOLPair = yMint === WSOL_MINT;
    const rawPrice = parseFloat(activeBin.pricePerToken) || 0;
    const displayPrice = toDisplayPrice(rawPrice, isSOLPair);
    const priceUnit = isSOLPair ? `${xMeta.symbol}/SOL` : `${yMeta.symbol}/${xMeta.symbol}`;

    // Fetch extra metadata (fees, APR) from Datapi best-effort
    let extra = {};
    try {
      const resp = await fetchWithTimeout(`${METEORA_DLMM_API}/pools/${poolAddress}`, { headers: { Accept: 'application/json' } }, 5000);
      if (resp.ok) {
        const p = await resp.json();
        const fees24h = p.fees?.['24h'] || 0;
        const apr24h = (p.fee_tvl_ratio?.['24h'] || 0) * 100 * 365;
        extra = {
          feeApr: parseFloat(apr24h.toFixed(2)),
          tvl: p.tvl,
          fees24h: fees24h,
          volume24h: p.volume?.['24h'],
        };
      }
    } catch { /* proceed with basic on-chain data */ }

    return {
      address: poolAddress,
      tokenX: xMint,
      tokenY: yMint,
      tokenXSymbol: xMeta.symbol,
      tokenYSymbol: yMeta.symbol,
      tokenXDecimals: xMeta.decimals,
      tokenYDecimals: yMeta.decimals,
      activePrice: rawPrice,
      displayPrice: parseFloat(displayPrice.toFixed(6)),
      priceUnit,
      activeBinId: activeBin.binId,
      binStep,
      feeRate: (binStep / 100).toFixed(2) + '%',
      isSOLPair,
      ...extra,
    };
  });
}

// ─── Meteora API fallback for position info ──────────────────────
// Called when the on-chain SDK call fails (RPC timeout, node issue).
// Returns same shape as getPositionInfo() — subset of fields.
// Field mapping from Meteora REST API response.
// Exported as getPositionInfoLight for lightweight use (monitor, status updates).

async function getPositionInfoFromMeteoraAPI(poolAddress) {
  try {
    const wallet = getWallet();
    const owner = wallet.publicKey.toString();

    // Primary: user+pair filter
    const url = `${METEORA_DLMM_API}/position/list_by_user_and_pair?user=${owner}&pair=${poolAddress}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) return null;

    const raw = await res.json();
    const rows = Array.isArray(raw) ? raw : (raw.userPositions ?? raw.positions ?? raw.data ?? []);
    if (!rows.length) return [];

    return rows.map(p => {
      const xAmt = parseFloat(p.totalXAmount ?? p.total_x_amount ?? 0);
      const yAmt = parseFloat(p.totalYAmount ?? p.total_y_amount ?? 0);
      const feeX = parseFloat(p.feeX ?? p.fee_x ?? p.unclaimed_fee_x ?? 0);
      const feeY = parseFloat(p.feeY ?? p.fee_y ?? p.unclaimed_fee_y ?? 0);
      const price = parseFloat(p.currentPrice ?? p.active_bin_price ?? 0);
      const valSol = yAmt + feeY + (xAmt + feeX) * price;
      const feeSol = feeY + feeX * price;

      return {
        address: p.address ?? p.pubkey ?? p.positionAddress ?? '',
        currentValueSol: parseFloat(valSol.toFixed(9)),
        feeCollectedSol: parseFloat(feeSol.toFixed(9)),
        inRange: p.inRange ?? p.is_in_range ?? true,
        lowerBinId: p.lowerBinId ?? p.lower_bin_id ?? 0,
        upperBinId: p.upperBinId ?? p.upper_bin_id ?? 0,
        activeBinId: p.activeBinId ?? p.active_bin_id ?? 0,
        binStep: p.binStep ?? p.bin_step ?? 0,
        currentPrice: price,
        fromAPI: true,  // signals this is from REST API, not on-chain
      };
    });
  } catch (e) {
    console.warn('[meteora API]:', e.message);
    return null;
  }
}

// Lightweight export — tries Meteora REST API only (no on-chain RPC).
// Ideal for periodic monitor updates where RPC cost matters.
// Returns null on failure (caller should fall back gracefully).
export async function getPositionInfoLight(poolAddress) {
  return getPositionInfoFromMeteoraAPI(poolAddress);
}

// ─── Global Position Sync (Sensus Penduduk) ──────────────────────
// Memanggil semua posisi aktif untuk wallet ini di seluruh Meteora DLMM.
// Digunakan untuk "Self-Healing" (menemukan posisi gaib yang tidak ada di DB).
export async function getAllWalletPositions() {
  const wallet = getWallet();
  const owner = wallet.publicKey.toString();

  // Tier 1: Meteora API (Utama)
  try {
    const url = `${METEORA_DLMM_API}/position/list_by_user?user=${owner}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (res.ok) {
      const raw = await res.json();
      const rows = Array.isArray(raw) ? raw : (raw.userPositions ?? raw.positions ?? raw.data ?? []);
      if (rows.length > 0 || res.status === 200) {
        return rows.map(p => ({
          address: p.address ?? p.pubkey ?? p.positionAddress ?? '',
          poolAddress: p.pool_address ?? p.lbPair ?? p.lbPairAddress ?? '',
          currentValueSol: parseFloat((p.totalYAmount ?? p.total_y_amount ?? 0) + (p.totalXAmount ?? p.total_x_amount ?? 0) * (p.currentPrice ?? 0)),
          feeCollectedSol: parseFloat((p.feeY ?? p.unclaimed_fee_y ?? 0) + (p.feeX ?? p.unclaimed_fee_x ?? 0) * (p.currentPrice ?? 0)),
          inRange: p.inRange ?? p.is_in_range ?? true,
          lowerBinId: p.lowerBinId ?? p.lower_bin_id ?? 0,
          upperBinId: p.upperBinId ?? p.upper_bin_id ?? 0,
          currentPrice: p.currentPrice ?? 0,
          fromAPI: true,
        }));
      }
    }
  } catch (e) {
    console.warn(`⚠️ [meteora] Meteora API failed: ${e.message}. Falling back...`);
  }

  // Tier 2: LP Agent API (Cadangan 1)
  try {
    if (isLPAgentEnabled()) {
      const lpPos = await getLPAgentPositions(owner);
      if (lpPos && lpPos.length > 0) {
        console.log(`📡 [meteora] Recovered ${lpPos.length} positions via LP Agent.`);
        return lpPos;
      }
    }
  } catch (e) {
    console.warn(`⚠️ [meteora] LP Agent fallback failed: ${e.message}`);
  }

  // Tier 3: Direct Blockchain RPC Scan (Garda Terakhir)
  try {
    console.log(`🔍 [meteora] API failed, falling back to direct Blockchain RPC scan...`);
    const connection = getConnection();
    // Program ID Meteora DLMM: LBUZKh7B3LTayvS4ipSccvB6S7zP26syG9Y3u28Hn3F
    const accounts = await connection.getProgramAccounts(
      new PublicKey('LBUZKh7B3LTayvS4ipSccvB6S7zP26syG9Y3u28Hn3F'),
      {
        filters: [
          { dataSize: 1040 }, // Ukuran akun Position di DLMM
          { memcmp: { offset: 40, bytes: owner } } // Owner pubkey ada di offset 40
        ]
      }
    );

    if (accounts.length === 0) return [];
    
    console.log(`🟢 [meteora] Direct scan detected ${accounts.length} positions on-chain.`);
    return accounts.map(({ pubkey, account }) => {
      // Data parsing dasar: lbPair (8-40), owner (40-72)
      const lbPair = new PublicKey(account.data.slice(8, 40)).toString();
      return {
        address: pubkey.toString(),
        poolAddress: lbPair,
        currentValueSol: 0, // RPC scan tidak memberikan real-time value tanpa fetch pool (mahal)
        feeCollectedSol: 0, // Cukup berikan info alamat agar Healer bisa audit & fetch detail per koin
        inRange: true,
        fromRPC: true,
      };
    });
  } catch (e) {
    console.error(`❌ [meteora] CRITICAL: All position fetch channels failed:`, e.message);
    return null;
  }
}

// ─── Position Info ───────────────────────────────────────────────
// Returns [] (not null) when wallet has no open positions in this pool.
// null is reserved for network errors so callers can distinguish:
//   [] → no positions (manual close may have happened)
//   null → fetch error (network issue, don't mark as manual close)

export async function getPositionInfo(poolAddress) {
  // Validate pool address format before attempting SDK calls
  if (!poolAddress || typeof poolAddress !== 'string' || (poolAddress.length !== 43 && poolAddress.length !== 44)) {
    const errorMsg = `Invalid pool address format: "${poolAddress}" (must be 43 or 44 chars, got ${poolAddress?.length || 0})`;
    console.error(`[meteora] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  try {
    return await withRetry(async () => {
      const connection = getConnection();
      const walletBalance = await getWalletBalance();
      const gasReserve = cfg.gasReserve || 0.025; // Aegis-level reserve
      const minRequired = (deployAmountSol || 0.1) + gasReserve;
      if (safeNum(walletBalance) < minRequired) {
        // ... logic continues
      }
      const wallet = getWallet();
      const poolPubkey = new PublicKey(poolAddress);
      const dlmmPool = await DLMM.create(connection, poolPubkey);

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);

      // Return empty array (not null) so callers can detect manual close
      if (!userPositions || userPositions.length === 0) return [];

      const activeBin = await dlmmPool.getActiveBin();
      const binStep = dlmmPool.lbPair.binStep;

      const xMint = dlmmPool.tokenX.publicKey.toString();
      const yMint = dlmmPool.tokenY.publicKey.toString();

      // Resolve once, use for all positions in this pool
      const [xMeta, yMeta] = await resolveTokens([xMint, yMint]);
      const xDecimals = xMeta.decimals;
      const yDecimals = yMeta.decimals;

      const isSOLPair = yMint === WSOL_MINT;
      const rawActivePrice = parseFloat(activeBin.pricePerToken) || 0;
      const priceUnit = isSOLPair
        ? `${xMeta.symbol}/SOL`
        : `${yMeta.symbol}/${xMeta.symbol}`;

      return userPositions.map(pos => {
        const pd = pos.positionData;
        const lowerBinId = pd.lowerBinId;
        const upperBinId = pd.upperBinId;
        const activeBinId = activeBin.binId;
        const inRange = activeBinId >= lowerBinId && activeBinId <= upperBinId;
        const posAddr = pos.publicKey.toString();

        // Raw → human-readable amounts (using resolved decimals)
        const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDecimals);
        const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDecimals);
        const feeXUi = Number(pd.feeX?.toString() || '0') / Math.pow(10, xDecimals);
        const feeYUi = Number(pd.feeY?.toString() || '0') / Math.pow(10, yDecimals);

        // Current value in SOL — tokenY is always SOL for SOL pairs
        // For non-SOL pairs this is still an approximation
        const currentValueSol = totalYUi + feeYUi + (totalXUi + feeXUi) * rawActivePrice;
        const feeCollectedSol = feeYUi + feeXUi * rawActivePrice;

        // Price range for this position — compute from bin IDs
        // lowerBinPrice = price at lowerBinId (in SOL/tokenX)
        // display inverts for SOL pairs so range is in tokenX/SOL
        const lowerRaw = binPrice(rawActivePrice, binStep, lowerBinId - activeBinId);
        const upperRaw = binPrice(rawActivePrice, binStep, upperBinId - activeBinId);

        // For SOL pairs: displayLower (cheapest SOL) = invert of upperRaw,
        // displayUpper (most expensive SOL) = invert of lowerRaw
        const displayLowerPrice = isSOLPair
          ? (upperRaw > 0 ? parseFloat((1 / upperRaw).toFixed(4)) : 0)
          : parseFloat(lowerRaw.toFixed(8));
        const displayUpperPrice = isSOLPair
          ? (lowerRaw > 0 ? parseFloat((1 / lowerRaw).toFixed(4)) : 0)
          : parseFloat(upperRaw.toFixed(8));
        const displayCurrentPrice = parseFloat(toDisplayPrice(rawActivePrice, isSOLPair).toFixed(4));

        return {
          address: posAddr,
          // Raw on-chain amounts (string, for DB compat)
          tokenX: pd.totalXAmount?.toString() || '0',
          tokenY: pd.totalYAmount?.toString() || '0',
          feeX: pd.feeX?.toString() || '0',
          feeY: pd.feeY?.toString() || '0',
          // Human-readable amounts
          totalXUi,
          totalYUi,
          feeXUi,
          feeYUi,
          // SOL-denominated value (for PnL calc against deployed_sol)
          currentValueSol,
          feeCollectedSol,
          // Token metadata
          tokenXSymbol: xMeta.symbol,
          tokenYSymbol: yMeta.symbol,
          tokenXMint: xMint,
          tokenYMint: yMint,
          isSOLPair,
          // Price display (human-readable direction)
          displayCurrentPrice,
          displayLowerPrice,
          displayUpperPrice,
          priceUnit,
          // Bin data
          lowerBinId,
          upperBinId,
          activeBinId,
          binStep,
          inRange,
          // Raw SDK price (SOL/tokenX) — used internally for PnL calc
          currentPrice: rawActivePrice,
        };
      });
    }, 3, 2000);
  } catch (e) {
    // Tier 2: Meteora REST API fallback
    console.warn(`[meteora] SDK failed for ${poolAddress} (${poolAddress?.length || 0} chars): ${e.message}`);
    console.warn(`[meteora] Trying Meteora API...`);
    const meteoraResult = await getPositionInfoFromMeteoraAPI(poolAddress);
    if (meteoraResult !== null) return meteoraResult;

    // Tier 3: LP Agent fallback (if configured)
    if (isLPAgentEnabled()) {
      console.warn(`[meteora] Meteora API also failed, trying LP Agent fallback`);
      const wallet = getWallet();
      return await getLPAgentPositions(wallet.publicKey.toString());
    }

    return null;
  }
}

// ─── SOL price helper ────────────────────────────────────────────

export async function getSolPriceUsd() {
  try {
    const res = await fetchWithTimeout(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
      {}, 6000
    );
    if (!res.ok) return 150;
    const data = await res.json();
    const price = data.pairs?.[0]?.priceUsd;
    return price ? parseFloat(price) : 150;
  } catch {
    return 150;
  }
}

// ─── Open Position ───────────────────────────────────────────────
export async function openPosition(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent = 5, strategyName = null, deployOptions = {}) {
  return withExponentialBackoff(async () => {
    return _openPositionLogic(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent, strategyName, deployOptions);
  }, { maxRetries: 3, baseDelay: 2000 });
}

async function _openPositionLogic(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent = 5, strategyName = null, deployOptions = {}) {
  // Validate pool address format before attempting deployment
  if (!poolAddress || typeof poolAddress !== 'string' || (poolAddress.length !== 43 && poolAddress.length !== 44)) {
    const errorMsg = `Invalid pool address format: "${poolAddress}" (must be 43 or 44 chars, got ${poolAddress?.length || 0})`;
    console.error(`[meteora] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  if (isDryRun()) {
    console.log(`[DRY RUN] openPosition skipped: pool=${poolAddress} tokenX=${tokenXAmount} tokenY=${tokenYAmount}`);
    return { dryRun: true, poolAddress, tokenXAmount, tokenYAmount, priceRangePercent };
  }
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool = await DLMM.create(connection, poolPubkey);
  if (!dlmmPool || !dlmmPool.lbPair) {
    throw new Error(`Gagal memuat detail pool DLMM untuk ${poolAddress}. Pool mungkin tidak valid atau API sedang lag.`);
  }

  const binStep = dlmmPool.lbPair.binStep;

  if (binStep !== 100 && binStep !== 125) {
    throw new Error(`Pool ditolak: bin step ${binStep} tidak didukung. Evil Panda hanya accept binStep 100 atau 125.`);
  }

  const xMint = dlmmPool.tokenX.publicKey.toString();
  const yMint = dlmmPool.tokenY.publicKey.toString();
  const [xMeta, yMeta] = await resolveTokens([xMint, yMint]);
  const xDecimals = xMeta.decimals;
  const yDecimals = yMeta.decimals;
  const isSOLPair = yMint === WSOL_MINT;

  // ── JIT: Re-fetch active bin directly before range calc ─────────
  // This reduces the 'stale price' window between pool creation and deployment.
  const activeBin = await dlmmPool.getActiveBin();
  const rawActivePrice = safeNum(activeBin.pricePerToken) || 0;

  // ── Bin range calculation ────────────────────────────────────────
  // Support for Deep-Dip Offset strategies (e.g. Evil Panda -86% to -94%)
  const offsetMin = deployOptions?.entryPriceOffsetMin; // e.g. 86
  const offsetMax = deployOptions?.entryPriceOffsetMax; // e.g. 94

  let rangeMin, rangeMax;

  if (Number.isFinite(offsetMin) && Number.isFinite(offsetMax)) {
    // Deep Fishing logic: Price < Current
    // BinStepPct = binStep / 10000.  Percent / BinStepPct = Bins.
    const binStepPct = binStep / 10000;
    rangeMax = activeBin.binId - Math.floor((offsetMin / 100) / binStepPct);
    rangeMin = activeBin.binId - Math.floor((offsetMax / 100) / binStepPct);

    // Sentinel v61: Logarithmic math for precision bin placement.
    // DLMM uses geometric spacing: Price(bin) = Price(active) * (1.0001 ^ (binStep * offset))
    const binStepInt = parseInt(binStep);
    const logPriceRatio = (offset) => Math.log(1 - offset / 100);
    const logBinFactor = binStepInt * Math.log(1.0001);

    // rangeMax (Top) — OffsetMin (0%)
    // If offsetMin is 0, logPriceRatio is log(1) = 0.
    const offsetMinBins = Math.round(Math.abs(logPriceRatio(offsetMin) / logBinFactor)) || 0;
    rangeMax = activeBin.binId - offsetMinBins;

    // rangeMin (Bottom/Deep Sea) — OffsetMax (94%)
    const offsetMaxBins = Math.round(Math.abs(logPriceRatio(offsetMax) / logBinFactor));
    rangeMin = activeBin.binId - offsetMaxBins;

    // Aegis Safety Clamps
    const MAX_BINS_LIMIT = 1000;
    rangeMax = Math.min(rangeMax, activeBin.binId - 1); // Strictly Y-only (SOL)
    if (rangeMax - rangeMin > MAX_BINS_LIMIT) {
      rangeMin = rangeMax - MAX_BINS_LIMIT;
    }
  } else {
    // Classic centered-ish range
    const fixedBinsBelow = Number.isFinite(deployOptions?.fixedBinsBelow)
      ? Math.min(250, Math.max(2, Math.floor(deployOptions.fixedBinsBelow)))
      : null;
    const binPadding = Number.isFinite(deployOptions?.binPadding)
      ? Math.max(-2, Math.floor(deployOptions.binPadding))
      : 0; // Default to 0, which will be clamped to -1 later for Single Side

    const rawBins = fixedBinsBelow ?? Math.min(250 - binPadding, Math.max(2, Math.floor((priceRangePercent / 100) / (binStep / 10000))));
    rangeMin = activeBin.binId - rawBins;
    rangeMax = activeBin.binId + binPadding;
  }

  // Single-Side Y Safety Clamp:
  // If we supply 0 token X, the bin range MUST fall entirely strictly BELOW the active bin.
  // Otherwise, the SDK math calculates a required X proportion and throws an error/crash.
  if (tokenXAmount === 0 || tokenXAmount === '0') {
    rangeMax = Math.min(rangeMax, activeBin.binId - 1);

    // --- Meteora Sentinel Safety: MAX_BINS_LIMIT ---
    // Total bins supported by DLMM is ~1,400. Transaction size limits often hit around 600-800 per chunk.
    // We clamp the width to 1,000 bins to prevent deployment failure on high-precision pools.
    const MAX_WIDTH = 1000;
    if (rangeMax - rangeMin > MAX_WIDTH) {
      console.log(`[meteora] Clamp: Wide range truncated from ${rangeMax - rangeMin} bins to ${MAX_WIDTH} bins for transaction stability.`);
      rangeMin = rangeMax - MAX_WIDTH;
    }

    if (rangeMin > rangeMax) {
      // Fallback fallback if calculation pushed min over max
      rangeMin = rangeMax - 2;
    }
  }

  // ── Unified deterministic position recovery ─────────────────────
  const totalXBN = toBN(tokenXAmount, xDecimals);
  const totalYBN = toBN(tokenYAmount, yDecimals);

  const totalBins = (rangeMax - rangeMin) + 1;

  // Meteora PositionV2 supports up to 1,400 bins.
  // We chunk for Transaction Size Safety (Solana ~1232 byte limit).
  // Aegis: Balanced safety margin to 100 bins per chunk (Efficiency over fragmentation)
  let binChunks = totalBins <= 100
    ? [{ lowerBinId: rangeMin, upperBinId: rangeMax }]
    : chunkBinRange(rangeMin, rangeMax);

  // Sentinel v61.4: Guard against chunkBinRange returning null/undefined
  // This can happen on edge case volatility pools. Fallback to single chunk deployment.
  if (!Array.isArray(binChunks) || binChunks.length === 0) {
    console.warn(`[meteora] chunkBinRange returned invalid (${typeof binChunks}), fallback to single chunk`);
    binChunks = [{ lowerBinId: rangeMin, upperBinId: rangeMax }];
  }

  // ── Unified deterministic position recovery ─────────────────────
  // Derived from: (wallet + pool + strategy) - Allows auto-discovery after crash.
  const seedString = `${wallet.publicKey.toString()}_${poolAddress}_${strategyName || 'default'}`;
  const seed = crypto.createHash('sha256').update(seedString).digest();
  const posKp = Keypair.fromSeed(seed);

  // Aegis Recovery: Check if the position account already exists (partial previous deploy)
  let accountExists = false;
  try {
    const info = await connection.getAccountInfo(posKp.publicKey);
    accountExists = info !== null;
    if (accountExists) console.log(`[meteora] AEGIS RECOVER: Alamat posisi ${posKp.publicKey.toString()} sudah ada on-chain. Menggunakan akun yang ada.`);
  } catch { /* proceed with fallback */ }

  // ── Pre-Save Position Object (Watchtower) ──────────────────────
  // We register the position in DB BEFORE sending transactions.
  // This ensures recovery if the first chunk lands but the bot crashes.
  if (!accountExists) {
    await savePosition({
      pool_address: poolAddress,
      position_address: posKp.publicKey.toString(),
      token_x: xMint,
      token_y: yMint,
      token_x_amount: tokenXAmount,
      token_y_amount: tokenYAmount,
      deployed_sol: 0,
      deployed_usd: 0,
      entry_price: parseFloat(toDisplayPrice(rawActivePrice, isSOLPair).toFixed(10)),
      strategy_used: strategyName,
      token_x_symbol: xMeta.symbol,
      lifecycle_state: 'deploying'
    });
  }

  const allTxHashes = [];
  let totalSucceededSol = 0;

  try {
    for (let ci = 0; ci < binChunks.length; ci++) {
      const chunk = binChunks[ci];

      // Sentinel: Validate chunk structure before processing
      if (!chunk || typeof chunk.lowerBinId !== 'number' || typeof chunk.upperBinId !== 'number') {
        console.error(`[meteora] Invalid chunk at index ${ci}:`, chunk);
        throw new Error(`Invalid bin chunk structure at index ${ci}`);
      }

      console.log(`[meteora] Processing chunk ${ci}: lowerBinId=${chunk.lowerBinId}, upperBinId=${chunk.upperBinId}, accountExists=${accountExists}`);

      if (chunk.lowerBinId > chunk.upperBinId) {
        console.error(`[meteora] Invalid bin range: lowerBinId=${chunk.lowerBinId} > upperBinId=${chunk.upperBinId}`);
        throw new Error(`Invalid bin range in chunk ${ci}: lower > upper`);
      }

      const chunkBinsCount = chunk.upperBinId - chunk.lowerBinId + 1;

      // ── Chunk Amount Allocation ──────────────────────────────────
      // Chunk 0 (position creation): Use FULL amount to initialize position
      // Chunk 1+ (range extension): Use ZERO amount, only add empty bins
      // This prevents amount fragmentation and reduces transaction count
      let chunkTotalX, chunkTotalY;
      if (ci === 0) {
        // First chunk: Deploy full amount to create position
        chunkTotalX = totalXBN;
        chunkTotalY = totalYBN;
        console.log(`[meteora] Chunk 0 allocation: FULL amount (X=${chunkTotalX.toString()}, Y=${chunkTotalY.toString()})`);
      } else {
        // Subsequent chunks: Zero amount, only extend bin range
        chunkTotalX = new BN(0);
        chunkTotalY = new BN(0);
        console.log(`[meteora] Chunk ${ci} allocation: ZERO amount (only extend range)`);
      }

      let txs;
      const isDipFishing = (tokenXAmount === 0 || tokenXAmount === '0');

      if (ci === 0 && !accountExists) {
        // ── case A: New deployment, First chunk ───────────────
        // Dip Fishing (Y only) and Normal (X+Y) both use strategy-based approach
        // initializePositionAndAddLiquidityByWeight only works with X+Y, not Y-only
        if (isDipFishing) {
          // Dip Fishing: Y-only deposit below price (all in range)
          // Use strategy with spot distribution (type 0)
          console.log(`[meteora] case A dip fishing: range [${chunk.lowerBinId}, ${chunk.upperBinId}], totalY=${chunkTotalY.toString()}`);

          txs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: posKp.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkTotalX,
            totalYAmount: chunkTotalY,
            strategy: { maxBinId: chunk.upperBinId, minBinId: chunk.lowerBinId, strategyType: 0 },
          });
        } else {
          // Standard Deployment (e.g. Single-side SOL)
          console.log(`[meteora] case A normal: range [${chunk.lowerBinId}, ${chunk.upperBinId}], totalX=${chunkTotalX.toString()}, totalY=${chunkTotalY.toString()}`);

          txs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: posKp.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkTotalX,
            totalYAmount: chunkTotalY,
            strategy: { maxBinId: chunk.upperBinId, minBinId: chunk.lowerBinId, strategyType: 0 },
          });
        }
      } else {
        // ── case B: Existing account or subsequent chunks ──────────
        // For subsequent chunks, use strategy-based approach (safe for both X+Y and Y-only)
        // addLiquidityByWeight fails on Y-only (totalXAmount=0)
        if (isDipFishing) {
          console.log(`[meteora] case B dip fishing continuation: range [${chunk.lowerBinId}, ${chunk.upperBinId}], totalY=${chunkTotalY.toString()}`);

          txs = await dlmmPool.addLiquidityByStrategy({
            positionPubKey: posKp.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkTotalX,
            totalYAmount: chunkTotalY,
            strategy: { maxBinId: chunk.upperBinId, minBinId: chunk.lowerBinId, strategyType: 0 },
          });
        } else {
          // Normal case B: use weight-based distribution for balance
          const binIds = [];
          for (let b = chunk.lowerBinId; b <= chunk.upperBinId; b++) binIds.push(b);

          // Sentinel: Validate binIds not empty
          if (binIds.length === 0) {
            throw new Error(`binIds array is empty for chunk ${ci}: range [${chunk.lowerBinId}, ${chunk.upperBinId}]`);
          }

          // Obelisk: Precision weight distribution (Sum exactly 10,000)
          const weightValue = Math.floor(10000 / binIds.length);
          if (!Number.isFinite(weightValue) || weightValue <= 0) {
            throw new Error(`Invalid weight calculation in case B: weightValue=${weightValue} for ${binIds.length} bins`);
          }
          const weights = new Array(binIds.length).fill(weightValue);
          const currentSum = weights.reduce((a, b) => a + b, 0);
          if (currentSum < 10000) {
            weights[weights.length - 1] += (10000 - currentSum);
          }

          // Sentinel: Validate weights before passing to SDK
          if (!Array.isArray(weights) || weights.length === 0 || weights.some(w => !Number.isFinite(w) || w < 0)) {
            throw new Error(`Invalid weights array in case B: ${stringify(weights)}`);
          }

          console.log(`[meteora] case B normal add: binIds=${stringify(binIds)}, weights=${stringify(weights)}, totalXAmount=${chunkTotalX.toString()}, totalYAmount=${chunkTotalY.toString()}`);

          txs = await dlmmPool.addLiquidityByWeight({
            positionPubKey: posKp.publicKey,
            user: wallet.publicKey,
            totalXAmount: chunkTotalX,
            totalYAmount: chunkTotalY,
            binIds,
            weights,
          });
        }
      }

      console.log(`[meteora] SDK returned txs - type: ${typeof txs}, isArray: ${Array.isArray(txs)}, constructor: ${txs?.constructor?.name}`);
      if (!Array.isArray(txs) && txs) {
        console.log(`[meteora] txs object keys: ${Object.keys(txs || {}).slice(0, 10).join(', ')}`);
        console.log(`[meteora] txs.tx type: ${typeof txs.tx}, txs.transactions type: ${typeof txs.transactions}`);
      }

      const txList = Array.isArray(txs) ? txs : [txs];
      for (const tx of txList) {
        if (!tx) continue;

        console.log(`[meteora] ========== EXAMINING TX OBJECT FROM SDK ==========`);
        console.log(`[meteora] tx type: ${typeof tx}, constructor: ${tx?.constructor?.name}`);
        console.log(`[meteora] tx instanceof Transaction: ${tx instanceof Transaction}`);
        console.log(`[meteora] tx instanceof VersionedTransaction: ${tx instanceof VersionedTransaction}`);
        console.log(`[meteora] tx.sign type: ${typeof tx.sign}`);
        console.log(`[meteora] tx.serialize type: ${typeof tx.serialize}`);
        console.log(`[meteora] tx.signatures type: ${typeof tx.signatures}, isArray: ${Array.isArray(tx.signatures)}`);
        console.log(`[meteora] tx.instructions type: ${typeof tx.instructions}, isArray: ${Array.isArray(tx.instructions)}`);
        console.log(`[meteora] tx.message type: ${typeof tx.message}, has recentBlockhash: ${!!tx.message?.recentBlockhash}`);
        console.log(`[meteora] tx keys: ${Object.keys(tx || {}).join(', ')}`);

        const isVersioned = tx instanceof VersionedTransaction;
        console.log(`[meteora] Processing transaction type: ${isVersioned ? 'VersionedTransaction' : 'Legacy Transaction'}`);
        console.log(`[meteora] Pre-modification state - Signatures: ${tx.signatures?.length || 0}, Instructions: ${isVersioned ? tx.message.compiledInstructions?.length : tx.instructions?.length}`);

        // Ensure we always have a fresh blockhash for every chunk
        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        // Handle blockhash and feePayer based on transaction type
        if (isVersioned) {
          tx.message.recentBlockhash = blockhash;
          // VersionedTransaction has feePayer in message header, no need to set separately
          console.log(`[meteora] Set VersionedTransaction blockhash: ${blockhash}`);
        } else {
          // Legacy Transaction: Set feePayer but NOT blockhash
          // We'll use replaceRecentBlockhash: true in simulateTransaction instead
          // Setting both causes "Invalid arguments" conflict
          tx.feePayer = wallet.publicKey;
          console.log(`[meteora] Set Legacy Transaction feePayer: ${wallet.publicKey.toString()}`);
          console.log(`[meteora] Blockhash will be replaced by RPC during simulateTransaction`);
        }

        // Priority fee — slightly higher for large bin deployments
        let microLamports = 250_000;
        // Aegis: Increased compute budget for addLiquidityByWeight (more instructions)
        let computeUnits = totalBins > 50 ? 1_200_000 : 600_000;
        try {
          const recommended = await getRecommendedPriorityFee([poolAddress, xMint, yMint]);
          if (recommended > 0) microLamports = recommended;
        } catch { /* fallback */ }

        injectPriorityFee(tx, { units: computeUnits, microLamports });
        console.log(`[meteora] After injectPriorityFee - Instructions: ${isVersioned ? tx.message.compiledInstructions?.length : tx.instructions?.length}`);

        // Sign with wallet and the single position keypair
        console.log(`[meteora] Before signing - Signatures: ${tx.signatures?.length || 0}`);
        console.log(`[meteora] Wallet type: ${typeof wallet}, constructor: ${wallet?.constructor?.name}`);
        console.log(`[meteora] Wallet pubkey: ${wallet.publicKey?.toString?.()}`);
        console.log(`[meteora] Wallet has secretKey: ${!!wallet.secretKey}`);
        console.log(`[meteora] PosKp type: ${typeof posKp}, constructor: ${posKp?.constructor?.name}`);
        console.log(`[meteora] PosKp pubkey: ${posKp.publicKey?.toString?.()}`);
        console.log(`[meteora] PosKp has secretKey: ${!!posKp.secretKey}`);

        // Sign transaction with both fee payer (wallet) and position keypair
        // SDK Meteora add instructions that require both signatures for account initialization
        try {
          if (isVersioned) {
            tx.signatures = [];
            tx.sign([wallet, posKp]);
            console.log(`[meteora] Signed VersionedTransaction with wallet + posKp - Signatures: ${tx.signatures?.length || 0}`);
          } else {
            tx.sign(posKp, wallet);
            console.log(`[meteora] Signed Legacy Transaction with posKp + wallet - Signatures: ${tx.signatures?.length || 0}`);
          }
        } catch (sigErr) {
          console.error(`[meteora] ERROR signing transaction:`, sigErr.message);
          throw sigErr;
        }

        // Validate transaction before simulation
        console.log(`[meteora] Pre-simulation validation:`);
        console.log(`  - Transaction type: ${isVersioned ? 'Versioned' : 'Legacy'}`);
        if (isVersioned) {
          console.log(`  - Blockhash: ${tx.message.recentBlockhash}`);
        } else {
          console.log(`  - Blockhash: <will be set by RPC via replaceRecentBlockhash>`);
        }
        console.log(`  - Signatures count: ${tx.signatures?.length || 0}`);

        // Detailed signature validation
        if (tx.signatures && tx.signatures.length > 0) {
          console.log(`  - Signature 0 type: ${typeof tx.signatures[0]}, constructor: ${tx.signatures[0]?.constructor?.name}`);
          console.log(`  - Signature 0 value: ${tx.signatures[0]?.toString?.() || stringify(tx.signatures[0])}`);
          if (tx.signatures[1]) {
            console.log(`  - Signature 1 type: ${typeof tx.signatures[1]}, constructor: ${tx.signatures[1]?.constructor?.name}`);
            console.log(`  - Signature 1 value: ${tx.signatures[1]?.toString?.() || stringify(tx.signatures[1])}`);
          }
        }

        console.log(`  - Instructions count: ${isVersioned ? tx.message.compiledInstructions?.length : tx.instructions?.length}`);
        // Check for null/undefined signatures
        if (!tx.signatures || tx.signatures.length === 0) {
          console.error(`[meteora] ERROR: Transaction has no signatures!`);
        }

        // Check if signatures contain actual data
        if (tx.signatures?.some(sig => !sig || (typeof sig === 'object' && Object.keys(sig).length === 0))) {
          console.error(`[meteora] ERROR: Transaction has empty/null signatures!`);
        }

        try {
          // Watchtower: Pre-flight simulation for Compute Units (VersionedTransaction only)
          // Legacy transactions: Skip simulation, use sendRawTransaction preflight instead
          // (simulateTransaction with legacy + signature objects causes "Invalid arguments" error)
          let sim;
          if (isVersioned) {
            try {
              sim = await connection.simulateTransaction(tx, { commitment: 'processed' });
              console.log(`[meteora] VersionedTransaction simulation result: ${sim.value.err ? 'error' : 'success'}`);
              if (sim.value.err) {
                console.warn(`[meteora] Simulation Warning: ${stringify(sim.value.err)}`);
                if (stringify(sim.value.err).includes('InstructionError')) {
                  throw new Error(`Simulation Failed: ${stringify(sim.value.err)}`);
                }
              }
            } catch (simErr) {
              console.warn(`[meteora] VersionedTransaction simulation failed: ${simErr.message}. Proceeding with send...`);
            }
          } else {
            console.log(`[meteora] Legacy Transaction: Skipping manual simulation (will use sendRawTransaction preflight)`);
          }

          const txHash = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: isVersioned, // Skip preflight if we already simulated (VersionedTransaction)
            preflightCommitment: 'confirmed',
            maxRetries: 1, // manual watchtower retry logic instead of RPC default
          });

          await pollTxConfirm(connection, txHash);
          allTxHashes.push(txHash);

          // Accurate Lamports conversion for DB
          const chunkYSol = parseFloat(fromLamports(chunkTotalY.toString(), yDecimals));
          totalSucceededSol += chunkYSol;

          // Aegis: Update DB setiap kali chunk berhasil (Incremental Save)
          // Jika chunk berikutnya gagal, kita tetep punya rekam jejak jumlah SOL yang masuk.
          const solPriceUsd = await getSolPriceUsd();
          const currentUsd = parseFloat((totalSucceededSol * solPriceUsd).toFixed(2));
          updatePositionRuntimeState(posKp.publicKey.toString(), {
            totalSucceededSol,
            status: totalSucceededSol >= tokenYAmount ? 'fully_deployed' : 'partially_deployed'
          });

          // Update database utama
          const _db = db || globalThis.db;
          await runInQueue(() => _db.prepare(`
          UPDATE positions SET 
            token_y_amount = ?, 
            deployed_sol = ?, 
            deployed_usd = ?,
            lifecycle_state = 'open'
          WHERE position_address = ?
        `).run(totalSucceededSol, totalSucceededSol, currentUsd, posKp.publicKey.toString()));

        } catch (e) {
          // Aegis: Log program logs on simulation failure
          if (e.logs) {
            console.error(`[meteora] TX Failed. Program Logs:\n${e.logs.join('\n')}`);
          }
          throw e;
        }
      }

      // Aegis: Wait between chunks to ensure position state is fully consistent on-chain
      // Chunk 0 creates the position account, chunk 1+ add liquidity to it
      // Without this wait, chunk 1 can fail with "index out of bounds" if position isn't fully synced
      if (ci < binChunks.length - 1) {
        const delayMs = 2000;
        console.log(`[meteora] Chunk ${ci} completed. Waiting ${delayMs}ms for position state to stabilize before chunk ${ci + 1}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  } catch (err) {
    if (totalSucceededSol > 0) {
      console.warn(`[meteora] Deployment parsial berhasil (${totalSucceededSol} SOL). Melanjutkan dengan status terdaftar.`);
    } else {
      // Hapus jika gagal total tanpa ada dana keluar sama sekali
      const _db = db || globalThis.db;
      _db.prepare(`DELETE FROM positions WHERE position_address = ? AND deployed_sol = 0`).run(posKp.publicKey.toString());
      throw err;
    }
  }

  const priceUnit = isSOLPair ? `${xMeta.symbol}/SOL` : `${yMeta.symbol}/${xMeta.symbol}`;

  return {
    success: true,
    txHash: allTxHashes[0],
    txHashes: allTxHashes,
    positionAddress: posKp.publicKey.toString(),
    positionAddresses: [posKp.publicKey.toString()],
    positionCount: 1,
    entryPrice: parseFloat(toDisplayPrice(rawActivePrice, isSOLPair).toFixed(10)),
    lowerPrice: parseFloat(toDisplayPrice(binPrice(rawActivePrice, binStep, rangeMin - activeBin.binId), isSOLPair).toFixed(10)),
    upperPrice: parseFloat(toDisplayPrice(binPrice(rawActivePrice, binStep, rangeMax - activeBin.binId), isSOLPair).toFixed(10)),
    priceUnit,
    priceRangePct: priceRangePercent,
    binRange: { min: rangeMin, max: rangeMax, active: activeBin.binId },
    binStep,
    feeRatePct: parseFloat((binStep / 100).toFixed(4)),
    tokenXAmount: 0,
    tokenYAmount: totalSucceededSol,
    tokenXSymbol: xMeta.symbol,
    tokenYSymbol: yMeta.symbol,
  };
}

// ─── Close Position ──────────────────────────────────────────────
// Flow per attempt:
//   1. Fresh DLMM pool + fresh on-chain state
//   2. Posisi sudah hilang → mark DB, return success
//   3. Tentukan shouldClaimAndClose dari fee aktual (tidak pakai try/catch)
//   4. Handle empty-bin position
//   5. Send TX dengan skipPreflight + polling confirm
//   6. Verifikasi on-chain: posisi benar-benar tidak ada lagi
//   7. Baru update DB

export async function closePositionDLMM(poolAddress, positionAddress, pnlData = {}, options = {}) {
  const isUrgent = options.isUrgent === true;
  if (isDryRun()) {
    const urgentFlag = isUrgent ? ' [URGENT]' : '';
    console.log(`[DRY RUN] closePositionDLMM skipped${urgentFlag}: pool=${poolAddress} pos=${positionAddress}`);
    return { dryRun: true, poolAddress, positionAddress, pnlData };
  }
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // ── 1. Fresh pool + fresh state per attempt ──────────────
      const dlmmPool = await DLMM.create(connection, poolPubkey);
      const positionPubkey = new PublicKey(positionAddress);

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const position = userPositions?.find(p => p.publicKey.toString() === positionAddress);

      // ── 2. Posisi tidak ditemukan via SDK ────────────────────
      // JANGAN langsung anggap closed — SDK bisa return empty karena RPC glitch.
      // Verifikasi dulu via getAccountInfo: kalau account masih ada = posisi masih terbuka.
      if (!position) {
        let accountStillExists = false;
        try {
          const accountInfo = await connection.getAccountInfo(positionPubkey);
          accountStillExists = accountInfo !== null;
        } catch { /* best-effort */ }

        if (accountStillExists) {
          // Account masih ada → SDK gagal fetch, bukan posisi sudah closed
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 3000 * attempt));
            continue; // retry dengan state terbaru
          }
          throw new Error(
            `Posisi tidak ditemukan via SDK tapi account masih ada on-chain. ` +
            `Kemungkinan RPC inconsistency. Coba close manual di Meteora UI.`
          );
        }

        // Account benar-benar tidak ada → posisi sudah tertutup
        await closePositionWithPnl(positionAddress, {
          pnlUsd: pnlData.pnlUsd || 0,
          pnlPct: pnlData.pnlPct || 0,
          feesUsd: pnlData.feeUsd || 0,
          closeReason: pnlData.closeReason || 'closed',
          lifecycleState: pnlData.lifecycleState || 'closed_pending_swap',
        });
        return { success: true, txHashes: [], alreadyClosed: true };
      }

      const pd = position.positionData;
      const binIdsToRemove = pd.positionBinData?.map(b => b.binId) ?? [];

      let removeLiqTx;

      // Helper: kirim satu TX dan tunggu konfirmasi, tambahkan hash ke txHashes
      // Dipakai di step 4 dan step 6 closePosition cleanup.
      const sendAndConfirmTx = async (tx, hashes) => {
        // Access 'connection' via closure from outer scope (defined at line 541)
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const isTxVersioned = tx instanceof VersionedTransaction;

        if (isTxVersioned) {
          // VersionedTransaction: blockhash masuk ke message, tidak ada field feePayer
          tx.message.recentBlockhash = blockhash;
        } else {
          // Legacy Transaction
          tx.recentBlockhash = blockhash;
          tx.feePayer = wallet.publicKey;
        }

        let microLamports = isUrgent ? 1_000_000 : 250_000;
        try {
          // Dynamic Exit Fee: Royal priority during dumps
          const rec = await getRecommendedPriorityFee([poolAddress]);
          if (rec > 0) {
            // TURBO EXIT: 2.5x multiplier for Panic Watchdog closures
            // STANDARD EXIT: 1.5x multiplier for normal rebalances
            const multiplier = isUrgent ? 2.5 : 1.5;
            microLamports = Math.floor(rec * multiplier);
          }
        } catch { /* fallback already set higher for urgent */ }

        injectPriorityFee(tx, { units: 400_000, microLamports });

        if (isTxVersioned) {
          tx.sign([wallet]); // VersionedTransaction.sign() menerima array of Signers
        } else {
          tx.sign(wallet);   // Legacy Transaction.sign() menerima spread Keypairs
        }

        const hash = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
        await pollTxConfirm(connection, hash, 60000);
        hashes.push(hash);
      };

      // SDK removeLiquidity minta fromBinId/toBinId/bps (BN) — BUKAN binIds/liquiditiesBpsToRemove.
      // bps = 10000 = 100% removal. Range dari positionData.lowerBinId/upperBinId.
      const fromBinId = pd.lowerBinId;
      const toBinId = pd.upperBinId;

      if (binIdsToRemove.length > 0) {
        // ── 4a. Position dengan bin aktif ────────────────────────
        // Selalu coba shouldClaimAndClose:true dulu — removes liq + claim fees + hapus account.
        // shouldClaimAndClose:false hanya tarik likuiditas, account TETAP ADA → Meteora UI open!
        try {
          removeLiqTx = await dlmmPool.removeLiquidity({
            position: positionPubkey,
            user: wallet.publicKey,
            fromBinId,
            toBinId,
            bps: new BN(10000), // 100% removal
            shouldClaimAndClose: true,
          });
        } catch {
          // Fallback: tarik likuiditas saja — account akan tetap ada.
          // Step 6 akan panggil closePosition() dengan LbPosition object yang benar.
          removeLiqTx = await dlmmPool.removeLiquidity({
            position: positionPubkey,
            user: wallet.publicKey,
            fromBinId,
            toBinId,
            bps: new BN(10000),
            shouldClaimAndClose: false,
          });
        }
      } else {
        // ── 4b. Position tanpa bin (kosong) ──────────────────────
        // PENTING: closePositionIfEmpty & closePosition minta LbPosition object (bukan PublicKey).
        // `position` di sini adalah LbPosition dari getPositionsByUserAndLbPair (step 1).
        let emptyCloseOk = false;

        // Coba 1: closePositionIfEmpty — designed khusus untuk empty position
        try {
          if (typeof dlmmPool.closePositionIfEmpty === 'function') {
            removeLiqTx = await dlmmPool.closePositionIfEmpty({
              owner: wallet.publicKey,
              position: position, // LbPosition object dari step 1
            });
            emptyCloseOk = true;
          }
        } catch { /* lanjut ke coba 2 */ }

        // Coba 2: closePosition — hapus account posisi langsung
        if (!emptyCloseOk) {
          try {
            if (typeof dlmmPool.closePosition === 'function') {
              removeLiqTx = await dlmmPool.closePosition({
                owner: wallet.publicKey,
                position: position, // LbPosition object dari step 1
              });
              emptyCloseOk = true;
            }
          } catch { /* lanjut ke coba 3 */ }
        }

        // Coba 3: removeLiquidity shouldClaimAndClose=true dengan range penuh
        if (!emptyCloseOk) {
          try {
            removeLiqTx = await dlmmPool.removeLiquidity({
              position: positionPubkey,
              user: wallet.publicKey,
              fromBinId,
              toBinId,
              bps: new BN(10000),
              shouldClaimAndClose: true,
            });
            emptyCloseOk = true;
          } catch { /* lanjut ke purge */ }
        }

        if (!emptyCloseOk) {
          await updatePositionLifecycle(positionAddress, 'manual_review');
          await enqueueReconcileIssue({
            issueType: 'EMPTY_POSITION_CLOSE_FAILED',
            entityId: positionAddress,
            payload: { poolAddress, positionAddress, pnlData },
            notes: 'All close methods failed on empty position. Keep tracking and reconcile manually.',
          });
          throw new Error('Posisi kosong gagal ditutup oleh semua metode. Lifecycle diubah ke manual_review untuk rekonsiliasi.');
        }
      }

      // ── 5. Kirim & konfirmasi setiap TX ─────────────────────
      const txList = Array.isArray(removeLiqTx) ? removeLiqTx : [removeLiqTx];
      const txHashes = [];

      for (const tx of txList) {
        await sendAndConfirmTx(tx, txHashes);
      }

      // ── 6. Verifikasi + cleanup ───────────────────────────────
      //
      // removeLiquidity(shouldClaimAndClose:true) menyertakan closePositionIfEmpty per-chunk.
      // closePositionIfEmpty = NO-OP jika posisi masih ada pending fee/reward → account tetap ada.
      //
      // Strategy cleanup bertingkat:
      //   6a. Tunggu 10s (propagasi Solana bisa 2-8s)
      //   6b. getAccountInfo → null = sudah closed ✓
      //   6c. Account masih ada → re-run removeLiquidity(shouldClaimAndClose:true) dgn state fresh.
      //       SDK membaca on-chain state fresh: jika ada sisa fee/reward → diklaim + closePositionIfEmpty.
      //       Jika SDK throw (activeBins kosong = posisi sudah 0 liq/fee/reward) → step 6d.
      //   6d. Posisi sudah kosong tapi account masih ada → panggil closePositionIfEmpty langsung.
      //   6e. Fallback: closePosition (closePosition2) sebagai last resort.
      //   6f. Re-verify → jika null = done ✓, jika masih ada = retry outer loop.

      await new Promise(r => setTimeout(r, 10000)); // tunggu state propagation

      let stillHasLiquidity = true;
      try {
        const accountInfo = await connection.getAccountInfo(positionPubkey);
        if (accountInfo === null) {
          stillHasLiquidity = false; // ✅ closed
        } else {
          console.log('[closePositionDLMM] Account masih ada setelah removeLiquidity — jalankan cleanup cycle...');
          try {
            const dlmmPool2 = await DLMM.create(connection, poolPubkey);
            const { userPositions: vPos } = await dlmmPool2.getPositionsByUserAndLbPair(wallet.publicKey);
            const livePos = vPos?.find(p => p.publicKey.toString() === positionAddress);

            if (livePos) {
              const pd2 = livePos.positionData;
              let cleanupDone = false;

              // 6c. Re-run removeLiquidity(shouldClaimAndClose:true) — klaim sisa fee/reward + close
              try {
                const cleanupTxs = await dlmmPool2.removeLiquidity({
                  position: positionPubkey,
                  user: wallet.publicKey,
                  fromBinId: pd2.lowerBinId,
                  toBinId: pd2.upperBinId,
                  bps: new BN(10000),
                  shouldClaimAndClose: true,
                });
                const list = Array.isArray(cleanupTxs) ? cleanupTxs : [cleanupTxs];
                for (const ctx of list) await sendAndConfirmTx(ctx, txHashes);
                cleanupDone = true;
                console.log('[closePositionDLMM] 6c: removeLiquidity cleanup OK');
              } catch (e6c) {
                // SDK melempar error jika activeBins kosong (posisi sudah 0 liq+fee+reward)
                // → lanjut ke 6d: closePositionIfEmpty langsung
                console.log('[closePositionDLMM] 6c removeLiquidity gagal:', e6c.message, '— coba closePositionIfEmpty');
              }

              // 6d. Posisi kosong tapi account masih ada → closePositionIfEmpty langsung
              if (!cleanupDone && typeof dlmmPool2.closePositionIfEmpty === 'function') {
                try {
                  const cipeTx = await dlmmPool2.closePositionIfEmpty({
                    owner: wallet.publicKey,
                    position: livePos,
                  });
                  const list = Array.isArray(cipeTx) ? cipeTx : [cipeTx];
                  for (const ctx of list) await sendAndConfirmTx(ctx, txHashes);
                  cleanupDone = true;
                  console.log('[closePositionDLMM] 6d: closePositionIfEmpty OK');
                } catch (e6d) {
                  console.log('[closePositionDLMM] 6d closePositionIfEmpty gagal:', e6d.message, '— coba closePosition');
                }
              }

              // 6e. Last resort: closePosition (closePosition2)
              if (!cleanupDone) {
                try {
                  const closeTx = await dlmmPool2.closePosition({
                    owner: wallet.publicKey,
                    position: livePos,
                  });
                  const list = Array.isArray(closeTx) ? closeTx : [closeTx];
                  for (const ctx of list) await sendAndConfirmTx(ctx, txHashes);
                  console.log('[closePositionDLMM] 6e: closePosition OK');
                } catch (e6e) {
                  console.warn('[closePositionDLMM] 6e closePosition gagal:', e6e.message);
                }
              }

              // 6f. Re-verify
              await new Promise(r => setTimeout(r, 4000));
              const acctInfo2 = await connection.getAccountInfo(positionPubkey);
              if (acctInfo2 === null) {
                stillHasLiquidity = false; // ✅
              }

            } else if (vPos != null) {
              // SDK tidak ketemu posisi tapi account masih ada → RPC inconsistency → retry
              console.warn('[closePositionDLMM] Account exists tapi SDK tidak ketemu posisi — RPC inconsistency, retry');
            }
          } catch (e6) {
            console.warn('[closePositionDLMM] Cleanup cycle error:', e6.message);
          }
        }
      } catch (e) {
        console.warn('[closePositionDLMM] getAccountInfo verify failed:', e.message);
      }

      if (stillHasLiquidity) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 5000 * attempt));
          continue; // retry dengan state terbaru
        }
        // Semua retry habis — keep tracked as manual_review (never purge)
        await updatePositionLifecycle(positionAddress, 'manual_review');
        await enqueueReconcileIssue({
          issueType: 'CLOSE_POSITION_RETRY_EXHAUSTED',
          entityId: positionAddress,
          payload: { poolAddress, positionAddress, pnlData },
          notes: 'Close retries exhausted. Position still appears on-chain. Manual reconcile required.',
        });
        throw new Error(
          'Posisi masih memiliki likuiditas setelah 3 percobaan — ' +
          'lifecycle diubah ke manual_review. Verifikasi manual di Meteora UI diperlukan.'
        );
      }

      // ── 7. Verified closed → update DB ──────────────────────
      await closePositionWithPnl(positionAddress, {
        pnlUsd: pnlData.pnlUsd || 0,
        pnlPct: pnlData.pnlPct || 0,
        feesUsd: pnlData.feeUsd || 0,
        pnlSol: pnlData.pnlSol || 0,
        feesSol: pnlData.feeSol || 0,
        closeReason: pnlData.closeReason || 'closed',
        lifecycleState: pnlData.lifecycleState || 'closed_pending_swap',
      });

      // ── 8. Aegis Zero-Dust Swap ─────────────────────────────
      if (!isDryRun()) {
        try {
          const xBalance = await getTokenBalance(xMint);
          if (xBalance > 0) {
            // Small threshold check: only swap if value is worth the gas (> ~$0.20 approx)
            // But for 0.5 SOL test, we swap everything to keep it clean
            // Logika Irit: Hitung slippage dinamis biar gak rugi price impact
            let slippage = 100; // default 1.0%
            try {
              const snapshot = await getMarketSnapshot(xMint, poolAddress);
              slippage = getConservativeSlippage(snapshot?.price?.volatility24h || 0);
            } catch { /* pakai default 1% jika gagal fetch snapshot */ }

            console.log(`[closePositionDLMM] Auto-Swap: Converting ${xBalance} Token X back to SOL (Slippage: ${slippage/100}%)...`);
            const swapResult = await swapToSol(xMint, Math.floor(xBalance * Math.pow(10, xMeta.decimals)), slippage);
            if (swapResult) {
              const connection = getConnection();
              const wallet = getWallet();
              const { VersionedTransaction } = await import('@solana/web3.js');
              const swapTx = VersionedTransaction.deserialize(Buffer.from(swapResult.swapTransaction, 'base64'));
              swapTx.sign([wallet]);
              const hash = await connection.sendRawTransaction(swapTx.serialize(), { skipPreflight: true });
              await pollTxConfirm(connection, hash, 45000);
              console.log(`[closePositionDLMM] Auto-Swap Success: ${hash}`);
              txHashes.push(hash);
            }
          }
        } catch (eSwap) {
          console.warn('[closePositionDLMM] Auto-Swap back to SOL failed:', eSwap.message);
        }
      }

      return { success: true, txHashes };

    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      // Backoff sebelum attempt berikutnya
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
}

// ─── Claim Fees ──────────────────────────────────────────────────

export async function claimFees(poolAddress, positionAddress) {
  if (isDryRun()) {
    console.log(`[DRY RUN] claimFees skipped: pool=${poolAddress} pos=${positionAddress}`);
    return { dryRun: true, poolAddress, positionAddress };
  }
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool = await DLMM.create(connection, poolPubkey);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const position = userPositions?.find(p => p.publicKey.toString() === positionAddress);
  if (!position) {
    // Verify via getAccountInfo — getPositionsByUserAndLbPair bisa return empty karena RPC glitch
    const positionPubkey2 = new PublicKey(positionAddress);
    const acct = await connection.getAccountInfo(positionPubkey2).catch(() => null);
    if (acct === null) {
      throw new Error('Posisi tidak ditemukan — sudah ditutup atau tidak valid');
    }
    throw new Error('Posisi ada on-chain tapi tidak ditemukan via SDK (RPC glitch) — coba lagi');
  }

  let claimTx;
  try {
    claimTx = await dlmmPool.claimAllRewards({ owner: wallet.publicKey, positions: [position] });
  } catch {
    // claimAllRewards gagal → fallback ke claimAllRewardsByPosition (single position)
    // JANGAN gunakan claimFee — method itu tidak ada di SDK ini
    claimTx = await dlmmPool.claimAllRewardsByPosition({ owner: wallet.publicKey, position });
  }

  const txList = Array.isArray(claimTx) ? claimTx : [claimTx];
  const txHashes = [];

  for (const tx of txList) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const isClaimVersioned = tx instanceof VersionedTransaction;

    if (isClaimVersioned) {
      tx.message.recentBlockhash = blockhash;
    } else {
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
    }

    // Priority fee — safe for both types (Versioned: early return noop)
    injectPriorityFee(tx, { units: 200_000, microLamports: 200_000 });

    if (isClaimVersioned) {
      tx.sign([wallet]);
    } else {
      tx.sign(wallet);
    }

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    await pollTxConfirm(connection, txHash, 60000);
    txHashes.push(txHash);
  }

  return { success: true, txHashes };
}

// ─── Top Pools ───────────────────────────────────────────────────

export async function getTopPools(limit = 5) {
  const res = await fetchWithTimeout(
    `https://dlmm.datapi.meteora.ag/pools?limit=${Math.max(limit * 2, 20)}&sort_by=fee_24h:desc`,
    { headers: { Accept: 'application/json' } },
    10000
  );
  if (!res.ok) throw new Error(`Meteora API error: ${res.status}`);
  const data = await res.json();

  const pools = (data.data || [])
    .filter(pool => pool.token_y?.address === WSOL_MINT);

  return pools.slice(0, limit).map(pool => {
    const fees24h = pool.fees?.['24h'] || 0;
    const apr24h = (pool.fee_tvl_ratio?.['24h'] || 0) * 100;
    const tvl = pool.tvl || 0;
    const vol24h = pool.volume?.['24h'] || 0;

    return {
      address: pool.address,
      name: pool.name || 'Unknown',
      apr: apr24h.toFixed(2) + '%',
      feeApr: apr24h.toFixed(2) + '%',
      tvl,
      tvlStr: tvl >= 1e6 ? '$' + (tvl / 1e6).toFixed(2) + 'M' : '$' + (tvl / 1e3).toFixed(1) + 'K',
      fees24h: fees24h >= 1e3 ? '$' + (fees24h / 1e3).toFixed(2) + 'K' : '$' + fees24h.toFixed(2),
      volume24h: vol24h >= 1e6 ? '$' + (vol24h / 1e6).toFixed(2) + 'M' : '$' + (vol24h / 1e3).toFixed(1) + 'K',
      binStep: pool.pool_config?.bin_step,
      tokenX: pool.token_x?.address,
      tokenY: pool.token_y?.address,
      liquidityRaw: tvl,
      fees24hRaw: fees24h,
      volume24hRaw: vol24h,
      feeApr: parseFloat(apr24h.toFixed(2)),
    };
  });
}
