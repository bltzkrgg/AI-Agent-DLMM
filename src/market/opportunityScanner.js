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
import { getOHLCV, getDLMMPoolData, getMultiTFScore } from './oracle.js';
import { formatStrategyAlert } from '../utils/alerts.js';

// Cooldown state: Map<`${poolAddress}:${strategy}`, timestamp>
const _cooldown   = new Map();
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 jam
const EP_BIN_STEPS = new Set([80, 100, 125]);

const MIN_MULTITF_SCORE = 0.4; // minimal 40% TF bullish

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

      // Fetch consolidated OHLCV snapshot
      const ohlcv = await getOHLCV(tokenMint, pool.address);
      if (!ohlcv) continue;

      // Fetch pool data in parallel (optional)
      const [poolData, mtf] = await Promise.all([
        getDLMMPoolData(pool.address).catch(() => null),
        getMultiTFScore(tokenMint, pool.address).catch(() => ({ score: 0, breakdown: {} })),
      ]);

      // Detect opportunities based on snapshot
      const opps = _detectOpportunities(pool, ohlcv, poolData);

      for (const opp of opps) {
        const key = `${pool.address}:${opp.strategy}`;
        const last = _cooldown.get(key);
        if (last && (now - last) < COOLDOWN_MS) continue;

        // Skip jika multi-TF score terlalu rendah (konfirmasi lemah)
        if (opp.strategy !== 'Fee Sniper' && mtf.score < MIN_MULTITF_SCORE) continue;

        _cooldown.set(key, now);

        // Tambahkan multi-TF info ke reason
        const tfSummary = Object.entries(mtf.breakdown || {})
          .map(([tf, d]) => `${tf}:${d.bullish ? '✅' : '❌'}`)
          .join(' ');
        const enrichedReason = mtf.score > 0
          ? `${opp.reason} | TF: ${tfSummary} (${(mtf.score * 100).toFixed(0)}% bullish)`
          : opp.reason;

        await notifyFn(formatStrategyAlert({
          strategy:    opp.strategy,
          pool:        pool.name || null,
          poolAddress: pool.address,
          reason:      enrichedReason,
          priority:    mtf.score >= 0.67 ? 'HIGH' : opp.priority,
        }));

        await new Promise(r => setTimeout(r, 1200)); // anti-flood
      }

    } catch (e) {
      console.warn(`[Opp Scanner] Error scanning pool ${pool.address}:`, e.message);
    }
  }
}

function _detectOpportunities(pool, ohlcv, poolData) {
  const results = [];
  const currentPrice = ohlcv.currentPrice || 0;
  const low24h = ohlcv.low24h || 0;
  const high24h = ohlcv.high24h || 0;
  const range24hPct = ohlcv.range24hPct || 0;
  const trend = ohlcv.trend || 'SIDEWAYS';
  const priceChange1h = ohlcv.priceChange || 0;
  const latestVol = ohlcv.latestVolume || 0;
  const avgVol = ohlcv.avgVolume || 0;

  const feeApr = poolData?.feeApr
    ?? parseFloat(String(pool.apr || '0').replace('%', ''))
    ?? 0;

  // ── Evil Panda — Momentum Proxy ───────────────
  if (EP_BIN_STEPS.has(pool.binStep) && trend === 'UPTREND' && priceChange1h > 3) {
    results.push({
      strategy: 'Evil Panda',
      reason:   `Bullish Momentum: Gain 1h ${priceChange1h.toFixed(1)}% | Trend ${trend}`,
      priority: 'HIGH',
    });
  }

  // ── Wave Enjoyer — near 24h low proxy ─────────
  if (low24h > 0 && currentPrice > 0) {
    const distPct = ((currentPrice - low24h) / low24h) * 100;
    const nearLow = distPct >= 0 && distPct <= 8;
    const volOk = latestVol >= avgVol * 0.7;

    if (nearLow && (trend === 'SIDEWAYS' || trend === 'DOWNTREND') && volOk) {
      results.push({
        strategy: 'Wave Enjoyer',
        reason:   `Price ${distPct.toFixed(1)}% di atas support 24h | Vol=${(latestVol/avgVol*100).toFixed(0)}% avg`,
        priority: 'MEDIUM',
      });
    }
  }

  // ── NPC — breakout/high range consolidation ─────────────────────────
  const postBreakout = range24hPct >= 15;
  const isCapping = priceChange1h > -2 && priceChange1h < 2; // consolidating in 1h
  
  if (postBreakout && isCapping && trend !== 'DOWNTREND') {
    results.push({
      strategy: 'NPC',
      reason:   `Post-breakout Consolidation: 24h range=${range24hPct.toFixed(1)}% | 1h Stable`,
      priority: 'LOW',
    });
  }

  // ── Fee Sniper — Fee APR tinggi (Meteora Only) ──────────────────
  if (feeApr > 250 && latestVol >= avgVol * 0.6) {
    results.push({
      strategy: 'Fee Sniper',
      reason:   `High Yield Opportunity: Fee APR ${feeApr.toFixed(0)}% | Volume Sustained`,
      priority: 'MEDIUM',
    });
  }

  return results;
}
