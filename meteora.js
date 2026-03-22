import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { savePosition, closePosition } from '../db/database.js';
import { isDryRun } from '../config.js';

// ─── Pool Info ───────────────────────────────────────────────────

export async function getPoolInfo(poolAddress) {
  try {
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
      activePrice: activeBin.pricePerToken,
      activeBinId: activeBin.binId,
      binStep,
      feeRate: (binStep / 10000).toFixed(2) + '%',
    };
  } catch (e) {
    throw new Error(`Gagal ambil info pool: ${e.message}`);
  }
}

// ─── Position Info ───────────────────────────────────────────────

export async function getPositionInfo(poolAddress) {
  try {
    const connection = getConnection();
    const wallet = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    if (!userPositions || userPositions.length === 0) return null;

    // Fetch PnL data from Meteora API (best-effort)
    let pnlData = {};
    try {
      const res = await fetch(`https://dlmm-api.meteora.ag/position/${wallet.publicKey.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          data.forEach(p => { pnlData[p.position] = p; });
        }
      }
    } catch { /* PnL data optional */ }

    const activeBin = await dlmmPool.getActiveBin();

    const positions = userPositions.map((pos) => {
      const positionData = pos.positionData;
      const lowerBinId = positionData.lowerBinId;
      const upperBinId = positionData.upperBinId;
      const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId;

      // Fee amounts from on-chain data
      const feeX = positionData.feeX ? positionData.feeX.toString() : '0';
      const feeY = positionData.feeY ? positionData.feeY.toString() : '0';

      // PnL enrichment from API (optional)
      const posAddr = pos.publicKey.toString();
      const pnl = pnlData[posAddr] || {};
      const feeUsd = pnl.total_fee_usd || 0;
      const feePctOfDeployed = pnl.fee_pct_of_deployed || 0;

      return {
        address: posAddr,
        tokenX: positionData.totalXAmount?.toString() || '0',
        tokenY: positionData.totalYAmount?.toString() || '0',
        feeX,
        feeY,
        feeUsd,
        feePctOfDeployed,
        lowerBinId,
        upperBinId,
        activeBinId: activeBin.binId,
        inRange,
        currentPrice: activeBin.pricePerToken,
      };
    });

    return positions;
  } catch (e) {
    throw new Error(`Gagal ambil posisi: ${e.message}`);
  }
}

// ─── Open Position ───────────────────────────────────────────────

export async function openPosition(poolAddress, tokenXAmount, tokenYAmount, priceRangePercent = 5) {
  try {
    const connection = getConnection();
    const wallet = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const activeBin = await dlmmPool.getActiveBin();
    const activeBinPrice = activeBin.pricePerToken;
    const binStep = dlmmPool.lbPair.binStep;

    // Calculate bin range — minimum 1 bin each side
    const binsOnEachSide = Math.max(1, Math.floor((priceRangePercent / 100) / (binStep / 10000)));
    const minBinId = activeBin.binId - binsOnEachSide;
    const maxBinId = activeBin.binId + binsOnEachSide;

    // Safe BN conversion — avoid floating point issues
    const xDecimals = dlmmPool.tokenX.decimal || 9;
    const yDecimals = dlmmPool.tokenY.decimal || 6;
    const totalXAmount = new BN(Math.floor(tokenXAmount * Math.pow(10, xDecimals)).toString());
    const totalYAmount = new BN(Math.floor(tokenYAmount * Math.pow(10, yDecimals)).toString());

    const newPosition = Keypair.generate();

    const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: 0, // Spot
      },
    });

    // Handle array or single tx
    const txs = Array.isArray(createPositionTx) ? createPositionTx : [createPositionTx];
    const txHashes = [];

    for (const tx of txs) {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet, newPosition);
      const txHash = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txHash, 'confirmed');
      txHashes.push(txHash);
    }

    savePosition({
      pool_address: poolAddress,
      position_address: newPosition.publicKey.toString(),
      token_x: dlmmPool.tokenX.publicKey.toString(),
      token_y: dlmmPool.tokenY.publicKey.toString(),
      entry_price: activeBinPrice,
    });

    return {
      success: true,
      txHash: txHashes[0],
      txHashes,
      positionAddress: newPosition.publicKey.toString(),
      entryPrice: activeBinPrice,
      binRange: { min: minBinId, max: maxBinId },
    };
  } catch (e) {
    throw new Error(`Gagal buka posisi: ${e.message}`);
  }
}

// ─── Close Position ──────────────────────────────────────────────

export async function closePositionDLMM(poolAddress, positionAddress) {
  try {
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
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);
      const txHash = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txHash, 'confirmed');
      txHashes.push(txHash);
    }

    closePosition(positionAddress);
    return { success: true, txHashes };
  } catch (e) {
    throw new Error(`Gagal tutup posisi: ${e.message}`);
  }
}

// ─── Claim Fees ──────────────────────────────────────────────────

export async function claimFees(poolAddress, positionAddress) {
  if (isDryRun()) {
    return { dryRun: true, message: `[DRY RUN] Akan claim fees dari posisi ${positionAddress.slice(0, 8)}...` };
  }

  try {
    const connection = getConnection();
    const wallet = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p => p.publicKey.toString() === positionAddress);
    if (!position) throw new Error('Posisi tidak ditemukan');

    // Try claimAllRewards first, fallback to claimFee
    let claimTx;
    try {
      claimTx = await dlmmPool.claimAllRewards({
        owner: wallet.publicKey,
        positions: [position],
      });
    } catch {
      claimTx = await dlmmPool.claimFee({
        owner: wallet.publicKey,
        position: position.publicKey,
      });
    }

    const txs = Array.isArray(claimTx) ? claimTx : [claimTx];
    const txHashes = [];

    for (const tx of txs) {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);
      const txHash = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txHash, 'confirmed');
      txHashes.push(txHash);
    }

    return { success: true, txHashes };
  } catch (e) {
    throw new Error(`Gagal claim fees: ${e.message}`);
  }
}

// ─── Top Pools ───────────────────────────────────────────────────

export async function getTopPools(limit = 5) {
  try {
    const response = await fetch(
      `https://dlmm-api.meteora.ag/pair/all_with_pagination?limit=${Math.max(limit * 2, 20)}&sort_key=fees&order_by=desc`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const pools = data.data || data.pairs || data || [];
    return pools.slice(0, limit).map(pool => ({
      address: pool.address,
      name: pool.name || `${pool.mint_x?.slice(0,4)}/${pool.mint_y?.slice(0,4)}`,
      apr: typeof pool.apr === 'number' ? pool.apr.toFixed(2) + '%' : pool.apr || 'N/A',
      feeApr: typeof pool.fee_apr === 'number' ? pool.fee_apr.toFixed(2) + '%' : pool.fee_apr || 'N/A',
      tvl: pool.liquidity ? '$' + (pool.liquidity / 1e6).toFixed(2) + 'M' : 'N/A',
      volume24h: pool.trade_volume_24h ? '$' + (pool.trade_volume_24h / 1e6).toFixed(2) + 'M' : 'N/A',
      fees24h: pool.fees_24h ? '$' + (pool.fees_24h / 1e3).toFixed(2) + 'K' : 'N/A',
      binStep: pool.bin_step,
      liquidityRaw: pool.liquidity || 0,
    }));
  } catch (e) {
    throw new Error(`Gagal ambil data pool: ${e.message}`);
  }
}
