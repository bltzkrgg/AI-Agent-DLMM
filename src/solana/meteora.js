import DLMM, { chunkBinRange } from '@meteora-ag/dlmm';
import { PublicKey, Keypair, Transaction, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { savePosition, closePositionWithPnl } from '../db/database.js';
import { fetchWithTimeout, withRetry } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { isDryRun } from '../config.js';
import { getWalletPositions as getLPAgentPositions, isLPAgentEnabled } from '../market/lpAgent.js';

const METEORA_DLMM_API = 'https://dlmm-api.meteora.ag';

// Strip existing ComputeBudget instructions then inject fresh ones.
// Prevents "duplicate instruction" error when SDK already includes ComputeBudget.
function injectPriorityFee(tx, { units = 400_000, microLamports = 200_000 } = {}) {
  if (tx instanceof VersionedTransaction) return;
  const CB = ComputeBudgetProgram.programId.toString();
  tx.instructions = tx.instructions.filter(ix => ix.programId.toString() !== CB);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  );
}

// ─── Safe BN conversion — avoids floating point errors ──────────

function toBN(amount, decimals) {
  const factor = Math.pow(10, decimals);
  const rounded = Math.floor(amount * factor);
  return new BN(rounded.toString());
}

// ─── TX confirmation via polling ─────────────────────────────────
// Lebih reliable dari confirmTransaction (websocket-based) yang sering
// timeout meski TX sudah landing di chain.

async function pollTxConfirm(connection, txHash, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: false });
      const val = status?.value;
      if (val?.err) throw new Error(`TX gagal on-chain: ${JSON.stringify(val.err)}`);
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

    return {
      address:        poolAddress,
      tokenX:         xMint,
      tokenY:         yMint,
      tokenXSymbol:   xMeta.symbol,
      tokenYSymbol:   yMeta.symbol,
      tokenXDecimals: xMeta.decimals,
      tokenYDecimals: yMeta.decimals,
      activePrice:    rawPrice,           // SDK raw (SOL/token for SOL pairs)
      displayPrice:   parseFloat(displayPrice.toFixed(6)),
      priceUnit,
      activeBinId:    activeBin.binId,
      binStep,
      feeRate:        (binStep / 100).toFixed(2) + '%',  // binStep=1 → 0.01% base fee
      isSOLPair,
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
    const wallet  = getWallet();
    const owner   = wallet.publicKey.toString();

    // Primary: user+pair filter
    const url = `${METEORA_DLMM_API}/position/list_by_user_and_pair?user=${owner}&pair=${poolAddress}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) return null;

    const raw  = await res.json();
    const rows = Array.isArray(raw) ? raw : (raw.userPositions ?? raw.positions ?? raw.data ?? []);
    if (!rows.length) return [];

    return rows.map(p => {
      const xAmt      = parseFloat(p.totalXAmount   ?? p.total_x_amount   ?? 0);
      const yAmt      = parseFloat(p.totalYAmount   ?? p.total_y_amount   ?? 0);
      const feeX      = parseFloat(p.feeX           ?? p.fee_x            ?? p.unclaimed_fee_x ?? 0);
      const feeY      = parseFloat(p.feeY           ?? p.fee_y            ?? p.unclaimed_fee_y ?? 0);
      const price     = parseFloat(p.currentPrice   ?? p.active_bin_price ?? 0);
      const valSol    = yAmt + feeY + (xAmt + feeX) * price;
      const feeSol    = feeY + feeX * price;

      return {
        address:          p.address ?? p.pubkey ?? p.positionAddress ?? '',
        currentValueSol:  parseFloat(valSol.toFixed(9)),
        feeCollectedSol:  parseFloat(feeSol.toFixed(9)),
        inRange:          p.inRange          ?? p.is_in_range   ?? true,
        lowerBinId:       p.lowerBinId       ?? p.lower_bin_id  ?? 0,
        upperBinId:       p.upperBinId       ?? p.upper_bin_id  ?? 0,
        activeBinId:      p.activeBinId      ?? p.active_bin_id ?? 0,
        binStep:          p.binStep          ?? p.bin_step      ?? 0,
        currentPrice:     price,
        fromAPI:          true,  // signals this is from REST API, not on-chain
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

// ─── Position Info ───────────────────────────────────────────────
// Returns [] (not null) when wallet has no open positions in this pool.
// null is reserved for network errors so callers can distinguish:
//   [] → no positions (manual close may have happened)
//   null → fetch error (network issue, don't mark as manual close)

export async function getPositionInfo(poolAddress) {
  try {
    return await withRetry(async () => {
      const connection = getConnection();
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
        const lowerBinId  = pd.lowerBinId;
        const upperBinId  = pd.upperBinId;
        const activeBinId = activeBin.binId;
        const inRange     = activeBinId >= lowerBinId && activeBinId <= upperBinId;
        const posAddr     = pos.publicKey.toString();

        // Raw → human-readable amounts (using resolved decimals)
        const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDecimals);
        const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDecimals);
        const feeXUi   = Number(pd.feeX?.toString() || '0')         / Math.pow(10, xDecimals);
        const feeYUi   = Number(pd.feeY?.toString() || '0')         / Math.pow(10, yDecimals);

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
          address:      posAddr,
          // Raw on-chain amounts (string, for DB compat)
          tokenX:       pd.totalXAmount?.toString() || '0',
          tokenY:       pd.totalYAmount?.toString() || '0',
          feeX:         pd.feeX?.toString() || '0',
          feeY:         pd.feeY?.toString() || '0',
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
          tokenXMint:   xMint,
          tokenYMint:   yMint,
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
  } catch {
    // Tier 2: Meteora REST API fallback
    console.warn(`[meteora] SDK failed for ${poolAddress?.slice(0,8)}, trying Meteora API`);
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

async function getSolPriceUsd() {
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

export async function openPosition(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent = 5, strategyName = null) {
  if (isDryRun()) {
    console.log(`[DRY RUN] openPosition skipped: pool=${poolAddress} tokenX=${tokenXAmount} tokenY=${tokenYAmount}`);
    return { dryRun: true, poolAddress, tokenXAmount, tokenYAmount, priceRangePercent };
  }
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool = await DLMM.create(connection, poolPubkey);

  const activeBin = await dlmmPool.getActiveBin();
  const rawActivePrice = parseFloat(activeBin.pricePerToken) || 0;
  const binStep = dlmmPool.lbPair.binStep;

  if (binStep > 250) {
    throw new Error(`Pool ditolak: bin step ${binStep} melebihi batas maksimum 250.`);
  }

  const xMint = dlmmPool.tokenX.publicKey.toString();
  const yMint = dlmmPool.tokenY.publicKey.toString();
  const [xMeta, yMeta] = await resolveTokens([xMint, yMint]);
  const xDecimals = xMeta.decimals;
  const yDecimals = yMeta.decimals;
  const isSOLPair = yMint === WSOL_MINT;

  // ── Bin range calculation ────────────────────────────────────────
  // binsBelow = priceRangePercent * 100 / binStep
  // Meteora on-chain limit = 70 bins per position account.
  // Cap rawBins ke 69 agar selalu 1 position account per deploy (tidak chunking).
  // Ini memastikan 1 deploy_position = 1 position address di on-chain.
  const isSingleSideSOL = tokenXAmount === 0;
  const rawBins  = Math.min(69, Math.max(2, Math.floor((priceRangePercent / 100) / (binStep / 10000))));
  const rangeMin = activeBin.binId - rawBins;
  const rangeMax = activeBin.binId; // single-side SOL: active bin is the ceiling
  const totalBins = rawBins + 1;

  // chunkBinRange — dengan rawBins ≤ 69, selalu menghasilkan tepat 1 chunk
  const binChunks = chunkBinRange(rangeMin, rangeMax);

  const allPositionKps  = binChunks.map(() => Keypair.generate());
  const allTxHashes     = [];
  const deployedPositions = [];

  for (let ci = 0; ci < binChunks.length; ci++) {
    const chunk     = binChunks[ci];
    const chunkBins = chunk.upperBinId - chunk.lowerBinId + 1;

    // Proportional SOL allocation — more bins → more liquidity
    const chunkYSol  = tokenYAmount * (chunkBins / totalBins);
    const chunkTotalX = new BN(0);
    const chunkTotalY = toBN(chunkYSol, yDecimals);

    const posKp = allPositionKps[ci];

    const txs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKp.publicKey,
      user:           wallet.publicKey,
      totalXAmount:   chunkTotalX,
      totalYAmount:   chunkTotalY,
      strategy:       { maxBinId: chunk.upperBinId, minBinId: chunk.lowerBinId, strategyType: 0 },
    });

    const txList = Array.isArray(txs) ? txs : [txs];
    for (const tx of txList) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // Priority fee — strip existing ComputeBudget lalu inject ulang (cegah duplicate)
      injectPriorityFee(tx, { units: 400_000, microLamports: 200_000 });

      tx.sign(wallet, posKp);

      const txHash = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      await pollTxConfirm(connection, txHash, 60000);
      allTxHashes.push(txHash);
    }

    deployedPositions.push({
      address:   posKp.publicKey.toString(),
      minBinId:  chunk.lowerBinId,
      maxBinId:  chunk.upperBinId,
      binCount:  chunkBins,
      yAmountSol: parseFloat(chunkYSol.toFixed(6)),
    });
  }

  const minBinId = rangeMin;
  const maxBinId = rangeMax;

  // ── Price range display ──────────────────────────────────────────
  const lowerRaw = binPrice(rawActivePrice, binStep, minBinId - activeBin.binId);
  const upperRaw = binPrice(rawActivePrice, binStep, maxBinId - activeBin.binId);

  // For SOL pairs: invert & swap so displayLower < displayUpper
  const displayLowerPrice = isSOLPair
    ? (upperRaw > 0 ? parseFloat((1 / upperRaw).toFixed(4)) : 0)
    : parseFloat(lowerRaw.toFixed(8));
  const displayUpperPrice = isSOLPair
    ? (lowerRaw > 0 ? parseFloat((1 / lowerRaw).toFixed(4)) : 0)
    : parseFloat(upperRaw.toFixed(8));
  const displayCurrentPrice = parseFloat(toDisplayPrice(rawActivePrice, isSOLPair).toFixed(4));
  const priceUnit = isSOLPair ? `${xMeta.symbol}/SOL` : `${yMeta.symbol}/${xMeta.symbol}`;

  const solPriceUsd = await getSolPriceUsd().catch(() => 150);

  // Save each position chunk to DB — retry once on failure to guard against
  // transient DB write errors after TX has already landed on-chain.
  for (const pos of deployedPositions) {
    const record = {
      pool_address:     poolAddress,
      position_address: pos.address,
      token_x:          xMint,
      token_y:          yMint,
      token_x_amount:   tokenXAmount,
      token_y_amount:   pos.yAmountSol,
      deployed_sol:     pos.yAmountSol,
      entry_price:      rawActivePrice,
      deployed_usd:     parseFloat((pos.yAmountSol * solPriceUsd).toFixed(2)),
      strategy_used:    strategyName,
      token_x_symbol:   xMeta.symbol,
    };
    try {
      savePosition(record);
    } catch (dbErr) {
      console.warn(`[openPosition] DB write failed (${dbErr.message}), retrying in 1s…`);
      await new Promise(r => setTimeout(r, 1000));
      try { savePosition(record); }
      catch (e2) { console.error(`[openPosition] DB write retry failed: ${e2.message}`); }
    }
  }

  return {
    success:            true,
    txHash:             allTxHashes[0],
    txHashes:           allTxHashes,
    positionAddress:    deployedPositions[0].address,     // backward compat
    positionAddresses:  deployedPositions.map(p => p.address),
    positionCount:      deployedPositions.length,
    positions:          deployedPositions,
    // Human-readable prices
    entryPrice:         displayCurrentPrice,
    lowerPrice:         displayLowerPrice,
    upperPrice:         displayUpperPrice,
    priceUnit,
    priceRangePct:      priceRangePercent,
    binRange:           { min: minBinId, max: maxBinId, active: activeBin.binId },
    binStep,
    feeRatePct:         parseFloat((binStep / 100).toFixed(4)),
    tokenXAmount,
    tokenYAmount,
    tokenXSymbol:       xMeta.symbol,
    tokenYSymbol:       yMeta.symbol,
    tokenXMint:         xMint,
    tokenYMint:         yMint,
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

export async function closePositionDLMM(poolAddress, positionAddress, pnlData = {}) {
  if (isDryRun()) {
    console.log(`[DRY RUN] closePositionDLMM skipped: pool=${poolAddress} pos=${positionAddress}`);
    return { dryRun: true, poolAddress, positionAddress, pnlData };
  }
  const connection = getConnection();
  const wallet     = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // ── 1. Fresh pool + fresh state per attempt ──────────────
      const dlmmPool      = await DLMM.create(connection, poolPubkey);
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
        closePositionWithPnl(positionAddress, {
          pnlUsd:      pnlData.pnlUsd   || 0,
          pnlPct:      pnlData.pnlPct   || 0,
          feesUsd:     pnlData.feeUsd   || 0,
          closeReason: pnlData.closeReason || 'closed',
        });
        return { success: true, txHashes: [], alreadyClosed: true };
      }

      const pd = position.positionData;
      const binIdsToRemove = pd.positionBinData?.map(b => b.binId) ?? [];

      // ── 3. Tentukan shouldClaimAndClose dari fee aktual ──────
      const feeXRaw = Number(pd.feeX?.toString() || '0');
      const feeYRaw = Number(pd.feeY?.toString() || '0');
      const hasFees = (feeXRaw + feeYRaw) > 0;

      let removeLiqTx;

      if (binIdsToRemove.length > 0) {
        // ── 4a. Position dengan bin aktif → remove liquidity ────
        if (hasFees) {
          // Coba shouldClaimAndClose:true (claim + close sekaligus)
          try {
            removeLiqTx = await dlmmPool.removeLiquidity({
              position:                  positionPubkey,
              user:                      wallet.publicKey,
              binIds:                    binIdsToRemove,
              liquiditiesBpsToRemove:    binIdsToRemove.map(() => new BN(10000)),
              shouldClaimAndClose:       true,
            });
          } catch {
            // Gagal claim fees → tarik likuiditas saja, fees diklaim terpisah
            removeLiqTx = await dlmmPool.removeLiquidity({
              position:                  positionPubkey,
              user:                      wallet.publicKey,
              binIds:                    binIdsToRemove,
              liquiditiesBpsToRemove:    binIdsToRemove.map(() => new BN(10000)),
              shouldClaimAndClose:       false,
            });
          }
        } else {
          // Tidak ada fee — pakai false langsung, tidak perlu coba true
          removeLiqTx = await dlmmPool.removeLiquidity({
            position:                  positionPubkey,
            user:                      wallet.publicKey,
            binIds:                    binIdsToRemove,
            liquiditiesBpsToRemove:    binIdsToRemove.map(() => new BN(10000)),
            shouldClaimAndClose:       false,
          });
        }
      } else {
        // ── 4b. Position tanpa bin (kosong) → coba beberapa pendekatan ───
        // Bisa terjadi jika: (a) liquidity add TX gagal, (b) posisi sudah partial-close.
        let emptyCloseOk = false;

        // Coba 1: removeLiquidity + shouldClaimAndClose=true (SDK standard)
        try {
          removeLiqTx = await dlmmPool.removeLiquidity({
            position:               positionPubkey,
            user:                   wallet.publicKey,
            binIds:                 [],
            liquiditiesBpsToRemove: [],
            shouldClaimAndClose:    true,
          });
          emptyCloseOk = true;
        } catch { /* lanjut ke coba 2 */ }

        if (!emptyCloseOk) {
          // Coba 2: closePosition SDK (jika tersedia)
          try {
            if (typeof dlmmPool.closePosition === 'function') {
              removeLiqTx = await dlmmPool.closePosition({
                owner:    wallet.publicKey,
                position: positionPubkey,
              });
              emptyCloseOk = true;
            }
          } catch { /* lanjut ke fallback */ }
        }

        if (!emptyCloseOk) {
          // Posisi tidak bisa ditutup via SDK — tandai DB sebagai closed supaya tidak retry terus
          closePositionWithPnl(positionAddress, {
            pnlUsd: pnlData.pnlUsd || 0,
            pnlPct: pnlData.pnlPct || 0,
            feesUsd: pnlData.feeUsd || 0,
            closeReason: 'EMPTY_POSITION_PURGED',
          });
          return { success: true, txHashes: [], emptyPositionPurged: true,
            note: 'Posisi kosong (0 bin aktif) — dihapus dari DB. Jika ada dana tersisa, close manual via Meteora UI.' };
        }
      }

      // ── 5. Kirim & konfirmasi setiap TX ─────────────────────
      const txList = Array.isArray(removeLiqTx) ? removeLiqTx : [removeLiqTx];
      const txHashes = [];

      for (const tx of txList) {
        // Fresh blockhash per TX — critical untuk menghindari expired blockhash
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        // Priority fee — strip existing ComputeBudget lalu inject ulang (cegah duplicate)
        injectPriorityFee(tx, { units: 400_000, microLamports: 200_000 });

        tx.sign(wallet);

        const txHash = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries:    3,
        });

        await pollTxConfirm(connection, txHash, 60000);
        txHashes.push(txHash);
      }

      // ── 6. Verifikasi on-chain: posisi benar-benar hilang ───
      // Tunggu 5 detik — state propagation di Solana bisa >2.5s
      await new Promise(r => setTimeout(r, 5000));
      const dlmmPool2 = await DLMM.create(connection, poolPubkey);
      const { userPositions: verifyPos } = await dlmmPool2.getPositionsByUserAndLbPair(wallet.publicKey);
      const stillExists = verifyPos?.find(p => p.publicKey.toString() === positionAddress);

      // Cek via positionBinData — lebih reliable dari totalXAmount yang bisa include fees
      // Jika 0 bin aktif tersisa → semua likuiditas sudah dicabut
      const activeBins = stillExists?.positionData?.positionBinData?.filter(b =>
        Number(b.positionLiquidityX?.toString() || '0') +
        Number(b.positionLiquidityY?.toString() || '0') > 0
      ) ?? [];
      const stillHasLiquidity = stillExists ? activeBins.length > 0 : false;

      if (stillHasLiquidity) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 5000 * attempt));
          continue; // retry dengan state terbaru
        }
        // Semua retry habis — purge DB supaya bot tidak stuck loop selamanya
        closePositionWithPnl(positionAddress, {
          pnlUsd: pnlData.pnlUsd || 0,
          pnlPct: pnlData.pnlPct || 0,
          feesUsd: pnlData.feeUsd || 0,
          closeReason: 'CLOSE_FAILED_PURGED',
        });
        throw new Error(
          'Posisi masih memiliki likuiditas setelah 3 percobaan — ' +
          'DB sudah di-clear. Verifikasi manual di Meteora UI diperlukan.'
        );
      }

      // ── 7. Verified closed → update DB ──────────────────────
      closePositionWithPnl(positionAddress, {
        pnlUsd:      pnlData.pnlUsd   || 0,
        pnlPct:      pnlData.pnlPct   || 0,
        feesUsd:     pnlData.feeUsd   || 0,
        closeReason: pnlData.closeReason || 'closed',
      });

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
  const wallet     = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool   = await DLMM.create(connection, poolPubkey);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const position = userPositions?.find(p => p.publicKey.toString() === positionAddress);
  if (!position) throw new Error('Posisi tidak ditemukan saat claim fees');

  let claimTx;
  try {
    claimTx = await dlmmPool.claimAllRewards({ owner: wallet.publicKey, positions: [position] });
  } catch {
    claimTx = await dlmmPool.claimFee({ owner: wallet.publicKey, position: position.publicKey });
  }

  const txList = Array.isArray(claimTx) ? claimTx : [claimTx];
  const txHashes = [];

  for (const tx of txList) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    // Priority fee — strip existing ComputeBudget lalu inject ulang (cegah duplicate)
    injectPriorityFee(tx, { units: 200_000, microLamports: 200_000 });

    tx.sign(wallet);

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
    const apr24h  = (pool.fee_tvl_ratio?.['24h'] || 0) * 100;
    const tvl     = pool.tvl || 0;
    const vol24h  = pool.volume?.['24h'] || 0;

    return {
      address:      pool.address,
      name:         pool.name || 'Unknown',
      apr:          apr24h.toFixed(2) + '%',
      feeApr:       apr24h.toFixed(2) + '%',
      tvl,
      tvlStr:       tvl >= 1e6 ? '$' + (tvl / 1e6).toFixed(2) + 'M' : '$' + (tvl / 1e3).toFixed(1) + 'K',
      fees24h:      fees24h >= 1e3 ? '$' + (fees24h / 1e3).toFixed(2) + 'K' : '$' + fees24h.toFixed(2),
      volume24h:    vol24h >= 1e6 ? '$' + (vol24h / 1e6).toFixed(2) + 'M' : '$' + (vol24h / 1e3).toFixed(1) + 'K',
      binStep:      pool.pool_config?.bin_step,
      tokenX:       pool.token_x?.address,
      tokenY:       pool.token_y?.address,
      liquidityRaw: tvl,
      fees24hRaw:   fees24h,
      volume24hRaw: vol24h,
    };
  });
}
