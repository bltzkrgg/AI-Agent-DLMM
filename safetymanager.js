/**
 * Safety Manager
 * 
 * 4 mekanisme:
 * 1. Stop-loss per posisi — close kalau rugi > X%
 * 2. Max drawdown harian — freeze semua kalau rugi > X% dalam sehari
 * 3. Validasi strategi vs kondisi market
 * 4. Konfirmasi Telegram sebelum deploy
 */

import { getConfig, updateConfig } from '../config.js';

// ─── State ───────────────────────────────────────────────────────

// Track PnL harian — reset tiap tengah malam
let dailyPnl = { date: getTodayStr(), totalPnlUsd: 0, startingBalance: null };

// Pending confirmations — key: confirmationId, value: { resolve, reject, timeout }
const pendingConfirmations = new Map();
let confirmationCounter = 0;

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Daily PnL Tracking ──────────────────────────────────────────

export function recordPnl(pnlUsd) {
  const today = getTodayStr();
  if (dailyPnl.date !== today) {
    // Reset tiap hari baru
    dailyPnl = { date: today, totalPnlUsd: 0, startingBalance: null };
  }
  dailyPnl.totalPnlUsd += pnlUsd;
}

export function getDailyPnl() {
  const today = getTodayStr();
  if (dailyPnl.date !== today) {
    dailyPnl = { date: today, totalPnlUsd: 0, startingBalance: null };
  }
  return dailyPnl;
}

export function setStartingBalance(balanceSol) {
  const today = getTodayStr();
  if (dailyPnl.date !== today) {
    dailyPnl = { date: today, totalPnlUsd: 0, startingBalance: balanceSol };
  } else if (!dailyPnl.startingBalance) {
    dailyPnl.startingBalance = balanceSol;
  }
}

// ─── Check 1: Stop-Loss Per Posisi ──────────────────────────────

/**
 * Cek apakah posisi harus di-stop-loss
 * @param {object} position - position data dari on-chain
 * @returns {{ triggered: boolean, reason: string }}
 */
export function checkStopLoss(position) {
  const cfg = getConfig();
  const stopLossPct = cfg.stopLossPct ?? 5; // default 5%

  // Cek dari PnL API data jika tersedia
  const pnlPct = position.pnlPct ?? position.feePctOfDeployed ?? null;
  if (pnlPct === null) return { triggered: false, reason: 'No PnL data available' };

  // pnlPct negatif artinya rugi
  if (pnlPct < -stopLossPct) {
    return {
      triggered: true,
      reason: `Stop-loss triggered: PnL ${pnlPct.toFixed(2)}% melewati threshold -${stopLossPct}%`,
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
  const maxDrawdownPct = cfg.maxDailyDrawdownPct ?? 10; // default 10%
  const deployAmountSol = cfg.deployAmountSol ?? 0.5;

  const pnl = getDailyPnl();

  // Estimasi modal harian berdasarkan deployAmountSol × harga SOL ~$150
  const estimatedCapitalUsd = (cfg.maxPositions ?? 3) * deployAmountSol * 150;
  const drawdownPct = (pnl.totalPnlUsd / estimatedCapitalUsd) * 100;

  if (drawdownPct < -maxDrawdownPct) {
    return {
      triggered: true,
      reason: `⛔ Max drawdown harian tercapai: ${drawdownPct.toFixed(2)}% (threshold: -${maxDrawdownPct}%). Semua aktivitas dibekukan hari ini.`,
      dailyPnlUsd: pnl.totalPnlUsd,
      drawdownPct,
    };
  }

  return {
    triggered: false,
    reason: null,
    dailyPnlUsd: pnl.totalPnlUsd,
    drawdownPct,
  };
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

  // Deteksi kondisi market dari bin step & fee rate
  const isHighVolatility = binStep >= 20 || feeRate >= 0.2;
  const isLowVolatility = binStep <= 5 && feeRate < 0.05;
  const isStable = poolInfo.tokenYSymbol === 'USDC' || poolInfo.tokenYSymbol === 'USDT';

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
    const id = ++confirmationCounter;
    const confirmId = `confirm_${id}`;

    // Kirim pesan konfirmasi
    notifyFn(
      `🔔 *Konfirmasi Diperlukan* (ID: ${id})\n\n${message}\n\n` +
      `Balas dengan:\n` +
      `✅ \`ya ${id}\` — untuk konfirmasi\n` +
      `❌ \`tidak ${id}\` — untuk batalkan\n\n` +
      `_Timeout dalam 5 menit_`
    );

    // Set timeout
    const timeout = setTimeout(() => {
      if (pendingConfirmations.has(confirmId)) {
        pendingConfirmations.delete(confirmId);
        notifyFn(`⏰ Konfirmasi ID ${id} timeout — aksi dibatalkan.`);
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
    stopLossPct: cfg.stopLossPct ?? 5,
    maxDailyDrawdownPct: cfg.maxDailyDrawdownPct ?? 10,
    requireConfirmation: cfg.requireConfirmation ?? true,
    pendingConfirmations: pendingConfirmations.size,
  };
}
