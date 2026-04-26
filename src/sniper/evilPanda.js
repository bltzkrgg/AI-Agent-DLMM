/**
 * src/sniper/evilPanda.js — Linear Sniper Executor (RPC-First)
 *
 * Satu-satunya eksekutor di arsitektur Linear Sniper.
 * Tiga fungsi, tidak lebih:
 *   1. deployPosition(poolAddress)  → buka posisi DLMM
 *   2. monitorPnL(positionPubkey)   → cek TP/SL langsung dari chain
 *   3. exitPosition(positionPubkey) → tutup posisi + swap ke SOL
 *
 * Tidak ada DB, tidak ada circuit breaker, tidak ada strategy loader.
 * State minimal disimpan di _activePositions (in-memory, process lifetime).
 */

'use strict';

import DLMM from '@meteora-ag/dlmm';
import { PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet, getWalletBalance } from '../solana/wallet.js';
import { getConfig } from '../config.js';
import { swapToSol } from '../utils/jupiter.js';
import { safeNum, withExponentialBackoff } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';

// ── Evil Panda Hardcoded Strategy ────────────────────────────────
// Deep-range single-side Y (SOL-only deposit).
// Bot menyimpan SOL murni di bawah harga aktif — tunggu harga jatuh.
const EP_CONFIG = {
  PRICE_RANGE_PCT:    90,    // 90% total range di bawah harga aktif
  OFFSET_MIN_PCT:      0,    // Mulai dari tepat harga aktif
  OFFSET_MAX_PCT:     90,    // Sampai 90% di bawah harga aktif
  MAX_BINS_PER_TX:    69,    // Aman untuk Solana TX size
  COMPUTE_UNITS:   400_000,
  MICRO_LAMPORTS:  200_000,  // Default jika Helius priority fee gagal
  TAKE_PROFIT_PCT:    15,    // +15% dari modal → exit
  STOP_LOSS_PCT:      10,    // -10% dari modal → exit
  MONITOR_INTERVAL_MS: 15_000, // Poll tiap 15 detik
};

// ── In-process position registry ─────────────────────────────────
// Key: positionPubkey (string)
// Value: { poolAddress, deploySol, deployedAt, tokenXMint, tokenYMint }
const _activePositions = new Map();

function nowIso() { return new Date().toISOString(); }

// ── Helpers ───────────────────────────────────────────────────────

function injectPriorityFee(tx, { units, microLamports } = {}) {
  const cu   = units        || EP_CONFIG.COMPUTE_UNITS;
  const mLam = microLamports || EP_CONFIG.MICRO_LAMPORTS;

  if (tx instanceof VersionedTransaction) {
    try {
      const msg = TransactionMessage.decompile(tx.message);
      const CB  = ComputeBudgetProgram.programId.toString();
      msg.instructions = msg.instructions.filter(ix => ix.programId.toString() !== CB);
      msg.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: mLam }),
      );
      tx.message = msg.compileToV0Message();
    } catch (e) {
      console.warn(`[evilPanda] Priority fee inject failed: ${e.message}`);
    }
    return;
  }
  // Legacy TX
  const CB = ComputeBudgetProgram.programId.toString();
  tx.instructions = (tx.instructions || []).filter(ix => ix.programId.toString() !== CB);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: mLam }),
  );
}

async function getPriorityFee() {
  try {
    const fee = await getRecommendedPriorityFee();
    return Math.max(EP_CONFIG.MICRO_LAMPORTS, Number(fee) || EP_CONFIG.MICRO_LAMPORTS);
  } catch {
    return EP_CONFIG.MICRO_LAMPORTS;
  }
}

async function pollTxConfirm(connection, sig, maxWaitMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (value?.err) throw new Error(`TX on-chain error: ${JSON.stringify(value.err)}`);
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
        return sig;
      }
    } catch (e) {
      if (e.message.startsWith('TX on-chain')) throw e;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error(`TX ${sig.slice(0, 8)}… not confirmed after ${maxWaitMs / 1000}s`);
}

// ── 1. deployPosition ─────────────────────────────────────────────

/**
 * Buka posisi DLMM Evil Panda (single-side SOL, 90% range di bawah harga aktif).
 *
 * @param {string} poolAddress  - Pubkey pool DLMM
 * @returns {Promise<string>}   - positionPubkey (string)
 */
export async function deployPosition(poolAddress) {
  const cfg        = getConfig();
  const deploySol  = cfg.deployAmountSol || 0.1;
  const connection = getConnection();
  const wallet     = getWallet();
  const poolPubkey = new PublicKey(poolAddress);

  console.log(`[evilPanda] ▶ deployPosition pool=${poolAddress.slice(0,8)} sol=${deploySol}`);

  return withExponentialBackoff(async () => {
    // 1. Load pool
    const dlmmPool  = await DLMM.create(connection, poolPubkey);
    const activeBin = await dlmmPool.getActiveBin();
    const binStep   = dlmmPool.lbPair.binStep;

    // 2. Resolve tokens
    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();
    const [, yMeta] = await resolveTokens([xMint, yMint]);
    const yDecimals  = yMeta.decimals; // SOL = 9
    const isSOLPair  = yMint === WSOL_MINT;

    if (!isSOLPair) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} bukan SOL pair — Evil Panda hanya mendukung TOKEN/SOL`);
    }

    // 3. Hitung bin range (log-accurate, sama seperti meteora.js legacy)
    const binStepInt   = parseInt(binStep);
    const logBinFactor = binStepInt * Math.log(1.0001);

    const offsetMinBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MIN_PCT / 100) / logBinFactor)
    ) || 0;
    const offsetMaxBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MAX_PCT / 100) / logBinFactor)
    );

    let rangeMax = activeBin.binId - offsetMinBins - 1; // strictly below active
    let rangeMin = activeBin.binId - offsetMaxBins;

    // Clamp
    if (rangeMax - rangeMin > 1000) rangeMin = rangeMax - 1000;
    if (rangeMin > rangeMax)        rangeMin = rangeMax - 2;

    const totalBins = rangeMax - rangeMin + 1;
    const chunks    = [];
    for (let s = rangeMin; s <= rangeMax; s += EP_CONFIG.MAX_BINS_PER_TX) {
      chunks.push({ lowerBinId: s, upperBinId: Math.min(rangeMax, s + EP_CONFIG.MAX_BINS_PER_TX - 1) });
    }

    // 4. Ambil priority fee
    const microLamports = await getPriorityFee();

    // 5. Generate position keypair
    const { Keypair } = await import('@solana/web3.js');
    const posKp = Keypair.generate();
    const positionPubkey = posKp.publicKey.toString();

    // 6. Hitung deposit Y (SOL) dalam lamports — dibagi merata antar chunk
    const totalLamports    = Math.floor(deploySol * 1e9);
    const solPerChunk      = Math.floor(totalLamports / chunks.length);
    const amountYBn        = new BN(String(solPerChunk));
    const amountXBn        = new BN('0'); // single-side Y

    console.log(`[evilPanda] bins=${totalBins} chunks=${chunks.length} range=[${rangeMin},${rangeMax}] pf=${microLamports}`);

    // 7. Kirim per chunk
    for (let i = 0; i < chunks.length; i++) {
      const { lowerBinId, upperBinId } = chunks[i];
      const isFirstChunk = i === 0;

      const txOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: posKp.publicKey,
        user:           wallet.publicKey,
        totalXAmount:   amountXBn,
        totalYAmount:   amountYBn,
        strategy: {
          maxBinId:         upperBinId,
          minBinId:         lowerBinId,
          strategyType:     0, // Spot distribution
        },
        slippage: 1,
      }).catch(async () => {
        // Fallback: addLiquidityByStrategy jika posisi sudah ada
        return dlmmPool.addLiquidityByStrategy({
          positionPubKey: posKp.publicKey,
          user:           wallet.publicKey,
          totalXAmount:   amountXBn,
          totalYAmount:   amountYBn,
          strategy: {
            maxBinId:     upperBinId,
            minBinId:     lowerBinId,
            strategyType: 0,
          },
          slippage: 1,
        });
      });

      const txList = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];

      for (const tx of txList) {
        injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
        const signers = isFirstChunk ? [wallet, posKp] : [wallet];
        const sig = await connection.sendTransaction(tx, signers, { skipPreflight: false, maxRetries: 3 });
        await pollTxConfirm(connection, sig);
        console.log(`[evilPanda] Chunk ${i+1}/${chunks.length} confirmed: ${sig.slice(0,8)}`);
      }
    }

    // 8. Simpan di registry in-memory
    _activePositions.set(positionPubkey, {
      poolAddress,
      deploySol,
      deployedAt:   nowIso(),
      tokenXMint:   xMint,
      tokenYMint:   yMint,
      rangeMin,
      rangeMax,
    });

    console.log(`[evilPanda] ✅ Position open: ${positionPubkey.slice(0,8)}`);
    return positionPubkey;

  }, { maxRetries: 3, baseDelay: 3000 });
}

// ── 2. monitorPnL ─────────────────────────────────────────────────

/**
 * @typedef {Object} PnLStatus
 * @property {'HOLD'|'TAKE_PROFIT'|'STOP_LOSS'|'ERROR'} action
 * @property {number} currentValueSol
 * @property {number} pnlPct
 * @property {boolean} inRange
 */

/**
 * Poll on-chain sekali dan hitung PnL.
 * Dipanggil berulang dari loop while(true) di hunterAlpha.js.
 *
 * @param {string} positionPubkey
 * @returns {Promise<PnLStatus>}
 */
export async function monitorPnL(positionPubkey) {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) {
    return { action: 'ERROR', currentValueSol: 0, pnlPct: 0, inRange: false,
             error: `Position ${positionPubkey.slice(0,8)} not in registry` };
  }

  try {
    const connection = getConnection();
    const wallet     = getWallet();
    const dlmmPool   = await DLMM.create(connection, new PublicKey(reg.poolAddress));
    const activeBin  = await dlmmPool.getActiveBin();

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const pos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!pos) {
      // Posisi tidak ditemukan on-chain → mungkin sudah di-close manual
      return { action: 'STOP_LOSS', currentValueSol: 0, pnlPct: -100, inRange: false,
               note: 'Position not found on-chain — assumed closed' };
    }

    const pd       = pos.positionData;
    const rawPrice = safeNum(activeBin.pricePerToken);

    const [, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
    const yDec = yMeta.decimals;
    const xDec = 9; // token decimals — approximate, sufficient for PnL calc

    const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDec);
    const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDec);
    const feeXUi   = Number(pd.feeX?.toString() || '0')         / Math.pow(10, xDec);
    const feeYUi   = Number(pd.feeY?.toString() || '0')         / Math.pow(10, yDec);

    const currentValueSol = totalYUi + feeYUi + (totalXUi + feeXUi) * rawPrice;
    const pnlPct          = reg.deploySol > 0
      ? ((currentValueSol - reg.deploySol) / reg.deploySol) * 100
      : 0;

    const inRange = activeBin.binId >= reg.rangeMin && activeBin.binId <= reg.rangeMax;

    console.log(`[evilPanda] 📊 ${positionPubkey.slice(0,8)} val=${currentValueSol.toFixed(4)}SOL pnl=${pnlPct.toFixed(2)}% inRange=${inRange}`);

    let action = 'HOLD';
    if (pnlPct >= EP_CONFIG.TAKE_PROFIT_PCT) action = 'TAKE_PROFIT';
    if (pnlPct <= -EP_CONFIG.STOP_LOSS_PCT)  action = 'STOP_LOSS';

    return { action, currentValueSol, pnlPct, inRange };

  } catch (e) {
    console.warn(`[evilPanda] monitorPnL error: ${e.message}`);
    return { action: 'ERROR', currentValueSol: 0, pnlPct: 0, inRange: false, error: e.message };
  }
}

// ── 3. exitPosition ───────────────────────────────────────────────

/**
 * Withdraw 100% likuiditas, lalu swap sisa tokenX ke SOL.
 *
 * @param {string} positionPubkey
 * @param {string} [reason='MANUAL']
 * @returns {Promise<{ solRecovered: number }>}
 */
export async function exitPosition(positionPubkey, reason = 'MANUAL') {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) throw new Error(`[evilPanda] exitPosition: ${positionPubkey.slice(0,8)} not in registry`);

  console.log(`[evilPanda] ▶ exitPosition ${positionPubkey.slice(0,8)} reason=${reason}`);

  const connection = getConnection();
  const wallet     = getWallet();
  const microLamports = await getPriorityFee();

  return withExponentialBackoff(async () => {
    const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const pos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!pos) {
      console.warn(`[evilPanda] exitPosition: position tidak ditemukan on-chain (mungkin sudah closed)`);
      _activePositions.delete(positionPubkey);
      return { solRecovered: 0, note: 'already closed' };
    }

    // 1. Remove all liquidity
    const removeTxs = await dlmmPool.removeLiquidity({
      position:       pos.publicKey,
      user:           wallet.publicKey,
      fromBinId:      pos.positionData.lowerBinId,
      toBinId:        pos.positionData.upperBinId,
      liquidityBpsToRemove: new BN(10000), // 100%
      shouldClaimAndClose:  true,
    });

    const removeTxList = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
    for (const tx of removeTxList) {
      injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
      const sig = await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
      await pollTxConfirm(connection, sig);
      console.log(`[evilPanda] Remove liquidity TX confirmed: ${sig.slice(0,8)}`);
    }

    // 2. Swap sisa tokenX → SOL (jika ada)
    let solRecovered = 0;
    try {
      const { getTokenBalance } = await import('../solana/wallet.js');
      const tokenXBalance = await getTokenBalance(reg.tokenXMint);
      if (tokenXBalance > 0.0001) {
        console.log(`[evilPanda] Swap ${tokenXBalance} tokenX → SOL`);
        await swapToSol(reg.tokenXMint, tokenXBalance);
      }
      const newBal = parseFloat(await getWalletBalance());
      solRecovered = newBal;
    } catch (e) {
      console.warn(`[evilPanda] Swap sisa token gagal (tidak fatal): ${e.message}`);
    }

    // 3. Bersihkan registry
    _activePositions.delete(positionPubkey);
    console.log(`[evilPanda] ✅ Position closed: ${positionPubkey.slice(0,8)} | reason=${reason}`);

    return { solRecovered };

  }, { maxRetries: 2, baseDelay: 3000 });
}

// ── Registry helpers (untuk index.js) ────────────────────────────

export function getActivePositionCount() {
  return _activePositions.size;
}

export function getActivePositionKeys() {
  return [..._activePositions.keys()];
}

export function getPositionMeta(positionPubkey) {
  return _activePositions.get(positionPubkey) || null;
}

export { EP_CONFIG };
