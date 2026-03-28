/**
 * DLMM Oracle — data khusus untuk DLMM LP decisions
 *
 * Fokus: kondisi pool DLMM, bukan futures/trading indicators.
 * Data yang relevan untuk LP:
 *   - Fee APR dan fee velocity (seberapa cepat fee terkumpul)
 *   - Volume/TVL ratio (aktivitas trader di pool)
 *   - Arah harga + volatilitas (untuk pilih strategi dan range)
 *   - Buy/sell pressure (tren jangka pendek)
 *
 * DIHAPUS (tidak relevan untuk DLMM LP):
 *   - OHLCV candles & candlestick patterns (futures)
 *   - Whale tracking / on-chain holder analysis (futures)
 *   - Smart money signals / OKX (futures)
 */

import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';

const DEXSCREENER_BASE   = 'https://api.dexscreener.com';
const METEORA_DATAPI     = 'https://dlmm.datapi.meteora.ag';

// ─── DLMM Pool Data (Meteora datapi) ────────────────────────────

export async function getDLMMPoolData(poolAddress) {
  try {
    const res = await fetchWithTimeout(
      `${METEORA_DATAPI}/pools/${poolAddress}`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!res.ok) return null;
    const pool = await res.json();

    const fees24h   = safeNum(pool.fees?.['24h']   ?? pool.fees_24h ?? 0);
    const fees7d    = safeNum(pool.fees?.['7d']     ?? pool.fees_7d  ?? 0);
    const volume24h = safeNum(pool.volume?.['24h']  ?? pool.trade_volume_24h ?? 0);
    const tvl       = safeNum(pool.tvl              ?? pool.liquidity ?? 0);
    const feeApr    = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep   = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    // APR category untuk keputusan LP
    const feeAprCategory =
      feeApr >= 100 ? 'HIGH'   :
      feeApr >= 30  ? 'MEDIUM' : 'LOW';

    // Fee velocity trend: bandingkan fee 24h vs rata-rata 7d
    const avgDaily7d    = fees7d > 0 ? fees7d / 7 : 0;
    const feeVelocity   =
      avgDaily7d > 0 && fees24h > avgDaily7d * 1.2 ? 'INCREASING' :
      avgDaily7d > 0 && fees24h < avgDaily7d * 0.8 ? 'DECREASING' : 'STABLE';

    return {
      address:        poolAddress,
      name:           pool.name || '',
      tvl,
      volume24h,
      fees24h,
      feeApr:         parseFloat(feeApr.toFixed(2)),
      feeAprCategory,
      feeTvlRatio:    parseFloat(feeTvlRatio.toFixed(4)),
      feeVelocity,
      binStep,
      tokenXMint:     pool.token_x?.address || null,
      tokenYMint:     pool.token_y?.address || null,
    };
  } catch {
    return null;
  }
}

// ─── Price & Direction (DexScreener) ────────────────────────────
// Untuk menentukan: arah harga, volatilitas, apakah range masih valid

export async function getPriceData(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`,
      {},
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;

    const best = pairs.sort(
      (a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd)
    )[0];

    const txns = best.txns?.h24 || {};
    const buys  = safeNum(txns.buys);
    const sells = safeNum(txns.sells);
    const total = buys + sells;
    const buyPressurePct = total > 0 ? safeNum((buys / total * 100).toFixed(1)) : 50;

    const priceChange1h  = safeNum(best.priceChange?.h1  ?? 0);
    const priceChange6h  = safeNum(best.priceChange?.h6  ?? 0);
    const priceChange24h = safeNum(best.priceChange?.h24 ?? 0);

    // Volatilitas dari 24h range — relevan untuk pilih bin step dan range width
    const priceHigh = safeNum(best.priceMax24h ?? 0);
    const priceLow  = safeNum(best.priceMin24h ?? 0);
    const volatility24h =
      (priceHigh > 0 && priceLow > 0)
        ? safeNum(((priceHigh - priceLow) / priceLow * 100).toFixed(2))
        : Math.abs(priceChange24h);

    const volatilityCategory =
      volatility24h > 20 ? 'HIGH'   :
      volatility24h > 7  ? 'MEDIUM' : 'LOW';

    // Arah harga — untuk pilih strategi (single-side vs balanced)
    const trend =
      priceChange6h > 3  && priceChange1h > 0 ? 'UPTREND'   :
      priceChange6h < -3 && priceChange1h < 0 ? 'DOWNTREND' : 'SIDEWAYS';

    // Bin step fit: volatilitas tinggi perlu bin step lebih besar
    // (akan di-resolve saat match strategy)
    const suggestedBinStepMin =
      volatilityCategory === 'HIGH'   ? 20 :
      volatilityCategory === 'MEDIUM' ? 10 : 5;

    return {
      tokenMint,
      currentPrice:     safeNum(best.priceUsd),
      priceChange1h,
      priceChange6h,
      priceChange24h,
      volatility24h,
      volatilityCategory,
      trend,
      buyPressurePct,
      buys24h:          buys,
      sells24h:         sells,
      sentiment:        buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
      suggestedBinStepMin,
    };
  } catch {
    return null;
  }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────
// Menggantikan getMarketSnapshot — fokus ke DLMM LP metrics

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [poolResult, priceResult] = await Promise.allSettled([
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getPriceData(tokenMint),
  ]);

  const pool  = poolResult.status  === 'fulfilled' ? poolResult.value  : null;
  const price = priceResult.status === 'fulfilled' ? priceResult.value : null;

  // Derived DLMM health score (0-100)
  let healthScore = 50;
  if (pool) {
    if (pool.feeAprCategory === 'HIGH')   healthScore += 20;
    if (pool.feeAprCategory === 'LOW')    healthScore -= 20;
    if (pool.feeVelocity === 'INCREASING') healthScore += 15;
    if (pool.feeVelocity === 'DECREASING') healthScore -= 15;
    if (pool.feeTvlRatio > 0.05)          healthScore += 10;
    if (pool.feeTvlRatio < 0.01)          healthScore -= 10;
  }
  if (price) {
    if (price.sentiment === 'BULLISH') healthScore += 5;
    if (price.sentiment === 'BEARISH') healthScore -= 5;
  }
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    tokenMint,
    poolAddress,
    timestamp: new Date().toISOString(),
    pool,
    price,
    healthScore,
    // Backward-compat fields untuk matchStrategyToMarket di strategyLibrary.js
    ohlcv: price ? {
      trend:       price.trend,
      volumeVsAvg: pool ? (pool.feeTvlRatio / 0.02) : 1.0, // normalize ke rata-rata
      high24h:     price.currentPrice * (1 + price.volatility24h / 100),
      low24h:      price.currentPrice * (1 - price.volatility24h / 100),
    } : null,
    liquidity: pool ? {
      tvl:       pool.tvl,
      volume24h: pool.volume24h,
      feeApr:    pool.feeApr,
    } : null,
    sentiment: price ? {
      buyPressurePct: price.buyPressurePct,
      sentiment:      price.sentiment,
    } : null,
  };
}
