import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { savePosition, closePosition, closePositionWithPnl } from '../db/database.js';
import { isDryRun } from '../config.js';
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
    let pnlMap = {};
    try {
      const res = await fetchWithTimeout(
        `https://dlmm-api.meteora.ag/position/${wallet.publicKey.toString()}`,
        {}, 8000
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) data.forEach(p => { pnlMap[p.position] = p; });
      }
    } catch { /* PnL optional */ }

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
      const pnlUsd = parseFloat(pnl.total_pnl_usd || 0);
      const pnlPct = parseFloat(pnl.pnl_pct || 0);

      // Fee USD (separate from pnl)
      const feeUsd = parseFloat(pnl.total_fee_usd || 0);
      const feePctOfDeployed = parseFloat(pnl.fee_pct_of_deployed || 0);

      return {
        address: posAddr,
        tokenX: pd.totalXAmount?.toString() || '0',
        tokenY: pd.totalYAmount?.toString() || '0',
        feeX,
        feeY,
        feeUsd,
        feePctOfDeployed,
        pnlUsd,       // actual profit/loss on principal
        pnlPct,       // actual pnl percentage
        lowerBinId,
        upperBinId,
        activeBinId: activeBin.binId,
        inRange,
        currentPrice: parseFloat(activeBin.pricePerToken) || 0,
      };
    });
  });
}

// ─── Open Position ───────────────────────────────────────────────

export async function openPosition(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent = 5) {
  const connection = getConnection();
  const wallet = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const dlmmPool = await DLMM.create(connection, poolPubkey);

  const activeBin = await dlmmPool.getActiveBin();
  const activeBinPrice = parseFloat(activeBin.pricePerToken) || 0;
  const binStep = dlmmPool.lbPair.binStep;

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

  savePosition({
    pool_address: poolAddress,
    position_address: newPosition.publicKey.toString(),
    token_x: dlmmPool.tokenX.publicKey.toString(),
    token_y: dlmmPool.tokenY.publicKey.toString(),
    entry_price: activeBinPrice,
    deployed_usd: 0, // will be updated by healer when PnL data available
  });

  return {
    success: true,
    txHash: txHashes[0],
    txHashes,
    positionAddress: newPosition.publicKey.toString(),
    entryPrice: activeBinPrice,
    binRange: { min: minBinId, max: maxBinId },
  };
}

// ─── Close Position ──────────────────────────────────────────────

export async function closePositionDLMM(poolAddress, positionAddress, pnlData = {}) {
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

  const removeLiqTx = await dlmmPool.removeLiquidity({
    position: positionPubkey,
    user: wallet.publicKey,
    binIds: binIdsToRemove,
    liquiditiesBpsToRemove: binIdsToRemove.map(() => new BN(10000)),
    shouldClaimAndClose: true,
  });

  const txs = Array.isArray(removeLiqTx) ? removeLiqTx : [removeLiqTx];
  const txHashes = [];

  for (const tx of txs) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const txHash = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });

    const confirmation = await Promise.race([
      connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, 'confirmed'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Confirm timeout')), 60000)),
    ]);

    if (confirmation?.value?.err) throw new Error(`TX failed: ${JSON.stringify(confirmation.value.err)}`);
    txHashes.push(txHash);
  }

  // Save with actual PnL data
  closePositionWithPnl(positionAddress, {
    pnlUsd: pnlData.pnlUsd || 0,
    pnlPct: pnlData.pnlPct || 0,
    feesUsd: pnlData.feeUsd || 0,
    closeReason: pnlData.closeReason || 'manual',
  });

  return { success: true, txHashes };
}

// ─── Claim Fees ──────────────────────────────────────────────────

export async function claimFees(poolAddress, positionAddress) {
  if (isDryRun()) {
    return { dryRun: true, message: `[DRY RUN] Would claim fees from ${positionAddress.slice(0, 8)}...` };
  }

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
  const res = await fetchWithTimeout(
    `https://dlmm-api.meteora.ag/pair/all_with_pagination?limit=${Math.max(limit * 2, 20)}&sort_key=fees&order_by=desc`,
    { headers: { Accept: 'application/json' } },
    10000
  );
  if (!res.ok) throw new Error(`Meteora API error: ${res.status}`);
  const data = await res.json();

  const pools = data.data || data.pairs || data || [];
  return pools.slice(0, limit).map(pool => ({
    address: pool.address,
    name: pool.name || 'Unknown',
    apr: typeof pool.apr === 'number' ? pool.apr.toFixed(2) + '%' : 'N/A',
    feeApr: typeof pool.fee_apr === 'number' ? pool.fee_apr.toFixed(2) + '%' : 'N/A',
    tvl: pool.liquidity || 0,
    tvlStr: pool.liquidity ? '$' + (pool.liquidity / 1e6).toFixed(2) + 'M' : 'N/A',
    volume24h: pool.trade_volume_24h ? '$' + (pool.trade_volume_24h / 1e6).toFixed(2) + 'M' : 'N/A',
    fees24h: pool.fees_24h ? '$' + (pool.fees_24h / 1e3).toFixed(2) + 'K' : 'N/A',
    binStep: pool.bin_step,
    tokenX: pool.mint_x,
    tokenY: pool.mint_y,
  }));
}
