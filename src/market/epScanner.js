/**
 * Evil Panda Scanner — monitors top pools setiap 15 menit
 *
 * Jika harga token baru menembus Supertrend 15m ke atas (justCrossedAbove),
 * kirim alert ke user dengan analisis chart, market, dan token lengkap.
 *
 * Cooldown: 4 jam per pool agar tidak spam.
 */

import { getTopPools } from '../solana/meteora.js';
import { getTopPools } from '../solana/meteora.js';
import { getOHLCV, getDLMMPoolData, getSentiment } from './oracle.js';
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

      // Fetch consolidated OHLCV snapshot (no candles)
      const ohlcv = await getOHLCV(tokenMint, pool.address);
      if (!ohlcv) continue;

      // Momentum-based Evil Panda Signal (Proxy for Supertrend break)
      const isBullishMomentum = ohlcv.trend === 'UPTREND' && ohlcv.priceChange > 3;
      if (!isBullishMomentum) continue;

      // Mark as alerted
      _alertedPools.set(pool.address, now);

      // Fetch supporting pool data
      const pd = await getDLMMPoolData(pool.address).catch(() => null);

      // ── Build alert ──────────────────────────────────────────────
      const tokenName = pool.name?.replace('/SOL', '').trim() || shortAddr(tokenMint, 4, 4);

      const chartLines = [
        kv('Token',    tokenName, 10),
        kv('Pool',     shortAddr(pool.address), 10),
        kv('Harga',    ohlcv.currentPrice?.toFixed(8) || '-', 10),
        hr(44),
        '📈 MOMENTUM (Consolidated)',
        kv('Trend',      ohlcv.trend || '-', 12),
        kv('Gain 1h',    (ohlcv.priceChange?.toFixed(2) || '0') + '%', 12),
        kv('Volatility', ohlcv.volatilityCategory || '-', 12),
        hr(44),
        '💧 POOL (Meteora)',
        kv('TVL',       pd ? (pd.tvl >= 1e6 ? '$' + (pd.tvl/1e6).toFixed(2)+'M' : '$' + (pd.tvl/1e3).toFixed(1)+'K') : (pool.tvlStr || '-'), 12),
        kv('Fee APR',   pd ? pd.feeApr + '%  ' + pd.feeAprCategory : '-', 12),
        kv('BinStep',   String(binStep || '-'), 12),
        kv('Vol24h',    pool.volume24h || '-', 12),
        hr(44),
        '⚡ REKOMENDASI',
        kv('Strategy',  'Evil Panda', 12),
        kv('Range Est', '~20-40% (Momentum-based)', 12),
      ];

      const alertMsg =
        `🐼 *EVIL PANDA MOMENTUM ALERT*\n\n` +
        codeBlock(chartLines) + '\n\n' +
        `💭 _Terdeteksi bullish momentum kuat: Trend ${ohlcv.trend} dengan kenaikan ${ohlcv.priceChange?.toFixed(1)}% dalam 1 jam._\n\n` +
        `👉 Ketik /hunt untuk deploy sekarang`;

      await notifyFn(alertMsg);

      // Delay antar alert agar tidak flood
      await new Promise(r => setTimeout(r, 1500));

    } catch (e) { 
      console.warn(`[EP Scanner] Error scanning pool ${pool.address}:`, e.message);
    }
  }
}

    } catch { /* skip pool jika error — jangan crash scanner */ }
  }
}
