import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const METEORA_DATAPI   = 'https://dlmm.datapi.meteora.ag';

// ─── 1. OHLCV — Price Snapshot (DexScreener) ────────────────────
// Rerouted to DexScreener as the primary source for price/volatility logic.
// Advanced TA (MACD/RSI) is removed as it required historical candles from GeckoTerminal.

export async function getOHLCV(tokenMint, poolAddress = null) {
  return buildOHLCVFromDexScreener(tokenMint);
}

// ─── 2. On-Chain Signals (Helius) ────────────────────────────────
// Kept for инфраструкura (metadata, priority fees), but market signals (whale risk) 
// are now simplified or derived from allowed sources.

export async function getOnChainSignals(tokenMint) {
  return getHeliusOnChainSignals(tokenMint);
}

// ─── 3. DLMM Pool Data (Meteora datapi) ─────────────────────────

export async function getDLMMPoolData(poolAddress) {
  try {
    const res = await fetchWithTimeout(
      `${METEORA_DATAPI}/pools/${poolAddress}`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!res.ok) return null;
    const pool = await res.json();

    const fees24h     = safeNum(pool.fees?.['24h']  ?? pool.fees_24h ?? 0);
    const volume24h   = safeNum(pool.volume?.['24h'] ?? pool.trade_volume_24h ?? 0);
    const tvl         = safeNum(pool.tvl ?? pool.liquidity ?? 0);
    const feeApr      = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep     = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    const feeAprCategory = feeApr >= 100 ? 'HIGH' : feeApr >= 30 ? 'MEDIUM' : 'LOW';

    return {
      address: poolAddress, name: pool.name || '',
      tvl, volume24h, fees24h,
      feeApr: parseFloat(feeApr.toFixed(2)), feeAprCategory,
      feeTvlRatio: parseFloat(feeTvlRatio.toFixed(4)),
      binStep,
      tokenXMint: pool.token_x?.address || null,
      tokenYMint: pool.token_y?.address || null,
    };
  } catch { return null; }
}

// ─── 4. DexScreener — Sentiment & Momentum ──────────────────────

export async function getSentiment(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];
    const txns = best.txns?.h24 || {};
    const buys = safeNum(txns.buys), sells = safeNum(txns.sells);
    const total = buys + sells;
    const buyPressurePct = total > 0 ? safeNum((buys / total * 100).toFixed(1)) : 50;
    
    return {
      tokenSymbol:    best.baseToken?.symbol || '',
      priceUsd:       safeNum(best.priceUsd),
      priceChange1h:  safeNum(best.priceChange?.h1),
      priceChange6h:  safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      liquidityUsd:   safeNum(best.liquidity?.usd),
      buys24h: buys, sells24h: sells, buyPressurePct,
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
    };
  } catch { return null; }
}

// ─── OHLCV Build helper ──────────────────────────────────────────

async function buildOHLCVFromDexScreener(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];

    const currentPrice   = safeNum(best.priceUsd);
    const priceChangeM5  = safeNum(best.priceChange?.m5);
    const priceChange1h  = safeNum(best.priceChange?.h1);
    const priceChange6h  = safeNum(best.priceChange?.h6);
    const priceChange24h = safeNum(best.priceChange?.h24);
    const volume24h      = safeNum(best.volume?.h24);
    const range24hPct    = Math.abs(priceChange24h);

    const high24h = currentPrice / (1 - Math.max(0, priceChange24h) / 100) || currentPrice;
    const low24h  = currentPrice / (1 + Math.max(0, -priceChange24h) / 100) || currentPrice;

    // Adaptive Trend derived from m5 (short) vs h1 (medium) price changes
    // Bulllish if m5 is pumping (>1.5%) AND h1 is at least stable or uptrend
    const trend = (priceChangeM5 > 1.5 && priceChange1h > 0) ? 'UPTREND'
      : (priceChangeM5 < -1.5 && priceChange1h < 0) ? 'DOWNTREND'
      : (priceChangeM5 > 3) ? 'PUMPING' // Extreme short term momentum
      : 'SIDEWAYS';

    return {
      tokenMint,
      timeframe:      'snapshot',
      source:         'dexscreener',
      currentPrice,
      priceChangeM5,
      priceChangeH1:  priceChange1h,
      high24h, low24h,
      range24hPct:    parseFloat(range24hPct.toFixed(2)),
      avgVolume:      parseFloat((volume24h / 24).toFixed(2)),
      latestVolume:   parseFloat((volume24h / 24).toFixed(2)),
      trend,
      suggestedBinStepMin: range24hPct > 20 ? 20 : range24hPct > 7 ? 10 : 5,
      volatilityCategory:  range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      ta: null,
      candleCount: 0,
    };
  } catch { return null; }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [ohlcvR, poolR, onChainR, sentimentR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
  ]);

  const ohlcv     = ohlcvR.status     === 'fulfilled' ? ohlcvR.value     : null;
  const pool      = poolR.status      === 'fulfilled' ? poolR.value      : null;
  const onChain   = onChainR.status   === 'fulfilled' ? onChainR.value   : null;
  const sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;

  // Simplified Health Score (using only allowed sources)
  let healthScore = 50;
  if (pool) {
    healthScore += pool.feeAprCategory === 'HIGH' ? 20 : pool.feeAprCategory === 'LOW' ? -20 : 0;
    healthScore += pool.feeTvlRatio > 0.05 ? 15 : pool.feeTvlRatio < 0.01 ? -10 : 0;
  }
  if (onChain?.available) {
    healthScore += onChain.whaleRisk === 'HIGH' ? -15 : onChain.whaleRisk === 'LOW' ? 5 : 0;
  }
  if (sentiment) {
    healthScore += sentiment.buyPressurePct > 60 ? 10 : sentiment.buyPressurePct < 40 ? -5 : 0;
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool, onChain, sentiment,
    healthScore,
    ta:   ohlcv?.ta || null,
    dataSource: ohlcv?.source || 'unknown',
    price: sentiment ? {
      currentPrice: sentiment.priceUsd,
      trend: ohlcv?.trend || 'SIDEWAYS',
      volatility24h: ohlcv?.range24hPct || 0,
      volatilityCategory: ohlcv?.volatilityCategory || 'MEDIUM',
      buyPressurePct: sentiment.buyPressurePct,
      sentiment: sentiment.sentiment,
    } : null,
  };
}

// ─── Helper functions (Legacy/Dummy) ─────────────────────────────
// Kept for backward compat but return empty data as candles are gone.

export async function fetchCandles() { return null; }
export async function getMultiTFScore() { return { score: 0.5, validCount: 0 }; }
export async function fetchMultiTFOHLCV() { return {}; }
export async function getOKXData() { return { available: false, reason: 'Source removed per consolidation' }; }
