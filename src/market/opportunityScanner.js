/**
 * Opportunity Scanner — monitors top pools setiap 15 menit
 *
 * Mendeteksi peluang strategi:
 *   Evil Panda — Supertrend 15m crossover ke atas
 *
 * Alert dikirim regardless posisi terbuka / balance / status deploy.
 * Cooldown 3 jam per pool per strategi untuk menghindari spam.
 */

import { getTopPools } from '../solana/meteora.js';
import { getOHLCV, getDLMMPoolData, getMultiTFScore } from './oracle.js';

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
        if (mtf.score < MIN_MULTITF_SCORE) continue;

        _cooldown.set(key, now);

        // Tambahkan multi-TF info ke reason
        const tfSummary = Object.entries(mtf.breakdown || {})
          .map(([tf, d]) => `${tf}:${d.bullish ? '✅' : '❌'}`)
          .join(' ');
        const enrichedReason = mtf.score > 0
          ? `${opp.reason} | TF: ${tfSummary} (${(mtf.score * 100).toFixed(0)}% bullish)`
          : opp.reason;

        await notifyFn(
          `🎯 <b>Opportunity Detected: ${opp.strategy}</b>\n\n` +
          `Pool: <code>${pool.address}</code>\n` +
          `Token: <code>${tokenMint}</code>\n` +
          `Priority: <b>${opp.priority}</b>\n\n` +
          `📊 ${enrichedReason}\n\n` +
          `<i>Scan otomatis — buka posisi manual atau tunggu Hunter Alpha.</i>`
        );

        await new Promise(r => setTimeout(r, 1200)); // anti-flood
      }

    } catch (e) {
      console.warn(`[Opp Scanner] Error scanning pool ${pool.address}:`, e.message);
    }
  }
}

function _detectOpportunities(pool, ohlcv, poolData) {
  const results = [];
  const trend = ohlcv.trend || 'SIDEWAYS';
  const priceChange1h = ohlcv.priceChange || 0;

  // ── Evil Panda — Momentum Proxy ───────────────
  if (EP_BIN_STEPS.has(pool.binStep) && trend === 'UPTREND' && priceChange1h > 3) {
    results.push({
      strategy: 'Evil Panda',
      reason:   `Bullish Momentum: Gain 1h ${priceChange1h.toFixed(1)}% | Trend ${trend}`,
      priority: 'HIGH',
    });
  }

  return results;
}
