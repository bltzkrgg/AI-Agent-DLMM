/**
 * Opportunity Scanner — monitors top pools setiap 15 menit
 *
 * Mendeteksi peluang dari 4 strategi:
 *   Evil Panda   — Supertrend 15m crossover ke atas
 *   Wave Enjoyer — Price dekat support + buyers masuk
 *   NPC          — Post-breakout consolidation + volume sustained
 *   Fee Sniper   — BB squeeze + fee APR tinggi
 *
 * Alert dikirim regardless posisi terbuka / balance / status deploy.
 * Cooldown 3 jam per pool per strategi untuk menghindari spam.
 */

import { getTopPools } from '../solana/meteora.js';
import { fetchCandles, getDLMMPoolData } from './oracle.js';
import {
  computeRSI,
  computeBollingerBands,
  computeSupertrend,
  computeVolumeVsAvg,
  detectEvilPandaSignals,
  calculateATR,
} from './taIndicators.js';
import { formatStrategyAlert } from '../utils/alerts.js';

// Cooldown state: Map<`${poolAddress}:${strategy}`, timestamp>
const _cooldown   = new Map();
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 jam
const EP_BIN_STEPS = new Set([80, 100, 125]);

// ─── Main scanner ────────────────────────────────────────────────

export async function runOpportunityScanner(notifyFn) {
  if (!notifyFn) return;

  let pools = [];
  try {
    pools = await getTopPools(25);
  } catch { return; }

  const now = Date.now();

  for (const pool of pools) {
    try {
      const tokenMint = pool.tokenX;
      if (!tokenMint) continue;

      // Fetch 15m candles — basis semua deteksi
      const candles = await fetchCandles(tokenMint, '15m', 100, pool.address);
      if (!candles || candles.length < 35) continue;

      // Compute TA dari candles
      const ta = _computeTA(candles);

      // Fetch pool fee data untuk Fee Sniper (best-effort)
      let poolData = null;
      try { poolData = await getDLMMPoolData(pool.address); } catch { /* optional */ }

      // Detect opportunities — rule-based, no LLM
      const opps = _detectOpportunities(pool, ta, poolData);

      for (const opp of opps) {
        const key = `${pool.address}:${opp.strategy}`;
        const last = _cooldown.get(key);
        if (last && (now - last) < COOLDOWN_MS) continue;

        _cooldown.set(key, now);

        await notifyFn(formatStrategyAlert({
          strategy:    opp.strategy,
          pool:        pool.name || null,
          poolAddress: pool.address,
          reason:      opp.reason,
          priority:    opp.priority,
        }));

        await new Promise(r => setTimeout(r, 1200)); // anti-flood
      }

    } catch { /* skip pool — jangan crash scanner */ }
  }
}

// ─── TA computation dari raw candles ─────────────────────────────

function _computeTA(candles) {
  const closes = candles.map(c => c.c);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);

  const currentPrice = closes[closes.length - 1];
  const last96       = candles.slice(-96);
  const high24h      = Math.max(...last96.map(c => c.h));
  const low24h       = Math.min(...last96.map(c => c.l));
  const range24hPct  = low24h > 0
    ? parseFloat(((high24h - low24h) / low24h * 100).toFixed(2)) : 0;

  const recent20 = closes.slice(-20);
  const prior20  = closes.slice(-40, -20);
  let trend = 'SIDEWAYS';
  if (prior20.length >= 10) {
    const rA = recent20.reduce((a, b) => a + b, 0) / recent20.length;
    const pA = prior20.reduce((a, b) => a + b, 0)  / prior20.length;
    const chg = pA > 0 ? (rA - pA) / pA * 100 : 0;
    if (chg > 2)  trend = 'UPTREND';
    if (chg < -2) trend = 'DOWNTREND';
  }

  const atr      = calculateATR(candles, 14);
  const rsi14    = computeRSI(closes, 14);
  const bb       = computeBollingerBands(closes, 20, 2);
  const st       = computeSupertrend(highs, lows, closes, 10, 3);
  const ep       = detectEvilPandaSignals(candles);
  const volVsAvg = computeVolumeVsAvg(candles);

  return {
    currentPrice, high24h, low24h, range24hPct, trend,
    atr, rsi14, bb, supertrend: st, evilPanda: ep,
    volumeVsAvg: volVsAvg,
    support:    low24h,
    resistance: high24h,
  };
}

// ─── Opportunity detection — rule-based ──────────────────────────

function _detectOpportunities(pool, ta, poolData) {
  const results = [];
  const {
    currentPrice, support, range24hPct, trend,
    atr, rsi14, bb, supertrend: st, evilPanda: ep,
    volumeVsAvg,
  } = ta;

  const atrPct = atr?.atrPct ?? 0;
  const feeApr = poolData?.feeApr
    ?? parseFloat(String(pool.apr || '0').replace('%', ''))
    ?? 0;

  // ── Evil Panda — Supertrend 15m fresh crossover ───────────────
  if (ep?.entry?.triggered && EP_BIN_STEPS.has(pool.binStep)) {
    results.push({
      strategy: 'Evil Panda',
      reason:   ep.entry.reason || 'Supertrend 15m baru cross ke atas',
      priority: 'HIGH',
    });
  }

  // ── Wave Enjoyer — price dekat support + buyers masuk ─────────
  if (support > 0 && currentPrice > 0) {
    const distPct     = ((currentPrice - support) / support) * 100;
    const nearSupport = distPct >= 0 && distPct <= 8;
    const rsiZone     = rsi14 !== null && rsi14 >= 35 && rsi14 <= 62;
    const volOk       = volumeVsAvg >= 0.7;

    if (nearSupport && rsiZone && volOk) {
      results.push({
        strategy: 'Wave Enjoyer',
        reason:   `Price ${distPct.toFixed(1)}% di atas support 24h | RSI14=${rsi14?.toFixed(0)} | Vol=${(volumeVsAvg * 100).toFixed(0)}% avg`,
        priority: 'MEDIUM',
      });
    }
  }

  // ── NPC — post-breakout consolidation ─────────────────────────
  const postBreakout  = range24hPct >= 15;
  const consolidating = atrPct > 0 && atrPct < range24hPct * 0.12;
  const trendOk       = trend !== 'DOWNTREND';
  const stBullish     = st?.isBullish !== false;

  if (postBreakout && consolidating && trendOk && stBullish && volumeVsAvg >= 0.9) {
    results.push({
      strategy: 'NPC',
      reason:   `Post-breakout: 24h range=${range24hPct.toFixed(1)}% → ATR kini ${atrPct.toFixed(2)}% (${range24hPct > 0 ? ((atrPct / range24hPct) * 100).toFixed(0) : '-'}% dari range)`,
      priority: 'LOW',
    });
  }

  // ── Fee Sniper — BB squeeze + fee APR tinggi ──────────────────
  const bbTight    = bb !== null && bb.bandwidth < 8;
  const atrLow     = atrPct < 2;
  const highFee    = feeApr > 200;
  const volSustain = volumeVsAvg >= 0.6;

  if (bbTight && atrLow && highFee && volSustain) {
    results.push({
      strategy: 'Fee Sniper',
      reason:   `BB width=${bb.bandwidth.toFixed(1)}% (squeeze) | ATR=${atrPct.toFixed(2)}% | Fee APR ${feeApr.toFixed(0)}%`,
      priority: 'MEDIUM',
    });
  }

  return results;
}
