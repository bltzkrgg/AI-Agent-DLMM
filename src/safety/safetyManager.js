/**
 * Safety Manager
 * 
 * 4 mekanisme:
 * 1. Stop-loss per posisi — close kalau rugi > X%
 * 2. Max drawdown harian — freeze semua kalau rugi > X% dalam sehari
 * 3. Validasi strategi vs kondisi market
 * 4. Konfirmasi Telegram sebelum deploy
 */

'use strict';

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.js';
import { getRuntimeState, setRuntimeState } from '../runtime/state.js';
import { safeNum, stringify } from '../utils/safeJson.js';

// ─── State ───────────────────────────────────────────────────────

const DAILY_RISK_STATE_KEY = 'daily-risk-state';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy — resolved at call time so BOT_DAILY_RISK_PATH set before first use is always honoured.
function getDailyRiskFilePath() {
  return process.env.BOT_DAILY_RISK_PATH || join(__dirname, '../../daily-risk-state.json');
}

// Pending confirmations — key: confirmationId, value: { resolve, reject, timeout }
const pendingConfirmations = new Map();
// No more sequence counter to avoid collision on restart

function getTodayStr() {
  // Use local date so the reset boundary matches the operator's clock, not UTC
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getDefaultDailyRiskState(date = getTodayStr()) {
  return { date, totalPnlUsd: 0, dailyAccumulatedLoss: 0, startingBalanceUsd: null };
}

function readDailyRiskFile() {
  const filePath = getDailyRiskFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    console.warn(`[safety] Failed to parse daily risk file: ${e.message}`);
    return null;
  }
}

function writeDailyRiskFile(state) {
  const filePath = getDailyRiskFilePath();
  try {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, stringify(state, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (e) {
    console.warn(`[safety] Failed to persist daily risk file: ${e.message}`);
  }
}

function loadDailyRiskState() {
  const today = getTodayStr();
  const runtimeStored = getRuntimeState(DAILY_RISK_STATE_KEY, null);
  const fileStored = readDailyRiskFile();
  const stored = (runtimeStored?.date === today)
    ? runtimeStored
    : (fileStored?.date === today ? fileStored : null);
  if (!stored) {
    const reset = getDefaultDailyRiskState(today);
    saveDailyRiskState(reset);
    return reset;
  }
  const hydrated = {
    ...getDefaultDailyRiskState(today),
    ...stored,
  };
  hydrated.totalPnlUsd = safeNum(hydrated.totalPnlUsd);
  hydrated.dailyAccumulatedLoss = Number.isFinite(hydrated.dailyAccumulatedLoss)
    ? Math.max(0, safeNum(hydrated.dailyAccumulatedLoss))
    : Math.max(0, -hydrated.totalPnlUsd);
  return hydrated;
}

function saveDailyRiskState(state) {
  const normalized = {
    ...getDefaultDailyRiskState(state?.date || getTodayStr()),
    ...(state || {}),
  };
  normalized.totalPnlUsd = safeNum(normalized.totalPnlUsd);
  normalized.dailyAccumulatedLoss = Number.isFinite(normalized.dailyAccumulatedLoss)
    ? Math.max(0, safeNum(normalized.dailyAccumulatedLoss))
    : Math.max(0, -normalized.totalPnlUsd);
  setRuntimeState(DAILY_RISK_STATE_KEY, normalized);
  writeDailyRiskFile(normalized);
}

// ─── Daily PnL Tracking ──────────────────────────────────────────

export function recordPnlUsd(pnlUsd) {
  const dailyPnl = loadDailyRiskState();
  const delta = safeNum(pnlUsd);
  dailyPnl.totalPnlUsd += delta;
  if (delta < 0) {
    dailyPnl.dailyAccumulatedLoss = safeNum(dailyPnl.dailyAccumulatedLoss) + Math.abs(delta);
  }
  saveDailyRiskState(dailyPnl);
}

export function getDailyPnl() {
  return loadDailyRiskState();
}

export function setStartingBalanceUsd(balanceUsd) {
  const dailyPnl = loadDailyRiskState();
  if (!dailyPnl.startingBalanceUsd && Number.isFinite(balanceUsd) && balanceUsd > 0) {
    dailyPnl.startingBalanceUsd = balanceUsd;
    saveDailyRiskState(dailyPnl);
  }
}

// ─── Check 1: Stop-Loss Per Posisi ──────────────────────────────

/**
 * Cek apakah posisi harus di-stop-loss
 * @param {object} position - position data
 * @param {number} strategySl - optional strategy-specific SL (e.g. -40)
 * @returns {{ triggered: boolean, reason: string }}
 */
export function checkStopLoss(position, strategySl = null) {
  const cfg = getConfig();
  // Gunakan strategySl jika ada, jika tidak pakai global config
  const threshold = (strategySl !== null) ? Math.abs(strategySl) : (cfg.stopLossPct ?? 5);

  // pnlPct negative = loss on principal
  // Prioritas: pnlPct yang di-pass lewat object > data internal position
  const pnlPct = position.pnlPct ?? position.pnl_pct ?? null;

  if (pnlPct === null) return { triggered: false, reason: 'No PnL data available' };

  // pnlPct negative = loss on principal
  if (pnlPct < -threshold) {
    return {
      triggered: true,
      reason: `Stop-loss triggered: PnL ${pnlPct.toFixed(2)}% melewati threshold -${threshold}%`,
    };
  }

  return { triggered: false, reason: null };
}

// ─── Check 2: Max Drawdown Harian ────────────────────────────────

/**
 * Cek apakah sudah melewati max drawdown harian
 * @returns {{ triggered: boolean, reason: string, dailyPnlUsd: number }}
 */
export function checkMaxDrawdown() {
  const cfg = getConfig();
  const maxDrawdownPct = cfg.maxDailyDrawdownPct ?? 10;

  const pnl = getDailyPnl();

  // Only check drawdown if we have meaningful PnL data
  if (pnl.totalPnlUsd === 0) {
    return { triggered: false, reason: null, dailyPnlUsd: 0, drawdownPct: 0 };
  }

  // Use starting balance in USD if available, else skip drawdown check
  if (!pnl.startingBalanceUsd || pnl.startingBalanceUsd <= 0) {
    return { triggered: false, reason: null, dailyPnlUsd: pnl.totalPnlUsd, drawdownPct: 0 };
  }

  const drawdownPct = (pnl.totalPnlUsd / pnl.startingBalanceUsd) * 100;

  if (drawdownPct < -maxDrawdownPct) {
    return {
      triggered: true,
      reason: `⛔ Max drawdown harian tercapai: ${drawdownPct.toFixed(2)}% (threshold: -${maxDrawdownPct}%). Bot dibekukan hari ini.`,
      dailyPnlUsd: pnl.totalPnlUsd,
      drawdownPct,
    };
  }

  return { triggered: false, reason: null, dailyPnlUsd: pnl.totalPnlUsd, drawdownPct };
}

// ─── Check 3: Validasi Strategi vs Market ────────────────────────

/**
 * Validasi apakah strategi cocok dengan kondisi market saat ini
 * @param {string} strategyType - 'spot' | 'curve' | 'bid_ask'
 * @param {object} poolInfo - info pool dari Meteora
 * @returns {{ valid: boolean, warning: string|null, recommendation: string }}
 */
export function validateStrategyForMarket(strategyType, poolInfo) {
  const warnings = [];
  let recommendation = strategyType;

  const binStep = poolInfo.binStep || 0;
  const feeRate = parseFloat(poolInfo.feeRate) || 0;
  const feeApr = safeNum(poolInfo.feeApr);
  const tvl = safeNum(poolInfo.tvl);
  const volume24h = safeNum(poolInfo.volume24h);
  const feeTvlDaily = tvl > 0 ? (safeNum(poolInfo.fees24h) / tvl) : 0;
  const volumeTvlRatio = tvl > 0 ? (volume24h / tvl) : 0;

  // Deteksi kondisi market dari bin step & fee rate
  const isHighVolatility = binStep >= 20 || feeRate >= 0.2;
  const isLowVolatility = binStep <= 5 && feeRate < 0.05;
  const isStable = poolInfo.tokenYSymbol === 'USDC' || poolInfo.tokenYSymbol === 'USDT';
  const lowProductivity = (feeApr > 0 && feeApr < 30) || feeTvlDaily < 0.003;
  const weakFlow = volumeTvlRatio > 0 && volumeTvlRatio < 0.5;
  const overheatedFlow = volumeTvlRatio > 6;

  // Validasi mismatch strategi vs kondisi
  if (strategyType === 'curve' && isHighVolatility) {
    warnings.push(`⚠️ Strategi CURVE tidak cocok untuk pool high-volatility (bin step: ${binStep}). Posisi akan cepat keluar range.`);
    recommendation = 'bid_ask';
  }

  if (strategyType === 'bid_ask' && isStable && isLowVolatility) {
    warnings.push(`⚠️ Strategi BID-ASK kurang optimal untuk stable pool. Fee yang dikumpulkan akan lebih sedikit.`);
    recommendation = 'spot';
  }

  if (strategyType === 'spot' && isHighVolatility) {
    warnings.push(`⚠️ Strategi SPOT pada pool high-volatility berisiko cepat out of range.`);
    recommendation = 'bid_ask';
  }

  if (!isStable && lowProductivity) {
    warnings.push(`⚠️ Pool kurang produktif untuk DLMM LP aktif (fee APR ${feeApr.toFixed(1)}%, fee/TVL harian ${(feeTvlDaily * 100).toFixed(2)}%).`);
  }

  if (!isStable && weakFlow) {
    warnings.push(`⚠️ Flow trader lemah (Volume/TVL ${volumeTvlRatio.toFixed(2)}x). Fee bisa tidak cukup menutup directional bleed.`);
  }

  if (strategyType !== 'bid_ask' && overheatedFlow) {
    warnings.push(`⚠️ Flow trader terlalu panas (Volume/TVL ${volumeTvlRatio.toFixed(2)}x). Untuk DLMM, range sempit rawan cepat disapu.`);
    recommendation = 'bid_ask';
  }

  if (warnings.length === 0) {
    return { valid: true, warning: null, recommendation: strategyType };
  }

  return {
    valid: false,
    warning: warnings.join('\n'),
    recommendation,
  };
}

// ─── Check 4: Konfirmasi Telegram ────────────────────────────────

/**
 * Kirim konfirmasi ke Telegram dan tunggu reply
 * @param {function} notifyFn - fungsi untuk kirim pesan Telegram
 * @param {object} bot - Telegram bot instance
 * @param {number} allowedId - Telegram user ID
 * @param {string} message - pesan konfirmasi
 * @param {number} timeoutMs - timeout dalam ms (default 5 menit)
 * @returns {Promise<boolean>} - true jika dikonfirmasi, false jika ditolak/timeout
 */
export function requestConfirmation(notifyFn, bot, allowedId, message, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    // Gunakan 4 digit terakhir dari timestamp untuk ID pendek tapi unik per session
    const id = Date.now() % 10000;
    const confirmId = `confirm_${id}`;

    // Kirim pesan konfirmasi
    notifyFn(
      `🔔 <b>Konfirmasi Diperlukan</b> (ID: ${id})\n\n${message}\n\n` +
      `Balas dengan:\n` +
      `✅ <code>ya ${id}</code> — untuk konfirmasi\n` +
      `❌ <code>tidak ${id}</code> — untuk batalkan\n\n` +
      `<i>Timeout dalam 5 menit</i>`
    );

    // Set timeout
    const timeout = setTimeout(() => {
      if (pendingConfirmations.has(confirmId)) {
        pendingConfirmations.delete(confirmId);
        notifyFn(`⏰ <b>Konfirmasi ID ${id} timeout</b> — <i>aksi dibatalkan otomatis.</i>`, { parse_mode: 'HTML' });
        resolve(false);
      }
    }, timeoutMs);

    pendingConfirmations.set(confirmId, { resolve, timeout, id });
  });
}

/**
 * Handle reply konfirmasi dari Telegram
 * Dipanggil dari message handler di index.js
 * @returns {boolean} - true jika pesan adalah reply konfirmasi
 */
export function handleConfirmationReply(text) {
  if (!text) return false;

  const yaMatch = text.match(/^ya\s+(\d+)$/i);
  const tidakMatch = text.match(/^tidak\s+(\d+)$/i);

  if (yaMatch) {
    const id = parseInt(yaMatch[1]);
    const confirmId = `confirm_${id}`;
    if (pendingConfirmations.has(confirmId)) {
      const { resolve, timeout } = pendingConfirmations.get(confirmId);
      clearTimeout(timeout);
      pendingConfirmations.delete(confirmId);
      resolve(true);
      return true;
    }
  }

  if (tidakMatch) {
    const id = parseInt(tidakMatch[1]);
    const confirmId = `confirm_${id}`;
    if (pendingConfirmations.has(confirmId)) {
      const { resolve, timeout } = pendingConfirmations.get(confirmId);
      clearTimeout(timeout);
      pendingConfirmations.delete(confirmId);
      resolve(false);
      return true;
    }
  }

  return false;
}

export function hasPendingConfirmation() {
  return pendingConfirmations.size > 0;
}

// ─── Safety Status ───────────────────────────────────────────────

export function getSafetyStatus() {
  const cfg = getConfig();
  const drawdown = checkMaxDrawdown();
  const pnl = getDailyPnl();

  return {
    frozen: drawdown.triggered,
    dailyPnlUsd: pnl.totalPnlUsd.toFixed(2),
    drawdownPct: drawdown.drawdownPct?.toFixed(2) ?? '0.00',
    startingBalanceUsd: pnl.startingBalanceUsd?.toFixed?.(2) ?? null,
    stopLossPct: cfg.stopLossPct ?? 5,
    maxDailyDrawdownPct: cfg.maxDailyDrawdownPct ?? 10,
    requireConfirmation: cfg.requireConfirmation ?? true,
    pendingConfirmations: pendingConfirmations.size,
  };
}
