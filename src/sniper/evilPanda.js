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
import { getConnection, getWallet, getWalletBalance } from '../solana/wallet.js';
import { getConfig } from '../config.js';
import { swapToSol } from '../utils/jupiter.js';
import { safeNum, withExponentialBackoff, fetchWithTimeout } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { addToBlacklist } from '../learn/tokenBlacklist.js';
import { getDynamicStopLoss } from '../market/atrGuard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARVEST_LOG = join(__dirname, '../../harvest.log');

// ── Evil Panda Hardcoded Strategy ────────────────────────────────
const EP_CONFIG = {
  PRICE_RANGE_PCT:    90,
  OFFSET_MIN_PCT:      0,
  OFFSET_MAX_PCT:     90,
  MAX_BINS_PER_TX:    69,
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

    // 6. Hitung deposit Y (SOL) — dibagi merata antar chunk
    const cfg2          = getConfig();
    const slippageBps   = Number(cfg2.slippageBps) || 250;
    // Meteora SDK menerima slippage dalam persen (bukan bps): 150bps = 1.5
    const slippagePct   = slippageBps / 100;

    const totalLamports = Math.floor(deploySol * 1e9);
    const solPerChunk   = Math.floor(totalLamports / chunks.length);
    const amountYBn     = new BN(String(solPerChunk));
    const amountXBn     = new BN('0'); // single-side Y

    console.log(`[evilPanda] bins=${totalBins} chunks=${chunks.length} range=[${rangeMin},${rangeMax}] pf=${microLamports} slip=${slippagePct}%`);

    // 7. Kirim per chunk — dengan Partial Deploy Guard
    // Jika chunk manapun gagal setelah retry, otomatis rollback via exitPosition.
    let chunksConfirmed = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { lowerBinId, upperBinId } = chunks[i];
        const isFirstChunk = i === 0;

        const txOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: posKp.publicKey,
          user:           wallet.publicKey,
          totalXAmount:   amountXBn,
          totalYAmount:   amountYBn,
          strategy: {
            maxBinId:     upperBinId,
            minBinId:     lowerBinId,
            strategyType: 0,
          },
          slippage: slippagePct,
        }).catch(async () =>
          dlmmPool.addLiquidityByStrategy({
            positionPubKey: posKp.publicKey,
            user:           wallet.publicKey,
            totalXAmount:   amountXBn,
            totalYAmount:   amountYBn,
            strategy: {
              maxBinId:     upperBinId,
              minBinId:     lowerBinId,
              strategyType: 0,
            },
            slippage: slippagePct,
          })
        );

        const txList = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
        for (const tx of txList) {
          injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
          const signers = isFirstChunk ? [wallet, posKp] : [wallet];
          try {
            const sig = await connection.sendTransaction(tx, signers, { skipPreflight: false, maxRetries: 3 });
            await pollTxConfirm(connection, sig);
            console.log(`[evilPanda] ✅ Chunk ${i+1}/${chunks.length} sukses terdeploy on-chain: ${sig.slice(0,8)}`);
          } catch (txErr) {
            if (txErr.message.includes('already in use')) {
              console.log(`[evilPanda] ✅ Chunk ${i+1}/${chunks.length} sukses terdeploy on-chain (RPC timeout recovered: already in use)`);
            } else {
              console.error(`[evilPanda] ❌ Chunk ${i+1} gagal tereksekusi: ${txErr.message}`);
              throw txErr;
            }
          }
        }
        chunksConfirmed++;
      }
    } catch (chunkErr) {
      // ── Partial Deploy Guard ─────────────────────────────────────────
      // Ada chunk yang gagal setelah retry. Jika sudah ada chunk yang berhasil
      // (posisi terbuka sebagian), lakukan rollback otomatis.
      console.error(`[evilPanda] ⚠️ Chunk gagal setelah ${chunksConfirmed} chunk sukses: ${chunkErr.message}`);

      if (chunksConfirmed > 0) {
        console.warn(`[evilPanda] 🔄 Partial deploy terdeteksi — memulai rollback otomatis...`);
        // Daftarkan dulu ke registry agar exitPosition bisa temukan posisi on-chain
        _activePositions.set(positionPubkey, {
          poolAddress, deploySol, deployedAt: nowIso(),
          tokenXMint: xMint, tokenYMint: yMint, rangeMin, rangeMax, hwmPct: 0,
        });
        try {
          await exitPosition(positionPubkey, 'PARTIAL_DEPLOY_ROLLBACK');
          appendHarvestLog({ token: xMint.slice(0,8), positionPubkey, pnlPct: 0, deploySol, reason: 'PARTIAL_DEPLOY_ROLLBACK' });
          console.log(`[evilPanda] ✅ Rollback selesai — posisi bersih.`);
        } catch (rollbackErr) {
          console.error(`[evilPanda] ❌ Rollback GAGAL: ${rollbackErr.message} — cek posisi manual!`);
        }
      }
      // Re-throw agar withExponentialBackoff tidak retry deployPosition lagi
      throw new Error(`[evilPanda] Deploy dibatalkan (partial guard): ${chunkErr.message}`);
    }

    // 8. Simpan di registry in-memory (hwmPct = 0 saat pertama buka)
    _activePositions.set(positionPubkey, {
      poolAddress,
      deploySol,
      deployedAt:  nowIso(),
      tokenXMint:  xMint,
      tokenYMint:  yMint,
      rangeMin,
      rangeMax,
      hwmPct:      0, // High Water Mark — diperbarui tiap poll di monitorPnL
    });

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
 * @property {'HOLD'|'TAKE_PROFIT'|'STOP_LOSS'|'ERROR'} action
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
    const pos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!pos) {
      return { action: 'STOP_LOSS', currentValueSol: 0, pnlPct: -100, inRange: false,
               note: 'Position not found on-chain — assumed closed' };
    }

    const pd       = pos.positionData;
    const rawPrice = safeNum(activeBin.pricePerToken);

    const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
    const xDec = xMeta.decimals || 9;
    const yDec = yMeta.decimals || 9;

    const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDec);
    const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDec);
    const feeXUi   = Number(pd.feeX?.toString() || '0')         / Math.pow(10, xDec);
    const feeYUi   = Number(pd.feeY?.toString() || '0')         / Math.pow(10, yDec);

    const currentValueSol = totalYUi + feeYUi + (totalXUi + feeXUi) * rawPrice;
    const pnlPct          = reg.deploySol > 0
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

  return withExponentialBackoff(async () => {
    const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const pos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!pos || !pos.positionData || pos.positionData.lowerBinId === undefined) {
      console.log(`[evilPanda] ❌ Rollback dibatalkan: Data posisi tidak lengkap / undefined (kemungkinan gagal di tahap inisialisasi). Lakukan cek manual pada pubkey: ${positionPubkey}`);
      _activePositions.delete(positionPubkey);
      return { solRecovered: 0, note: 'incomplete position data' };
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

    // 4. Harvest Log + Blacklist
    const tokenSymbol = reg.tokenXMint?.slice(0,8) || 'UNKNOWN';
    const finalPnlPct = reg.deploySol > 0
      ? ((solRecovered - reg.deploySol) / reg.deploySol) * 100
      : 0;
    appendHarvestLog({
      token:          tokenSymbol,
      positionPubkey,
      pnlPct:         finalPnlPct,
      deploySol:      reg.deploySol,
      reason,
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
