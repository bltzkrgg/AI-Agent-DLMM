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
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConnection, getWallet } from '../solana/wallet.js';
import { getConfig, isDryRun } from '../config.js';
import { swapToSol } from '../utils/jupiter.js';
import { getJupiterQuote } from '../solana/jupiter.js';
import { safeNum, withExponentialBackoff, fetchWithTimeout } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { addToBlacklist } from '../learn/tokenBlacklist.js';
import { getDynamicStopLoss } from '../market/atrGuard.js';
import { flushRuntimeState, getRuntimeState, setRuntimeState } from '../runtime/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARVEST_LOG = join(__dirname, '../../harvest.log');
const POSITION_LEDGER_LOG = join(__dirname, '../../position-ledger.jsonl');
const ACTIVE_POSITIONS_STATE_KEY = 'evilPandaActivePositions';

// ── Evil Panda Hardcoded Strategy ────────────────────────────────
const EP_CONFIG = {
  PRICE_RANGE_PCT:    90,
  OFFSET_MIN_PCT:      0,
  OFFSET_MAX_PCT:     90,
  COMPUTE_UNITS:   400_000,
  MICRO_LAMPORTS:  200_000,
  STOP_LOSS_PCT:      10,    // Hard SL — prioritas utama, selalu aktif
  RSI_EXIT_THRESHOLD: 90,    // RSI(2) overbought threshold
  MONITOR_INTERVAL_MS: 15_000,
};

// ── In-process position registry ─────────────────────────────────
// Key: positionPubkey (string)
// Value: { poolAddress, deploySol, deployedAt, tokenXMint, tokenYMint,
//          rangeMin, rangeMax, hwmPct }  ← hwmPct = High Water Mark PnL%
const _activePositions = new Map();
let _exitAccountingLock = false;
let _notifyFn = null;

export function setEvilPandaNotifyFn(fn) {
  _notifyFn = typeof fn === 'function' ? fn : null;
}

async function notify(msg) {
  if (!_notifyFn) return;
  await _notifyFn(msg).catch(() => {});
}

async function persistActivePositionsState() {
  const rows = [..._activePositions.entries()].map(([pubkey, meta]) => ({
    pubkey,
    ...meta,
  }));
  setRuntimeState(ACTIVE_POSITIONS_STATE_KEY, rows);
}

async function persistActivePositionsStateNow() {
  await persistActivePositionsState();
  await flushRuntimeState();
}

async function setPositionLifecycle(positionPubkey, lifecycleState, extra = {}, { flush = false } = {}) {
  const current = _activePositions.get(positionPubkey) || {};
  _activePositions.set(positionPubkey, {
    ...current,
    ...extra,
    lifecycleState,
    lifecycle_state: lifecycleState,
    lifecycleUpdatedAt: nowIso(),
  });
  if (flush) await persistActivePositionsStateNow();
  else await persistActivePositionsState();
  return _activePositions.get(positionPubkey);
}

async function withExitAccountingLock(fn) {
  while (_exitAccountingLock) await new Promise((resolve) => setTimeout(resolve, 100));
  _exitAccountingLock = true;
  try {
    return await fn();
  } finally {
    _exitAccountingLock = false;
  }
}

function nowIso() { return new Date().toISOString(); }

// ── Harvest Log ───────────────────────────────────────────────────
// Tulis satu baris CSV ke harvest.log tiap posisi ditutup.
// Format: timestamp,token,pubkey8,pnlPct,deploySol,reason

function appendHarvestLog({ token = 'UNKNOWN', positionPubkey = '', pnlPct = 0, deploySol = 0, reason = 'MANUAL' } = {}) {
  try {
    const line = [
      nowIso(),
      token,
      positionPubkey.slice(0, 8),
      pnlPct.toFixed(4),
      deploySol.toFixed(6),
      reason,
    ].join(',') + '\n';
    appendFileSync(HARVEST_LOG, line, 'utf8');
    console.log(`[evilPanda] 📝 Harvest log: ${line.trim()}`);
  } catch (e) {
    console.warn(`[evilPanda] harvest.log write error: ${e.message}`);
  }
}

function appendPositionLedger({
  positionPubkey = '',
  poolAddress = '',
  tokenMint = '',
  openedAt = null,
  closedAt = null,
  reason = 'MANUAL',
  capitalInSol = 0,
  capitalOutSol = 0,
  pnlTotalSol = 0,
  pnlTotalPct = 0,
  feePnlSol = 0,
  pricePnlSol = 0,
  txCostSol = 0,
  accountingStatus = 'final',
  manualCloseDetected = false,
} = {}) {
  try {
    const capitalIn = safeNum(capitalInSol, 0);
    const capitalOut = safeNum(capitalOutSol, 0);
    const pnlSol = safeNum(pnlTotalSol, 0);
    const pnlPct = safeNum(pnlTotalPct, 0);
    const feeSol = safeNum(feePnlSol, 0);
    const priceSol = safeNum(pricePnlSol, 0);
    const costSol = safeNum(txCostSol, 0);
    const row = {
      ts: nowIso(),
      positionPubkey,
      poolAddress,
      tokenMint,
      openedAt,
      closedAt,
      reason,
      accountingStatus,
      manualCloseDetected,
      cashflow: {
        capitalInSol: Number(capitalIn.toFixed(9)),
        capitalOutSol: Number(capitalOut.toFixed(9)),
        pnlTotalSol: Number(pnlSol.toFixed(9)),
        pnlTotalPct: Number(pnlPct.toFixed(6)),
        feePnlSol: Number(feeSol.toFixed(9)),
        pricePnlSol: Number(priceSol.toFixed(9)),
        txCostSol: Number(costSol.toFixed(9)),
      },
    };
    appendFileSync(POSITION_LEDGER_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[evilPanda] position-ledger write error: ${e.message}`);
  }
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendExitTx(connection, wallet, tx, microLamports) {
  injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });

  let sig;
  if (tx instanceof VersionedTransaction) {
    tx.sign([wallet]);
    sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  } else {
    sig = await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
  }

  await pollTxConfirm(connection, sig, 90_000);
  return sig;
}

async function getFreshActivePosition(connection, wallet, poolAddress, positionPubkey) {
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates().catch(() => {});
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const activePos = userPositions.find((p) => p.publicKey.toString() === positionPubkey);
  return { dlmmPool, activePos };
}

async function buildClosePositionTxs(dlmmPool, wallet, activePos) {
  const pd = activePos?.positionData || {};
  const lowerBinId = pd.lowerBinId;
  const upperBinId = pd.upperBinId;

  if (lowerBinId !== undefined && upperBinId !== undefined) {
    try {
      const txs = await dlmmPool.removeLiquidity({
        position: activePos.publicKey,
        user: wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });
      return Array.isArray(txs) ? txs : [txs];
    } catch (e) {
      console.warn(`[evilPanda] removeLiquidity close attempt failed: ${e.message}`);
    }
  }

  if (typeof dlmmPool.closePositionIfEmpty === 'function') {
    try {
      const txs = await dlmmPool.closePositionIfEmpty({
        owner: wallet.publicKey,
        position: activePos,
      });
      return Array.isArray(txs) ? txs : [txs];
    } catch (e) {
      console.warn(`[evilPanda] closePositionIfEmpty attempt failed: ${e.message}`);
    }
  }

  if (typeof dlmmPool.closePosition === 'function') {
    const txs = await dlmmPool.closePosition({
      owner: wallet.publicKey,
      position: activePos,
    });
    return Array.isArray(txs) ? txs : [txs];
  }

  throw new Error(`NO_CLOSE_METHOD_AVAILABLE_${activePos.publicKey.toString().slice(0, 8)}`);
}

async function verifyPositionClosedOnChain(connection, wallet, poolAddress, positionPubkey, {
  attempts = 3,
  delayMs = 1200,
} = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const stillOpen = userPositions.some((p) => p.publicKey.toString() === positionPubkey);
      const accountInfo = await connection.getAccountInfo(new PublicKey(positionPubkey));
      if (!stillOpen && accountInfo === null) return true;
    } catch {
      // non-fatal during verification; retry a few times
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

async function estimateTxFeeLamports(connection, signatures = []) {
  let total = 0;
  for (const sig of signatures) {
    if (!sig) continue;
    try {
      const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      total += Number(tx?.meta?.fee || 0);
    } catch {
      // non-fatal
    }
  }
  return total;
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
    const dlmmPool  = await DLMM.create(connection, poolPubkey);
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const binStep   = dlmmPool.lbPair.binStep;

    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();
    const [, yMeta] = await resolveTokens([xMint, yMint]);
    const yDecimals  = yMeta.decimals; // SOL = 9
    const isSOLPair  = yMint === WSOL_MINT;

    if (!isSOLPair) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} bukan SOL pair — Evil Panda hanya mendukung TOKEN/SOL`);
    }

    const binStepInt   = parseInt(binStep);
    const exactLogBinFactor = Math.log(1 + binStepInt / 10000);
    const offsetMinBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MIN_PCT / 100) / exactLogBinFactor)
    ) || 0;
    const offsetMaxBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MAX_PCT / 100) / exactLogBinFactor)
    );

    let rangeMax = activeBin.binId - offsetMinBins;
    let rangeMin = activeBin.binId - offsetMaxBins;

    if ((rangeMax - rangeMin) > 68) { rangeMin = rangeMax - 68; }
    if (rangeMin > rangeMax)        rangeMin = rangeMax - 2;

    const totalBins = rangeMax - rangeMin + 1;
    const microLamports = await getPriorityFee();
    const { Keypair } = await import('@solana/web3.js');
    const posKp = Keypair.generate();
    const positionPubkey = posKp.publicKey.toString();

    const cfg2          = getConfig();
    const slippageBps   = Number(cfg2.slippageBps) || 250;
    const slippagePct   = slippageBps / 100;
    const totalLamports = Math.floor(deploySol * 1e9);
    const amountYBn     = new BN(String(totalLamports));
    const amountXBn     = new BN('0'); // single-side Y

    console.log(`[evilPanda] bins=${totalBins} range=[${rangeMin},${rangeMax}] pf=${microLamports} slip=${slippagePct}%`);

    try {
    const txOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKp.publicKey,
      user:           wallet.publicKey,
      totalXAmount:   amountXBn,
      totalYAmount:   amountYBn,
        strategy: {
          maxBinId:     rangeMax,
          minBinId:     rangeMin,
          strategyType: 0,
        },
        slippage: slippagePct,
    });

    const txList = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];

    if (isDryRun()) {
      for (const tx of txList) {
        injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
        if (tx instanceof VersionedTransaction) {
          tx.sign([wallet, posKp]);
        } else {
          tx.sign(posKp, wallet);
        }
        const sim = await connection.simulateTransaction(tx, { commitment: 'processed' });
        if (sim?.value?.err) {
          throw new Error(`DRY_RUN_SIMULATION_FAILED: ${stringify(sim.value.err)}`);
        }
      }
      console.log(`[DRY RUN] deployPosition simulated only: pool=${poolAddress.slice(0,8)} pos=${positionPubkey.slice(0,8)} txs=${txList.length}`);
      return {
        dryRun: true,
        simulated: true,
        positionPubkey,
        poolAddress,
        rangeMin,
        rangeMax,
        txCount: txList.length,
      };
    }

    await setPositionLifecycle(positionPubkey, 'deploying', {
      poolAddress,
      deploySol,
      deployedAt: nowIso(),
      tokenXMint: xMint,
      tokenYMint: yMint,
      rangeMin,
      rangeMax,
      hwmPct: 0,
    }, { flush: true });

    for (const tx of txList) {
        injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
        const sig = await connection.sendTransaction(tx, [wallet, posKp], { skipPreflight: false, maxRetries: 3 });
        await pollTxConfirm(connection, sig);
        console.log(`[evilPanda] ✅ Monolith position deployed on-chain: ${sig.slice(0,8)}`);
      }
    } catch (deployErr) {
      console.error(`[evilPanda] ❌ Monolith deploy gagal: ${deployErr.message}`);
      throw deployErr;
    }

    await setPositionLifecycle(positionPubkey, 'open', {
      poolAddress,
      deploySol,
      deployedAt:  nowIso(),
      tokenXMint:  xMint,
      tokenYMint:  yMint,
      rangeMin,
      rangeMax,
      hwmPct:      0,
    }, { flush: true });

    console.log(`[evilPanda] ✅ Position open: ${positionPubkey.slice(0,8)}`);
    return positionPubkey;

  }, { maxRetries: 3, baseDelay: 3000 });
}

// ── Meridian Exit Signal Fetcher ──────────────────────────────────
//
// Ambil RSI(2), Bollinger Bands, dan MACD dari Meridian chart-indicators API.
// Interval: 15_MINUTE, rsiLength: 2 (ultra-sensitive overbought detector).
// Fail-open: jika API error, return null → caller tetap HOLD.

/**
 * @typedef {Object} ExitSignal
 * @property {number|null} rsi          - RSI(2) value
 * @property {number|null} close        - Harga close candle terakhir
 * @property {number|null} bbUpper      - Bollinger Band upper
 * @property {number|null} macdHist     - MACD histogram (positif = hijau)
 * @property {string}      direction    - Supertrend direction
 * @property {string}      raw          - Raw reason string
 */

async function fetchExitSignal(tokenXMint) {
  const cfg     = getConfig();
  const apiBase = String(cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api').replace(/\/+$/, '');
  const apiKey  = cfg.publicApiKey || '';

  const params = new URLSearchParams({
    interval:  '15_MINUTE',
    candles:   '50',
    rsiLength: '2',
  });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const res = await fetchWithTimeout(
      `${apiBase}/chart-indicators/${tokenXMint}?${params.toString()}`,
      { headers },
      8000
    );

    if (!res.ok) {
      console.warn(`[evilPanda] Exit signal API ${res.status} — fail-open (HOLD)`);
      return null;
    }

    const data = await res.json();
    const latest = data?.latest || {};

    // Extract fields sesuai struktur Meridian buildSignalSummary
    const rsi      = safeNum(latest?.rsi?.value);                  // RSI(2)
    const close    = safeNum(latest?.candle?.close);               // Harga close
    const bbUpper  = safeNum(latest?.bollinger?.upper);            // BB upper band
    // MACD: Meridian returns latest.macd.histogram
    const macdHist = safeNum(latest?.macd?.histogram              // preferred field
      ?? latest?.macd?.hist                                        // alt field
      ?? latest?.macd?.value);                                     // fallback
    const direction = String(latest?.supertrend?.direction || 'unknown');

    console.log(`[evilPanda] 📡 ExitSignal RSI=${rsi?.toFixed(1)} close=${close?.toFixed(6)} BB_upper=${bbUpper?.toFixed(6)} MACD_hist=${macdHist?.toFixed(6)} ST=${direction}`);

    return { rsi, close, bbUpper, macdHist, direction };

  } catch (e) {
    console.warn(`[evilPanda] fetchExitSignal error: ${e.message} — fail-open (HOLD)`);
    return null;
  }
}

// ── Exit Decision Engine ──────────────────────────────────────────
//
// Skenario A: RSI(2) >= 90 DAN Close >= BB_Upper
// Skenario B: RSI(2) >= 90 DAN MACD Histogram > 0 (bar hijau pertama)
// Jika sinyal tidak tersedia (null) → HOLD, jangan exit karena API down.

function evaluateExitSignal(signal) {
  if (!signal) return { shouldExit: false, scenario: null, reason: 'Signal unavailable — HOLD' };

  const { rsi, close, bbUpper, macdHist } = signal;
  const threshold = EP_CONFIG.RSI_EXIT_THRESHOLD; // 90

  const rsiOverbought = rsi != null && rsi >= threshold;

  // Skenario A: RSI overbought + harga menyentuh/melewati BB upper
  if (rsiOverbought && close != null && bbUpper != null && close >= bbUpper) {
    return {
      shouldExit: true,
      scenario:   'A',
      reason:     `RSI(2)=${rsi?.toFixed(1)}≥${threshold} + Close=${close?.toFixed(6)}≥BB_Upper=${bbUpper?.toFixed(6)}`,
    };
  }

  // Skenario B: RSI overbought + MACD histogram positif (bar hijau)
  if (rsiOverbought && macdHist != null && macdHist > 0) {
    return {
      shouldExit: true,
      scenario:   'B',
      reason:     `RSI(2)=${rsi?.toFixed(1)}≥${threshold} + MACD_hist=${macdHist?.toFixed(6)}>0`,
    };
  }

  return {
    shouldExit: false,
    scenario:   null,
    reason:     `RSI=${rsi?.toFixed(1) ?? 'n/a'} — kondisi exit belum terpenuhi`,
  };
}

// ── 2. monitorPnL ─────────────────────────────────────────────────

/**
 * @typedef {Object} PnLStatus
 * @property {'HOLD'|'TAKE_PROFIT'|'STOP_LOSS'|'MANUAL_CLOSED'|'ERROR'} action
 * @property {number}  currentValueSol
 * @property {number}  pnlPct
 * @property {boolean} inRange
 * @property {string}  [exitScenario]  - 'A' atau 'B' jika exit dipicu TA
 * @property {string}  [exitReason]    - Human-readable reason
 */

/**
 * Poll on-chain + Meridian TA sekali, tentukan action.
 * Priority: Hard SL (-10%) > Skenario TA (A/B).
 * Fail-open: jika Meridian API down, TA-exit tidak dipicu.
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
    // ── On-chain: ambil nilai posisi saat ini ──────────────────────
    const connection = getConnection();
    const wallet     = getWallet();
    const dlmmPool   = await DLMM.create(connection, new PublicKey(reg.poolAddress));
    const activeBin  = await dlmmPool.getActiveBin();

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!activePos) {
      return { action: 'STOP_LOSS', currentValueSol: 0, pnlPct: -100, inRange: false,
               note: 'Position not found on-chain — assumed closed' };
    }

    const pd       = activePos.positionData;
    const rawPrice = safeNum(activeBin.pricePerToken);

    const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
    const xDec = xMeta.decimals || 9;
    const yDec = yMeta.decimals || 9;

    const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDec);
    const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDec);
    const feeXUi   = Number(pd.feeX?.toString() || '0')         / Math.pow(10, xDec);
    const feeYUi   = Number(pd.feeY?.toString() || '0')         / Math.pow(10, yDec);

    const totalXRawToSell = Math.floor((totalXUi + feeXUi) * Math.pow(10, xDec)).toString();

    let currentValueSol = 0;
    try {
      if (totalXRawToSell !== '0') {
        const quote = await getJupiterQuote(reg.tokenXMint, WSOL_MINT, totalXRawToSell);
        const jupOutSol = Number(quote.outAmount) / Math.pow(10, yDec);
        currentValueSol = totalYUi + feeYUi + jupOutSol;
      } else {
        currentValueSol = totalYUi + feeYUi;
      }
    } catch (jupErr) {
      console.warn(`[evilPanda] Jupiter Quote API error, fallback ke pool bin price: ${jupErr.message}`);
      currentValueSol = totalYUi + feeYUi + (totalXUi + feeXUi) * rawPrice;
    }

    const pnlPct = reg.deploySol > 0
      ? ((currentValueSol - reg.deploySol) / reg.deploySol) * 100
      : 0;
    const inRange = activeBin.binId >= reg.rangeMin && activeBin.binId <= reg.rangeMax;

    // ── PRIORITAS 1: Hard Stop Loss ───────────────────────────────────────
    if (pnlPct <= -EP_CONFIG.STOP_LOSS_PCT) {
      console.log(`[evilPanda] 🛑 STOP_LOSS ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}%`);
      return { action: 'STOP_LOSS', currentValueSol, pnlPct, inRange,
               exitReason: `Hard SL: PnL=${pnlPct.toFixed(2)}% ≤ -${EP_CONFIG.STOP_LOSS_PCT}%` };
    }

    // ── PRIORITAS 2: Trailing Stop Loss (High Water Mark) ─────────────────
    // Perbarui HWM jika PnL saat ini lebih tinggi dari sebelumnya.
    // Jika PnL turun > trailingStopPct dari HWM → EXIT.
    const cfg2           = getConfig();
    const trailingStopPct = Number(cfg2.trailingStopPct) || 5;

    if (pnlPct > reg.hwmPct) {
      reg.hwmPct = pnlPct; // update HWM in-place (Map entry adalah referensi)
      console.log(`[evilPanda] 📈 New HWM: ${reg.hwmPct.toFixed(2)}%`);
    }

    // Trailing stop aktif hanya jika HWM sudah positif
    if (reg.hwmPct > 0 && (reg.hwmPct - pnlPct) >= trailingStopPct) {
      const drawdown = reg.hwmPct - pnlPct;
      console.log(`[evilPanda] 📉 TRAILING_STOP ${positionPubkey.slice(0,8)} hwm=${reg.hwmPct.toFixed(2)}% pnl=${pnlPct.toFixed(2)}% drop=${drawdown.toFixed(2)}%`);
      return {
        action:       'STOP_LOSS',
        currentValueSol, pnlPct, inRange,
        exitScenario: 'TRAILING',
        exitReason:   `Trailing SL: turun ${drawdown.toFixed(2)}% dari HWM ${reg.hwmPct.toFixed(2)}% (limit ${trailingStopPct}%)`,
      };
    }

    // ── PRIORITAS 2: Meridian Smart Exit (TA-driven) ──────────────
    // Fetch RSI(2) + BB + MACD dari Meridian, fail-open jika API down.
    const signal     = await fetchExitSignal(reg.tokenXMint);
    const exitDecision = evaluateExitSignal(signal);

    console.log(`[evilPanda] 📊 ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% val=${currentValueSol.toFixed(4)}SOL | TA: ${exitDecision.reason}`);

    if (exitDecision.shouldExit) {
      console.log(`[evilPanda] 🎯 TAKE_PROFIT Skenario ${exitDecision.scenario}: ${exitDecision.reason}`);
      return {
        action:        'TAKE_PROFIT',
        currentValueSol,
        pnlPct,
        inRange,
        exitScenario:  exitDecision.scenario,
        exitReason:    exitDecision.reason,
      };
    }

    return { action: 'HOLD', currentValueSol, pnlPct, inRange, exitReason: exitDecision.reason };

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

  try {
    return await withExitAccountingLock(() => withExponentialBackoff(async () => {
    const preSwapLamports = await connection.getBalance(wallet.publicKey);
    const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!activePos) {
      if (isDryRun()) {
        console.log(`[DRY RUN] exitPosition skipped: ${positionPubkey.slice(0,8)} not found on-chain`);
        return { dryRun: true, skipped: true, reason: 'POSITION_NOT_FOUND_ON_CHAIN' };
      }
      return await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED_DURING_EXIT');
    }

    if (!activePos.positionData || activePos.positionData.lowerBinId === undefined) {
      if (isDryRun()) {
        console.log(`[DRY RUN] exitPosition skipped: ${positionPubkey.slice(0,8)} position data incomplete`);
        return { dryRun: true, skipped: true, reason: 'POSITION_DATA_INCOMPLETE' };
      }
      const msg = `POSITION_STATE_AMBIGUOUS_${positionPubkey.slice(0,8)}`;
      console.log(`[evilPanda] ❌ ${msg}: Data posisi tidak lengkap / undefined. Registry ditahan untuk manual reconcile.`);
      await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
        manualReconcileReason: 'incomplete position data or RPC timeout',
        closeReason: reason,
      }, { flush: true });
      throw new Error(msg);
    }

    if (isDryRun()) {
      const dryRunRemoveTxs = await dlmmPool.removeLiquidity({
        position: activePos.publicKey,
        user: wallet.publicKey,
        fromBinId: activePos.positionData.lowerBinId,
        toBinId: activePos.positionData.upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const dryRunTxList = Array.isArray(dryRunRemoveTxs) ? dryRunRemoveTxs : [dryRunRemoveTxs];
      for (const tx of dryRunTxList) {
        injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
        if (tx instanceof VersionedTransaction) {
          tx.sign([wallet]);
        } else {
          tx.sign(wallet);
        }
        const sim = await connection.simulateTransaction(tx, { commitment: 'processed' });
        if (sim?.value?.err) {
          throw new Error(`DRY_RUN_SIMULATION_FAILED: ${stringify(sim.value.err)}`);
        }
      }

      console.log(`[DRY RUN] exitPosition simulated only: pos=${positionPubkey.slice(0,8)} txs=${dryRunTxList.length}`);
      return { dryRun: true, solRecovered: 0, simulated: true, txCount: dryRunTxList.length };
    }

    await setPositionLifecycle(positionPubkey, 'closing', { closeReason: reason }, { flush: true });

    // Snapshot fee composition sebelum close untuk accounting split.
    let estimatedFeeSol = 0;
    try {
      const pd = activePos.positionData;
      const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
      const xDec = xMeta.decimals || 9;
      const yDec = yMeta.decimals || 9;
      const feeXRaw = String(pd.feeX?.toString() || '0');
      const feeYUi = Number(pd.feeY?.toString() || '0') / Math.pow(10, yDec);
      let feeXSol = 0;
      if (feeXRaw !== '0') {
        try {
          const quote = await getJupiterQuote(reg.tokenXMint, WSOL_MINT, feeXRaw);
          feeXSol = Number(quote.outAmount || 0) / 1e9;
        } catch {
          const feeXUi = Number(pd.feeX?.toString() || '0') / Math.pow(10, xDec);
          feeXSol = Math.max(0, feeXUi * safeNum((await dlmmPool.getActiveBin())?.pricePerToken, 0));
        }
      }
      estimatedFeeSol = Math.max(0, feeYUi + feeXSol);
    } catch {
      estimatedFeeSol = 0;
    }

    // 1. Remove all liquidity and request account close.
    const removeTxList = await buildClosePositionTxs(dlmmPool, wallet, activePos);
    const removeSignatures = [];
    for (const tx of removeTxList) {
      const sig = await sendExitTx(connection, wallet, tx, microLamports);
      removeSignatures.push(sig);
      console.log(`[evilPanda] Remove liquidity TX confirmed: ${sig.slice(0,8)}`);
    }

    // Some DLMM accounts need a fresh-state cleanup after fees/rewards settle.
    for (let cleanupAttempt = 1; cleanupAttempt <= 3; cleanupAttempt++) {
      await sleep(cleanupAttempt === 1 ? 6000 : 4000);
      const isClosed = await verifyPositionClosedOnChain(connection, wallet, reg.poolAddress, positionPubkey, {
        attempts: 1,
        delayMs: 0,
      });
      if (isClosed) break;

      const { dlmmPool: freshPool, activePos: freshPos } = await getFreshActivePosition(
        connection,
        wallet,
        reg.poolAddress,
        positionPubkey,
      );
      if (!freshPos) {
        continue;
      }

      console.warn(`[evilPanda] Position masih open setelah remove; cleanup attempt ${cleanupAttempt}/3`);
      const cleanupTxList = await buildClosePositionTxs(freshPool, wallet, freshPos);
      for (const tx of cleanupTxList) {
        const sig = await sendExitTx(connection, wallet, tx, microLamports);
        removeSignatures.push(sig);
        console.log(`[evilPanda] Cleanup close TX confirmed: ${sig.slice(0,8)}`);
      }
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
    } catch (e) {
      console.warn(`[evilPanda] Swap sisa token gagal (tidak fatal): ${e.message}`);
    }
    const postSwapLamports = await connection.getBalance(wallet.publicKey);
    solRecovered = (postSwapLamports - preSwapLamports) / 1e9;
    const txFeeLamports = await estimateTxFeeLamports(connection, removeSignatures);
    const txFeeSol = txFeeLamports / 1e9;

    // 3. Verifikasi posisi benar-benar sudah close di chain
    const isClosedOnChain = await verifyPositionClosedOnChain(connection, wallet, reg.poolAddress, positionPubkey, {
      attempts: 3,
      delayMs: 1200,
    });
    if (!isClosedOnChain) {
      await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
        manualReconcileReason: 'close verification failed',
        closeReason: reason,
      }, { flush: true });
      throw new Error(`POSITION_STILL_OPEN_AFTER_EXIT_${positionPubkey.slice(0,8)}`);
    }

    // 4. Bersihkan registry lokal setelah verifikasi close sukses
    _activePositions.delete(positionPubkey);
    await persistActivePositionsStateNow();
    console.log(`[evilPanda] ✅ Position closed & verified: ${positionPubkey.slice(0,8)} | reason=${reason}`);

    // 5. Harvest Log + Ledger + Blacklist
    const tokenSymbol = reg.tokenXMint?.slice(0,8) || 'UNKNOWN';
    const pnlTotalSol = solRecovered - reg.deploySol;
    const feePnlSol = Math.max(0, estimatedFeeSol);
    const pricePnlSol = pnlTotalSol - feePnlSol;
    const finalPnlPct = reg.deploySol > 0
      ? (pnlTotalSol / reg.deploySol) * 100
      : 0;
    appendHarvestLog({
      token:          tokenSymbol,
      positionPubkey,
      pnlPct:         finalPnlPct,
      deploySol:      reg.deploySol,
      reason,
    });
    appendPositionLedger({
      positionPubkey,
      poolAddress: reg.poolAddress || '',
      tokenMint: reg.tokenXMint || '',
      openedAt: reg.deployedAt || null,
      closedAt: nowIso(),
      reason,
      capitalInSol: reg.deploySol || 0,
      capitalOutSol: solRecovered,
      pnlTotalSol,
      pnlTotalPct: finalPnlPct,
      feePnlSol,
      pricePnlSol,
      txCostSol: txFeeSol,
    });

    // Tambah ke blacklist jika kena SL / rugpull / rollback
    const SL_REASONS = ['STOP_LOSS', 'PARTIAL_DEPLOY_ROLLBACK', 'MANUAL_STOP'];
    if (SL_REASONS.includes(reason) || finalPnlPct <= -10) {
      const isRug = finalPnlPct <= -15;
      addToBlacklist(reg.tokenXMint, {
        token:     tokenSymbol,
        reason,
        note:      `PnL ${finalPnlPct.toFixed(2)}%`,
        permanent: isRug,
      });
    }

    return { solRecovered };

    }, { maxRetries: 2, baseDelay: 3000 }));
  } catch (e) {
    if (_activePositions.has(positionPubkey)) {
      await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
        manualReconcileReason: e?.message || 'exit failed before on-chain verification',
        closeReason: reason,
      }, { flush: true });
    }
    throw e;
  }
}

export async function markPositionManuallyClosed(positionPubkey, reason = 'MANUAL_WITHDRAW_DETECTED') {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) return { ok: true, solRecovered: 0, alreadyRemoved: true };

  _activePositions.delete(positionPubkey);
  await persistActivePositionsStateNow();

  const tokenSymbol = reg.tokenXMint?.slice(0, 8) || 'UNKNOWN';
  appendHarvestLog({
    token: tokenSymbol,
    positionPubkey,
    pnlPct: 0,
    deploySol: safeNum(reg.deploySol, 0),
    reason,
  });
  appendPositionLedger({
    positionPubkey,
    poolAddress: reg.poolAddress || '',
    tokenMint: reg.tokenXMint || '',
    openedAt: reg.deployedAt || null,
    closedAt: nowIso(),
    reason,
    capitalInSol: safeNum(reg.deploySol, 0),
    accountingStatus: 'manual_close_pnl_unknown',
    manualCloseDetected: true,
  });

  const symbol = reg.tokenXMint?.slice(0, 8) || 'UNKNOWN';
  const pool   = reg.poolAddress?.slice(0, 8) || 'UNKNOWN';
  await notify(
    `ℹ️ <b>Manual close terdeteksi</b>\n` +
    `Token: <b>${symbol}</b>\n` +
    `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` +
    `Pool: <code>${pool}</code>\n` +
    `Alasan: <code>${reason}</code>\n` +
    `<i>Posisi dihapus dari registry lokal dan akan direconcile jika masih ada sisa state.</i>`
  );
  console.log(`[evilPanda] Manual close recorded: ${positionPubkey.slice(0,8)} | token=${symbol} | reason=${reason}`);
  return { ok: true, solRecovered: 0, manualCloseDetected: true };
}

export async function reconcileStartupPositions() {
  const connection = getConnection();
  const wallet = getWallet();
  const saved = getRuntimeState(ACTIVE_POSITIONS_STATE_KEY, []);
  const rows = Array.isArray(saved) ? saved : [];
  let restored = 0;
  let dropped = 0;

  _activePositions.clear();
  for (const row of rows) {
    const pubkey = row?.pubkey;
    const poolAddress = row?.poolAddress;
    if (!pubkey || !poolAddress) {
      dropped++;
      continue;
    }
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const exists = userPositions.some((p) => p.publicKey.toString() === pubkey);
      if (!exists) {
        dropped++;
        continue;
      }
      _activePositions.set(pubkey, {
        poolAddress,
        deploySol: safeNum(row.deploySol, 0),
        deployedAt: row.deployedAt || nowIso(),
        tokenXMint: row.tokenXMint || '',
        tokenYMint: row.tokenYMint || '',
        rangeMin: safeNum(row.rangeMin, 0),
        rangeMax: safeNum(row.rangeMax, 0),
        hwmPct: safeNum(row.hwmPct, 0),
        lifecycleState: row.lifecycleState || row.lifecycle_state || 'open',
        lifecycle_state: row.lifecycle_state || row.lifecycleState || 'open',
      });
      restored++;
    } catch {
      dropped++;
    }
  }

  await persistActivePositionsStateNow();
  return { scanned: rows.length, restored, dropped };
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
