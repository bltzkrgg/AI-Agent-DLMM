import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { savePosition, closePosition, closePositionWithPnl } from '../db/database.js';
import { fetchWithTimeout, withRetry, parseTvl } from '../utils/safeJson.js';

// ─── Safe BN conversion — avoids floating point errors ──────────

function toBN(amount, decimals) {
  // Use string conversion to avoid floating point issues
  const factor = Math.pow(10, decimals);
  const rounded = Math.floor(amount * factor);
  return new BN(rounded.toString());
}

// ─── Pool Info ───────────────────────────────────────────────────

export async function getPoolInfo(poolAddress) {
  return withRetry(async () => {
    const connection = getConnection();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const activeBin = await dlmmPool.getActiveBin();
    const binStep = dlmmPool.lbPair.binStep;

    return {
      address: poolAddress,
      tokenX: dlmmPool.tokenX.publicKey.toString(),
      tokenY: dlmmPool.tokenY.publicKey.toString(),
      tokenXSymbol: dlmmPool.tokenX.symbol || 'Token X',
      tokenYSymbol: dlmmPool.tokenY.symbol || 'Token Y',
      tokenXDecimals: dlmmPool.tokenX.decimal || 9,
      tokenYDecimals: dlmmPool.tokenY.decimal || 6,
      activePrice: parseFloat(activeBin.pricePerToken) || 0,
      activeBinId: activeBin.binId,
      binStep,
      feeRate: (binStep / 10000).toFixed(2) + '%',
    };
  });
}

// ─── Position Info ───────────────────────────────────────────────

export async function getPositionInfo(poolAddress) {
  return withRetry(async () => {
    const connection = getConnection();
    const wallet = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    if (!userPositions || userPositions.length === 0) return null;

    const activeBin = await dlmmPool.getActiveBin();

    // Fetch PnL from API (best-effort, with timeout)
    // API lama dlmm-api.meteora.ag sudah 404 — PnL dihitung dari on-chain data
    const pnlMap = {};

    return userPositions.map(pos => {
      const pd = pos.positionData;
      const lowerBinId = pd.lowerBinId;
      const upperBinId = pd.upperBinId;
      const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId;
      const posAddr = pos.publicKey.toString();
      const pnl = pnlMap[posAddr] || {};

      // Fee amounts — these are fees, NOT pnl
      const feeX = pd.feeX ? pd.feeX.toString() : '0';
      const feeY = pd.feeY ? pd.feeY.toString() : '0';

      // PnL from API (real profit/loss on principal)
      const pnlUsd = parseFloat(pnl.total_pnl_usd ?? pnl.pnl ?? pnl.net_pnl_usd ?? 0);
      const pnlPct = parseFloat(pnl.pnl_pct ?? pnl.pnl_percentage ?? 0);

      // Fee USD (separate from pnl)
      const feeUsd = parseFloat(pnl.total_fee_usd ?? pnl.fee_usd ?? 0);
      const feePctOfDeployed = parseFloat(pnl.fee_pct_of_deployed ?? pnl.fee_pct ?? 0);

      // Extended PnL fields — position yield, fee accrual, deposit/current value
      const positionYield   = parseFloat(pnl.yield_pct ?? pnl.apr ?? feePctOfDeployed);
      const feeAccrualUsd   = parseFloat(pnl.fee_accrual_usd ?? pnl.accrued_fee_usd ?? feeUsd);
      const depositedValueUsd = parseFloat(pnl.deposited_value_usd ?? pnl.initial_deposit_usd ?? 0);
      const currentValueUsd   = parseFloat(pnl.current_value_usd ?? 0);

      return {
        address: posAddr,
        tokenX: pd.totalXAmount?.toString() || '0',
        tokenY: pd.totalYAmount?.toString() || '0',
        feeX,
        feeY,
        feeUsd,
        feePctOfDeployed,
        pnlUsd,             // actual profit/loss on principal
        pnlPct,             // actual pnl percentage
        positionYield,      // yield/APR percentage
        feeAccrualUsd,      // accrued fees in USD
        depositedValueUsd,  // initial deposit value
        currentValueUsd,    // current position value
        lowerBinId,
        upperBinId,
        activeBinId: activeBin.binId,
        inRange,
        currentPrice: parseFloat(activeBin.pricePerToken) || 0,
      };
    });
  });
}

// ─── SOL price helper — untuk deployed_usd yang akurat ──────────

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
  const activeBinPrice = parseFloat(activeBin.pricePerToken) || 0;
  const binStep = dlmmPool.lbPair.binStep;

  // Validasi: bin step maksimum 250
  if (binStep > 250) {
    throw new Error(`Pool ditolak: bin step ${binStep} melebihi batas maksimum 250. Gunakan pool dengan bin step ≤ 250.`);
  }

  // Safe bin range calculation — minimum 2 bins each side
  const binsOnEachSide = Math.max(2, Math.floor((priceRangePercent / 100) / (binStep / 10000)));
  const minBinId = activeBin.binId - binsOnEachSide;
  const maxBinId = activeBin.binId + binsOnEachSide;

  const xDecimals = dlmmPool.tokenX.decimal || 9;
  const yDecimals = dlmmPool.tokenY.decimal || 6;

  // Safe BN conversion
  const totalXAmount = toBN(tokenXAmount, xDecimals);
  const totalYAmount = toBN(tokenYAmount, yDecimals);

  const newPosition = Keypair.generate();

  const txs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { maxBinId, minBinId, strategyType: 0 },
  });

  const txList = Array.isArray(txs) ? txs : [txs];
  const txHashes = [];

  for (const tx of txList) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet, newPosition);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // confirmTransaction with timeout
    const confirmation = await Promise.race([
      connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Confirm timeout')), 60000)),
    ]);

    if (confirmation?.value?.err) throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
    txHashes.push(txHash);
  }

  // Price range estimation — binStep per bin in percent
  const binStepPct = binStep / 10000;
  const lowerPrice = activeBinPrice * Math.pow(1 + binStepPct, minBinId - activeBin.binId);
  const upperPrice = activeBinPrice * Math.pow(1 + binStepPct, maxBinId - activeBin.binId);
  const feeRatePct = (binStep / 10000) * 100;

  const tokenXSymbol = dlmmPool.tokenX.symbol || 'X';
  const tokenYSymbol = dlmmPool.tokenY.symbol || 'Y';

  const solPriceUsd = await getSolPriceUsd().catch(() => 150);
  savePosition({
    pool_address: poolAddress,
    position_address: newPosition.publicKey.toString(),
    token_x: dlmmPool.tokenX.publicKey.toString(),
    token_y: dlmmPool.tokenY.publicKey.toString(),
    token_x_amount: tokenXAmount,
    token_y_amount: tokenYAmount,
    entry_price: activeBinPrice,
    deployed_usd: parseFloat((tokenYAmount * solPriceUsd).toFixed(2)),
    strategy_used: strategyName,
  });

  return {
    success: true,
    txHash: txHashes[0],
    txHashes,
    positionAddress: newPosition.publicKey.toString(),
    entryPrice: activeBinPrice,
    lowerPrice: parseFloat(lowerPrice.toFixed(8)),
    upperPrice: parseFloat(upperPrice.toFixed(8)),
    priceRangePct: priceRangePercent,
    binRange: { min: minBinId, max: maxBinId, active: activeBin.binId },
    binStep,
    feeRatePct: parseFloat(feeRatePct.toFixed(4)),
    tokenXAmount: tokenXAmount,
    tokenYAmount: tokenYAmount,
    tokenXSymbol,
    tokenYSymbol,
    tokenXMint: dlmmPool.tokenX.publicKey.toString(),
    tokenYMint: dlmmPool.tokenY.publicKey.toString(),
  };
}

// ─── Close Position ──────────────────────────────────────────────

export async function closePositionDLMM(poolAddress, positionAddress, pnlData = {}) {
  return withRetry(async () => {
    const connection = getConnection();
    const wallet = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const positionPubkey = new PublicKey(positionAddress);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p => p.publicKey.toString() === positionAddress);
    if (!position) throw new Error('Posisi tidak ditemukan di pool ini');

    const binIdsToRemove = position.positionData.positionBinData.map(b => b.binId);
    if (binIdsToRemove.length === 0) throw new Error('Tidak ada bin data pada posisi');

    // Coba shouldClaimAndClose:true (claim fees + close dalam 1 TX)
    // Fallback ke false jika gagal (misal: posisi tidak ada unclaimed fee)
    let removeLiqTx;
    try {
      removeLiqTx = await dlmmPool.removeLiquidity({
        position: positionPubkey,
        user: wallet.publicKey,
        binIds: binIdsToRemove,
        liquiditiesBpsToRemove: binIdsToRemove.map(() => new BN(10000)),
        shouldClaimAndClose: true,
      });
    } catch {
      removeLiqTx = await dlmmPool.removeLiquidity({
        position: positionPubkey,
        user: wallet.publicKey,
        binIds: binIdsToRemove,
        liquiditiesBpsToRemove: binIdsToRemove.map(() => new BN(10000)),
        shouldClaimAndClose: false,
      });
    }

    const txs = Array.isArray(removeLiqTx) ? removeLiqTx : [removeLiqTx];
    const txHashes = [];

    for (const tx of txs) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);

      const txHash = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      const confirmation = await Promise.race([
        connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Confirm timeout')), 60000)),
      ]);

      if (confirmation?.value?.err) throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
      txHashes.push(txHash);
    }

    closePositionWithPnl(positionAddress, {
      pnlUsd: pnlData.pnlUsd || 0,
      pnlPct: pnlData.pnlPct || 0,
      feesUsd: pnlData.feeUsd || 0,
      closeReason: pnlData.closeReason || 'manual',
    });

    return { success: true, txHashes };
  }, 2, 3000); // retry 2x dengan jeda 3 detik
}

// ─── Claim Fees ──────────────────────────────────────────────────

export async function claimFees(poolAddress, positionAddress) {
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool = await DLMM.create(connection, poolPubkey);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const position = userPositions.find(p => p.publicKey.toString() === positionAddress);
  if (!position) throw new Error('Posisi tidak ditemukan');

  let claimTx;
  try {
    claimTx = await dlmmPool.claimAllRewards({ owner: wallet.publicKey, positions: [position] });
  } catch {
    claimTx = await dlmmPool.claimFee({ owner: wallet.publicKey, position: position.publicKey });
  }

  const txs = Array.isArray(claimTx) ? claimTx : [claimTx];
  const txHashes = [];

  for (const tx of txs) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    const txHash = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await Promise.race([
      connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Confirm timeout')), 60000)),
    ]);
    txHashes.push(txHash);
  }

  return { success: true, txHashes };
}

// ─── Top Pools ───────────────────────────────────────────────────

export async function getTopPools(limit = 5) {
  // API baru: https://dlmm.datapi.meteora.ag/pools
  // Sort by apr desc (fee/tvl ratio 24h = apr field)
  const res = await fetchWithTimeout(
    `https://dlmm.datapi.meteora.ag/pools?limit=${Math.max(limit * 2, 20)}&sort_by=fee_24h:desc`,
    { headers: { Accept: 'application/json' } },
    10000
  );
  if (!res.ok) throw new Error(`Meteora API error: ${res.status}`);
  const data = await res.json();

  const pools = data.data || [];
  return pools.slice(0, limit).map(pool => {
    const fees24h  = pool.fees?.['24h'] || 0;
    const apr24h   = (pool.fee_tvl_ratio?.['24h'] || 0) * 100;
    const tvl      = pool.tvl || 0;
    const vol24h   = pool.volume?.['24h'] || 0;

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
      // Raw numeric values untuk Darwinian scoring
      liquidityRaw: tvl,
      fees24hRaw:   fees24h,
      volume24hRaw: vol24h,
    };
  });
}
