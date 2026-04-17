import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import * as ta from '../utils/ta.js';
import { getPoolSmartMoney } from '../market/lpAgent.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const METEORA_DATAPI = 'https://dlmm-api.meteora.ag';

// ─── 1. OHLCV — Price Snapshot (DexScreener) ────────────────────
// Rerouted to DexScreener as the primary source for price/volatility logic.
// Oracle: OHLCV + TA dari DexScreener untuk Evil Panda entry/exit.

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

    const fees24h = safeNum(pool.fees?.['24h'] ?? pool.fees_24h ?? 0);
    const volume24h = safeNum(pool.volume?.['24h'] ?? pool.trade_volume_24h ?? 0);
    const tvl = safeNum(pool.tvl ?? pool.liquidity ?? 0);
    const feeApr = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    const feeAprCategory = feeApr >= 100 ? 'HIGH' : feeApr >= 30 ? 'MEDIUM' : 'LOW';

    // Heritage Awareness logic v76.0
    const createdAt = pool.created_at || pool.pool_created_at || new Date().toISOString();
    const ageDays = Math.max(0.1, (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
    
    // Konversi fees24h ke estimasi total seumur hidup (Konservatif: rata-rata harian adalah 60% dari 24h terakhir)
    const totalFeesEstimated = fees24h * (ageDays * 0.6);

    return {
      address: poolAddress, name: pool.name || '',
      tvl, volume24h, fees24h,
      feeApr: parseFloat(feeApr.toFixed(2)), feeAprCategory,
      feeTvlRatio: parseFloat(feeTvlRatio.toFixed(4)),
      binStep,
      tokenXMint: pool.token_x?.address || null,
      tokenYMint: pool.token_y?.address || null,
      createdAt,
      totalFeesEstimated: parseFloat(totalFeesEstimated.toFixed(2)),
      poolAgeDays: parseFloat(ageDays.toFixed(2)),
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
      tokenSymbol: best.baseToken?.symbol || '',
      priceUsd: safeNum(best.priceUsd),
      priceChange1h: safeNum(best.priceChange?.h1),
      priceChange6h: safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      liquidityUsd: safeNum(best.liquidity?.usd),
      buys24h: buys, sells24h: sells, buyPressurePct,
      fdv: safeNum(best.fdv),
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
    };
  } catch { return null; }
}

// ─── OHLCV Build helper ──────────────────────────────────────────

async function buildOHLCVFromDexScreener(tokenMint, poolAddress = null) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;

    // Use matching pool if provided, else best liquidity
    const best = poolAddress
      ? (pairs.find(p => p.pairAddress === poolAddress) || pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0])
      : pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];

    const currentPrice = safeNum(best.priceUsd);
    const priceChangeM5 = safeNum(best.priceChange?.m5);
    const priceChange1h = safeNum(best.priceChange?.h1);
    const priceChange24h = safeNum(best.priceChange?.h24);
    const volume24h = safeNum(best.volume?.h24);
    const range24hPct = Math.abs(priceChange24h);

    const highDenom = 1 - Math.max(0, priceChange24h) / 100;
    const lowDenom = 1 + Math.max(0, -priceChange24h) / 100;
    const high24h = highDenom > 0 ? currentPrice / highDenom : currentPrice * 2;
    const low24h = lowDenom > 0 ? currentPrice / lowDenom : currentPrice / 2;

    // Volume Delta components (m5 preferred for sniper logic)
    const txns = best.txns?.m5 || best.txns?.h1 || {};
    const buys = safeNum(txns.buys);
    const sells = safeNum(txns.sells);

    const trend = (priceChangeM5 > 1.5 && priceChange1h > 0) ? 'UPTREND'
      : (priceChangeM5 < -1.5 && priceChange1h < 0) ? 'DOWNTREND'
        : (priceChangeM5 > 3) ? 'PUMPING'
          : 'SIDEWAYS';

    // ─── Phase 1: High-Efficiency Data Fetch ────────────────────────
    // Satu koin = Satu panggil API. Jangan duplikasi fetch ke DexScreener.
    let sentiment = marketSnapshot.sentiment;
    if (!sentiment) {
      sentiment = await getSentiment(tokenMint);
    }

    if (!sentiment) {
      if (process.env.HUNTER_DEBUG) console.log(`[oracle] Skipping ${tokenMint} - Sentiment data unavailable (API Rate Limit/Down)`);
      return null; // Gagal total ambil data, skip pool ini
    }

    // ─── Phase 2: Perennial Momentum Logic (The Stability Fix) ──────────
    // Karena API Candle (OHLCV) sering mati, kita gunakan momentum dari statistik
    // DexScreener yang kita ambil di Phase 1.
    
    const p1h  = sentiment.priceChange1h || 0;
    const p5m  = sentiment.priceChange5m || 0;
    const bp   = sentiment.buyPressurePct || 50;

    // Logika Proksi Supertrend:
    const isBullish = (p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1);
    const isBearish = (p1h < -5 || bp < 35);

    taData = {
      supertrend: {
        trend: isBullish ? 'BULLISH' : (isBearish ? 'BEARISH' : 'NEUTRAL'),
        value: sentiment.priceUsd || 0,
        source: 'Momentum-Proxy'
      },
      candleCount: 0,
      historySuccess: true,
      "Evil Panda": {
        entry: {
          triggered: isBullish,
          reason: isBullish ? `EVIL PANDA MOMENTUM: Trend Bullish (1h: ${p1h}%, BP: ${bp}%).` : null
        },
        exit: {
          triggered: isBearish,
          reason: isBearish ? `MOMENTUM EXIT: Sell pressure ekstrim.` : null
        }
      }
    };
    historySuccess = true;

    return {
      tokenMint,
      timeframe: '15m',
      source: 'dexscreener-v1',
      currentPrice,
      priceChangeM5,
      priceChangeH1: priceChange1h,
      high24h, low24h,
      range24hPct: parseFloat(range24hPct.toFixed(2)),
      buyVolume: buys,
      sellVolume: sells,
      trend,
      volatilityCategory: range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      ta: taData,
      historySuccess,
    };
  } catch (e) {
    console.error('[oracle] buildOHLCV failed:', e.message);
    return null;
  }
}

function aggregateCandles(candles, targetMinutes = 15) {
  if (!candles || candles.length === 0) return [];
  const targetSeconds = targetMinutes * 60;

  const result = [];
  let currentGroup = [];

  // DexScreener candles usually come in 1m or 5m increments.
  // We group them into targetMinutes-sized buckets.
  for (const c of candles) {
    if (currentGroup.length === 0) {
      currentGroup.push(c);
      continue;
    }

    // Group by floor(time / targetSeconds)
    const currentBucket = Math.floor(currentGroup[0].time / targetSeconds);
    const bucket = Math.floor(c.time / targetSeconds);

    if (bucket === currentBucket) {
      currentGroup.push(c);
    } else {
      result.push({
        time: currentGroup[0].time,
        open: currentGroup[0].open,
        high: Math.max(...currentGroup.map(g => g.high)),
        low: Math.min(...currentGroup.map(g => g.low)),
        close: currentGroup[currentGroup.length - 1].close,
        volume: currentGroup.reduce((s, g) => s + g.volume, 0)
      });
      currentGroup = [c];
    }
  }

  // PUSH the last (potentially incomplete) bucket so history.slice(0, -1) works predictably
  if (currentGroup.length > 0) {
    result.push({
      time: currentGroup[0].time,
      open: currentGroup[0].open,
      high: Math.max(...currentGroup.map(g => g.high)),
      low: Math.min(...currentGroup.map(g => g.low)),
      close: currentGroup[currentGroup.length - 1].close,
      volume: currentGroup.reduce((s, g) => s + g.volume, 0)
    });
  }

  return result;
}

async function getHistoryOHLCV(poolAddress) {
  try {
    // DexScreener V1 OHLCV API (Solana) 
    // Format: https://api.dexscreener.com/ohlcv/latest/v1/solana/{poolAddress}
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/ohlcv/latest/v1/solana/${poolAddress}?timeframe=15`,
      {},
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    const candles = json.candles || [];

    // DexScreener format: { t: timestamp (seconds), o: open, h: high, l: low, c: close, v: volume }
    const raw = candles.map(c => ({
      time: c.t, // API v1 returns seconds
      open: safeNum(c.o),
      high: safeNum(c.h),
      low: safeNum(c.l),
      close: safeNum(c.c),
      volume: safeNum(c.v)
    })).sort((a, b) => a.time - b.time);

    // Aggregate to 15m for Sniper Bullish Guard
    return aggregateCandles(raw, 15);
  } catch { return null; }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress = null) {
  const [ohlcvR, poolR, onChainR, sentimentR, smartMoneyR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    poolAddress
      ? fetchWithTimeout(`${METEORA_DATAPI}/pools/${poolAddress}/top-lpers`, {}, 5000)
        .then(res => res.ok ? res.json() : null)
        .catch(() => null)
      : Promise.resolve(null),
  ]);

  const ohlcv = ohlcvR.status === 'fulfilled' ? ohlcvR.value : null;
  const pool = poolR.status === 'fulfilled' ? poolR.value : null;
  const onChain = onChainR.status === 'fulfilled' ? onChainR.value : null;
  const sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const smartMoney = smartMoneyR.status === 'fulfilled' ? smartMoneyR.value : null;

  // Simplified Health Score (using only allowed sources)
  let healthScore = 50;
  if (pool) {
    const feeCat = pool.feeAprCategory || 'MEDIUM';
    healthScore += feeCat === 'HIGH' ? 20 : feeCat === 'LOW' ? -20 : 0;

    const feeRatio = Number.isFinite(pool.feeTvlRatio) ? pool.feeTvlRatio : 0;
    healthScore += feeRatio > 0.05 ? 15 : feeRatio < 0.01 ? -10 : 0;
  }

  if (onChain && onChain.available) {
    healthScore += onChain.whaleRisk === 'HIGH' ? -15 : onChain.whaleRisk === 'LOW' ? 5 : 0;
  }

  if (sentiment) {
    const bp = Number.isFinite(sentiment.buyPressurePct) ? sentiment.buyPressurePct : 50;
    healthScore += bp > 60 ? 10 : bp < 40 ? -5 : 0;
  }

  if (smartMoney && pool && pool.tvl > 0) {
    const topLp = Array.isArray(smartMoney) ? smartMoney[0] : null;
    if (topLp && topLp.usd_value) {
      const skew = (safeNum(topLp.usd_value) / pool.tvl) * 100;
      if (skew > 25) healthScore -= 10;
    }
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool: pool ? { ...pool, mcap: sentiment?.fdv || 0 } : null, onChain, sentiment,
    smartMoney,
    healthScore,
    ta: ohlcv?.ta || null,
    dataSource: ohlcv?.source || 'unknown',
    price: sentiment ? {
      currentPrice: sentiment.priceUsd,
      trend: ohlcv?.trend || 'SIDEWAYS',
      volatility24h: ohlcv?.range24hPct || 0,
      volatilityCategory: ohlcv?.volatilityCategory || 'MEDIUM',
      // Sentinel v61.2: Volatility-based Bin Step Safety Guard
      suggestedBinStepMin: (ohlcv?.range24hPct >= 200) ? 125
        : (ohlcv?.range24hPct >= 50) ? 100
          : 1,
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
