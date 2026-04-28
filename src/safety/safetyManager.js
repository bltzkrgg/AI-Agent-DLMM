'use strict';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function getRiskPath() {
  return process.env.BOT_DAILY_RISK_PATH || join(process.cwd(), 'daily-risk-state.json');
}

function loadRisk() {
  const p = getRiskPath();
  if (!existsSync(p)) return { startingBalanceUsd: 0, totalPnlUsd: 0 };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { startingBalanceUsd: 0, totalPnlUsd: 0 }; }
}

function saveRisk(state) {
  writeFileSync(getRiskPath(), JSON.stringify(state, null, 2));
}

export function setStartingBalanceUsd(value) {
  const s = loadRisk();
  s.startingBalanceUsd = Number(value) || 0;
  saveRisk(s);
}

export function recordPnlUsd(value) {
  const s = loadRisk();
  s.totalPnlUsd = (Number(s.totalPnlUsd) || 0) + (Number(value) || 0);
  saveRisk(s);
}

export function getDailyPnl() {
  return loadRisk();
}

export function checkMaxDrawdown() {
  const s = loadRisk();
  const start = Number(s.startingBalanceUsd) || 0;
  const pnl = Number(s.totalPnlUsd) || 0;
  const drawdownPct = start > 0 ? Number(((pnl / start) * 100).toFixed(2)) : 0;
  return { triggered: drawdownPct <= -10, drawdownPct };
}

export function validateStrategyForMarket(strategy, data = {}) {
  const feeApr = Number(data.feeApr || 0);
  if (feeApr < 30) {
    return { valid: false, recommendation: 'spot', warning: 'Flow DLMM kurang produktif untuk fee saat ini' };
  }
  if (feeApr >= 150) {
    return { valid: false, recommendation: 'bid_ask', warning: 'Flow terlalu panas untuk mode spot biasa' };
  }
  return { valid: true, recommendation: strategy, warning: '' };
}

