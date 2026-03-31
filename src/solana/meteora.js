import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { savePosition, closePositionWithPnl } from '../db/database.js';
import { fetchWithTimeout, withRetry } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';

// ─── Safe BN conversion — avoids floating point errors ──────────

function toBN(amount, decimals) {
  const factor = Math.pow(10, decimals);
  const rounded = Math.floor(amount * factor);
  return new BN(rounded.toString());
}

// ─── TX confirmation via polling ─────────────────────────────────
// Lebih reliable dari confirmTransaction (websocket-based) yang sering
// timeout meski TX sudah landing di chain.

async function pollTxConfirm(connection, txHash, maxWaitMs = 90000) {
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
    // Network/SDK error — return null to signal fetch failure (not manual close)
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
  const isSingleSideSOL = tokenXAmount === 0;
  const binsBelow = Math.max(2, Math.floor((priceRangePercent / 100) / (binStep / 10000)));

  let minBinId, maxBinId;
  if (isSingleSideSOL) {
    minBinId = activeBin.binId - binsBelow;
    maxBinId = activeBin.binId;
  } else {
    minBinId = activeBin.binId - binsBelow;
    maxBinId = activeBin.binId + binsBelow;
  }

  const totalXAmount = toBN(tokenXAmount, xDecimals);
  const totalYAmount = toBN(tokenYAmount, yDecimals);

  const newPosition = Keypair.generate();

  const txs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user:           wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy:       { maxBinId, minBinId, strategyType: 0 },
  });

  const txList = Array.isArray(txs) ? txs : [txs];
  const txHashes = [];

  for (const tx of txList) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet, newPosition);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });

    await pollTxConfirm(connection, txHash, 90000);
    txHashes.push(txHash);
  }

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

  savePosition({
    pool_address:     poolAddress,
    position_address: newPosition.publicKey.toString(),
    token_x:          xMint,
    token_y:          yMint,
    token_x_amount:   tokenXAmount,
    token_y_amount:   tokenYAmount,
    deployed_sol:     tokenYAmount,
    entry_price:      rawActivePrice,
    deployed_usd:     parseFloat((tokenYAmount * solPriceUsd).toFixed(2)),
    strategy_used:    strategyName,
  });

  return {
    success:            true,
    txHash:             txHashes[0],
    txHashes,
    positionAddress:    newPosition.publicKey.toString(),
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

      // ── 2. Sudah tidak ada di chain → mark closed, done ─────
      if (!position) {
        closePositionWithPnl(positionAddress, {
          pnlUsd:    pnlData.pnlUsd   || 0,
          pnlPct:    pnlData.pnlPct   || 0,
          feesUsd:   pnlData.feeUsd   || 0,
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
        // ── 4b. Position tanpa bin (kosong) → coba close account
        try {
          removeLiqTx = await dlmmPool.removeLiquidity({
            position:               positionPubkey,
            user:                   wallet.publicKey,
            binIds:                 [],
            liquiditiesBpsToRemove: [],
            shouldClaimAndClose:    true,
          });
        } catch {
          throw new Error(
            'Posisi kosong tanpa bin aktif — tidak bisa close otomatis. ' +
            'Silakan close manual via Meteora UI.'
          );
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
        tx.sign(wallet);

        // skipPreflight:true — simulation sering reject TX valid karena state stale.
        // Kita sudah verify posisi exist baris di atas, jadi TX ini valid.
        const txHash = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries:    2,
        });

        await pollTxConfirm(connection, txHash, 90000);
        txHashes.push(txHash);
      }

      // ── 6. Verifikasi on-chain: posisi benar-benar hilang ───
      await new Promise(r => setTimeout(r, 2500)); // beri waktu state propagate
      const dlmmPool2 = await DLMM.create(connection, poolPubkey);
      const { userPositions: verifyPos } = await dlmmPool2.getPositionsByUserAndLbPair(wallet.publicKey);
      const stillExists = verifyPos?.find(p => p.publicKey.toString() === positionAddress);

      // Cek apakah masih ada likuiditas tersisa
      const stillHasLiquidity = stillExists
        ? (Number(stillExists.positionData.totalXAmount?.toString() || '0') +
           Number(stillExists.positionData.totalYAmount?.toString() || '0')) > 0
        : false;

      if (stillHasLiquidity) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 4000 * attempt));
          continue; // retry dengan state terbaru
        }
        throw new Error(
          'Posisi masih memiliki likuiditas setelah close — ' +
          'close manual via Meteora UI diperlukan.'
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
    tx.sign(wallet);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 2,
    });

    await pollTxConfirm(connection, txHash, 90000);
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
