'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { getRuntimeCollectionItem, updateRuntimeCollectionItem } from '../runtime/state.js';

function readMemory() {
  const path = process.env.BOT_MEMORY_PATH;
  if (!path || !existsSync(path)) return { closedTrades: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { closedTrades: [] }; }
}

export async function evaluateStrategyReadiness({
  strategyName = 'Evil Panda',
  activeBinId = null,
  snapshot = {},
} = {}) {
  const blockers = [];
  const poolAddr = snapshot?.poolAddress || 'unknown-pool';
  const feeTvlRatio = Number(snapshot?.pool?.feeTvlRatio || 0);
  const priceChangeM5 = Number(snapshot?.ohlcv?.priceChangeM5 || 0);
  const historyAgeMinutes = Number(snapshot?.ohlcv?.historyAgeMinutes || 0);
  const trend = String(snapshot?.ta?.supertrend?.trend || 'NEUTRAL').toUpperCase();

  if (historyAgeMinutes > 180) {
    blockers.push('Data candle stale');
  }

  if (feeTvlRatio < 0.01) {
    blockers.push('Fee/TVL harian terlalu rendah');
  }

  const feeSamples = updateRuntimeCollectionItem('strategy-fee-samples', poolAddr, (curr) => {
    const arr = Array.isArray(curr) ? curr : [];
    arr.push(feeTvlRatio);
    return arr.slice(-3);
  }) || [];

  if (feeSamples.length >= 3 && feeSamples[0] > feeSamples[1] && feeSamples[1] > feeSamples[2]) {
    blockers.push('Fee velocity melemah');
  }

  const memory = readMemory();
  const badRegime = (memory.closedTrades || []).filter((t) =>
    t?.strategy === strategyName &&
    t?.profitable === false &&
    String(t?.marketAtEntry?.trend || '').toUpperCase() === 'UPTREND' &&
    String(t?.volatility || '').toUpperCase() === 'MEDIUM'
  );
  if (badRegime.length >= 3) {
    blockers.push('Regime memory warning');
  }

  if (trend !== 'BULLISH') blockers.push('Supertrend belum bullish');
  if (priceChangeM5 <= 0) blockers.push('Momentum 5m belum hijau');

  return {
    ok: blockers.length === 0,
    blockers,
    meta: { strategyName, activeBinId },
  };
}

export function classifyMarketRegime(snapshot = {}) {
  const trend = String(snapshot?.ta?.supertrend?.trend || '').toUpperCase();
  const h1 = Number(snapshot?.ohlcv?.priceChangeH1 || 0);
  const atr = Number(snapshot?.ohlcv?.atrPct || 0);
  if (trend !== 'BULLISH' && h1 < -1) {
    return { regime: 'BEAR_DEFENSE', blocked: true };
  }
  if (atr > 25) {
    return { regime: 'BEAR_DEFENSE', blocked: true };
  }
  return { regime: 'NEUTRAL', blocked: false };
}
