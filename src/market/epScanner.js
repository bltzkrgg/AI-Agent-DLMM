/**
 * Evil Panda Scanner — monitors top pools setiap 15 menit
 *
 * Jika harga token baru menembus Supertrend 15m ke atas (justCrossedAbove),
 * kirim alert ke user dengan analisis chart, market, dan token lengkap.
 *
 * Cooldown: 4 jam per pool agar tidak spam.
 */

import { getTopPools } from '../solana/meteora.js';
import { fetchCandles, getDLMMPoolData, getSentiment } from './oracle.js';
import { detectEvilPandaSignals, calculateATR, calcDynamicRangePct } from './taIndicators.js';
import { kv, hr, codeBlock, shortAddr } from '../utils/table.js';

const _alertedPools   = new Map();   // poolAddress → last alert timestamp
const COOLDOWN_MS     = 4 * 60 * 60 * 1000; // 4 jam
const EP_BIN_STEPS    = new Set([80, 100, 125]); // bin step yang EP-eligible

export async function runEvilPandaScanner(notifyFn) {
  if (!notifyFn) return;

  let pools = [];
  try {
    pools = await getTopPools(30);
  } catch { return; }

  const now = Date.now();

  for (const pool of pools) {
    try {
      const tokenMint = pool.tokenX;
      if (!tokenMint) continue;

      // Filter: only EP-eligible bin steps
      const binStep = pool.binStep;
      if (binStep && !EP_BIN_STEPS.has(binStep)) continue;

      // Skip if recently alerted
      const lastAlert = _alertedPools.get(pool.address);
      if (lastAlert && (now - lastAlert) < COOLDOWN_MS) continue;

      // Fetch 15m candles
      const candles = await fetchCandles(tokenMint, '15m', 100, pool.address);
      if (!candles || candles.length < 35) continue;

      // Check Evil Panda entry signal (justCrossedAbove)
      const signals = detectEvilPandaSignals(candles);
      if (!signals?.entry?.triggered) continue;

      // Mark as alerted
      _alertedPools.set(pool.address, now);

      // Fetch supporting data in parallel
      const [poolDataRes, sentimentRes] = await Promise.allSettled([
        getDLMMPoolData(pool.address),
        getSentiment(tokenMint),
      ]);

      const pd  = poolDataRes.status  === 'fulfilled' ? poolDataRes.value  : null;
      const sen = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;
      const atr = calculateATR(candles, 14);

      const closes       = candles.map(c => c.c);
      const currentPrice = closes[closes.length - 1];
      const ep           = signals;

      // Estimate dynamic range for EP
      const rangePct = calcDynamicRangePct({
        atr14Pct:    atr?.atrPct      ?? 0,
        range24hPct: 0, // no 24h range here, use ATR only
        trend:       sen?.sentiment === 'BULLISH' ? 'UPTREND' : 'SIDEWAYS',
        bbBandwidth: ep.raw?.bb?.bandwidth ?? 0,
        strategyType: 'evil_panda',
      });

      // ── Build alert ──────────────────────────────────────────────
      const tokenName = pool.name?.replace('/SOL', '').trim() || shortAddr(tokenMint, 4, 4);

      const chartLines = [
        kv('Token',    tokenName, 10),
        kv('Pool',     shortAddr(pool.address), 10),
        kv('Harga',    currentPrice.toFixed(8), 10),
        hr(44),
        '📈 CHART (15m)',
        kv('Supertrend', 'CROSS ABOVE ✓ <- ENTRY', 12),
        kv('RSI14',      ep.raw?.supertrend ? (ep.raw?.rsi2?.toFixed(1) ?? '-') + ' (RSI2)' : '-', 12),
        kv('BB %B',      ep.raw?.bb ? ep.raw.bb.percentB.toFixed(0) + '%  W=' + ep.raw.bb.bandwidth.toFixed(1) : '-', 12),
        kv('MACD',       ep.raw?.macd?.histogram > 0 ? '+' + ep.raw.macd.histogram.toFixed(8) : (ep.raw?.macd?.histogram?.toFixed(8) ?? '-'), 12),
        hr(44),
        '🌊 MARKET',
        kv('Sentiment', sen ? sen.sentiment + ' (' + sen.buyPressurePct + '% buy)' : '-', 12),
        kv('Trend',     sen?.sentiment || '-', 12),
        hr(44),
        '💧 POOL',
        kv('TVL',       pd ? (pd.tvl >= 1e6 ? '$' + (pd.tvl/1e6).toFixed(2)+'M' : '$' + (pd.tvl/1e3).toFixed(1)+'K') : (pool.tvlStr || '-'), 12),
        kv('Fee APR',   pd ? pd.feeApr + '%  ' + pd.feeAprCategory : '-', 12),
        kv('BinStep',   String(binStep || '-'), 12),
        kv('Vol24h',    pool.volume24h || '-', 12),
        hr(44),
        '⚡ REKOMENDASI',
        kv('Strategy',  'Evil Panda', 12),
        kv('Range Est', '~' + rangePct.toFixed(1) + '% (ATR-based)', 12),
        kv('ATR 15m',   atr ? atr.atrPct.toFixed(3) + '%  ' + atr.atrCategory : '-', 12),
      ];

      const alertMsg =
        `🐼 *EVIL PANDA ALERT*\n\n` +
        codeBlock(chartLines) + '\n\n' +
        `💭 _${ep.entry.reason}_\n\n` +
        `👉 Ketik /hunt untuk deploy sekarang`;

      await notifyFn(alertMsg);

      // Delay antar alert agar tidak flood
      await new Promise(r => setTimeout(r, 1500));

    } catch { /* skip pool jika error — jangan crash scanner */ }
  }
}
