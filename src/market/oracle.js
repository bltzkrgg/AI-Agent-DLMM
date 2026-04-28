import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import { heliusRpc } from '../utils/helius.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { getConfig } from '../config.js';
import * as ta from '../utils/ta.js';
import { getPoolSmartMoney } from '../market/lpAgent.js';
import { getGmgnTokenInfo } from '../utils/gmgn.js';

const METEORA_DATAPI = 'https://dlmm-api.meteora.ag';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// ─── 1. OHLCV — Price Snapshot (DexScreener primary, Birdeye fallback, Momentum-Proxy last) ───
// Primary: DexScreener 15m real candles + Supertrend for Evil Panda entry/exit (30-min stale threshold).
// Fallback 1: Birdeye 15m candles when DexScreener data absent/stale.
// Fallback 2: Jupiter spot price momentum proxy when both candle sources fail.

export async function getOHLCV(tokenMint, poolAddress = null) {
  const dex = await buildOHLCVFromDexScreener(tokenMint);
  if (dex?.historySuccess) return dex;
  const birdeye = await buildOHLCVFromBirdeye(tokenMint);
  if (birdeye?.historySuccess) return birdeye;
  return buildMomentumProxyOHLCV(tokenMint);
}

async function buildMomentumProxyOHLCV(tokenMint) {
  try {
    const price = await getJupiterPrice(tokenMint);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      tokenMint,
      timeframe: '15m',
      source: 'momentum-proxy',
      currentPrice: price,
      atrPct: null,
      priceChangeM5: 0,
      priceChangeH1: 0,
      high24h: price,
      low24h: price,
      range24hPct: 0,
      buyVolume: 0,
      sellVolume: 0,
      trend: 'SIDEWAYS',
      volatilityCategory: 'LOW',
      ta: {
        supertrend: { trend: 'NEUTRAL', value: price, atr: null, changed: false, source: 'Momentum-Proxy' },
        candleCount: 0,
        historySuccess: false,
        "Evil Panda": {
          entry: { triggered: false, reason: null },
          exit: { triggered: false, reason: null },
        },
      },
      historySuccess: false,
      historyAgeMinutes: null,
    };
  } catch { return null; }
}

function isCandleSeriesStale(candles = [], maxStaleMinutes = 90) {
  if (!Array.isArray(candles) || candles.length === 0) return true;
  const last = candles[candles.length - 1];
  const tsSec = Number(last?.time);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return true;
  const ageMinutes = (Date.now() / 1000 - tsSec) / 60;
  return ageMinutes > Math.max(1, Number(maxStaleMinutes || 90));
}

async function buildOHLCVFromDexScreener(tokenMint) {
  try {
    const staleThreshold = 30;

    // Step 1: resolve the Solana pair address for this token mint
    const pairRes = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { headers: { Accept: 'application/json' } },
      3000
    );
    if (!pairRes.ok) return null;
    const pairData = await pairRes.json().catch(() => null);
    const pairs = pairData?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // Prefer the pair with the highest liquidity (first entry is usually the best)
    const pairAddress = pairs[0]?.pairAddress;
    const dexMeta = pairs[0];
    if (!pairAddress) return null;

    // Step 2: fetch 15m candles
    const candleRes = await fetchWithTimeout(
      `https://io.dexscreener.com/dex/candles/v3/solana/${pairAddress}?res=15&cb=1`,
      { headers: { Accept: 'application/json' } },
      3000
    );
    if (!candleRes.ok) return null;
    const candleJson = await candleRes.json().catch(() => null);

    // DexScreener v3 candle format: { candles: [[ts_ms, o, h, l, c, v], ...] }
    const rawCandles = candleJson?.candles ?? candleJson?.data?.candles ?? [];
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) return null;

    const mapped = rawCandles.map((c) => {
      // Array form: [time_ms, open, high, low, close, volume]
      if (Array.isArray(c)) {
        const tsSec = c[0] > 1e12 ? Math.floor(c[0] / 1000) : Number(c[0]);
        return { time: tsSec, open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5] ?? 0) };
      }
      // Object form: { time, open, high, low, close, volume }
      const tsSec = Number(c.time ?? c.t) > 1e12 ? Math.floor(Number(c.time ?? c.t) / 1000) : Number(c.time ?? c.t);
      return {
        time: tsSec,
        open: Number(c.o ?? c.open),
        high: Number(c.h ?? c.high),
        low: Number(c.l ?? c.low),
        close: Number(c.c ?? c.close),
        volume: Number(c.v ?? c.volume ?? 0),
      };
    }).filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
      .sort((a, b) => a.time - b.time);

    if (mapped.length < 10) return null;

    const closedCandles = mapped.slice(0, -1);
    if (closedCandles.length < 10) return null;
    if (isCandleSeriesStale(closedCandles, staleThreshold)) {
      console.warn('[oracle] DexScreener OHLCV stale — falling back');
      return null;
    }

    const last = closedCandles[closedCandles.length - 1];
    const first = closedCandles[0];
    const historyAgeMinutes = Number(((Date.now() / 1000 - last.time) / 60).toFixed(2));
    const maxHigh = Math.max(...closedCandles.map((c) => c.high));
    const minLow = Math.min(...closedCandles.map((c) => c.low));
    const range24hPct = last.close > 0 ? Math.abs(((maxHigh - minLow) / last.close) * 100) : 0;

    const priceChangeM5 = safeNum(dexMeta?.priceChange?.m5 ?? 0);
    const priceChangeH1 = safeNum(dexMeta?.priceChange?.h1 ?? 0);
    const buyVolume = safeNum(dexMeta?.txns?.h1?.buys ?? 0);
    const sellVolume = safeNum(dexMeta?.txns?.h1?.sells ?? 0);

    const st = ta.calculateSupertrend(closedCandles, 10, 3);
    return {
      tokenMint,
      timeframe: '15m',
      source: 'dexscreener-ohlcv',
      currentPrice: safeNum(last.close),
      atrPct: Number.isFinite(st?.atr) && last.close > 0 ? Number(((st.atr / last.close) * 100).toFixed(3)) : null,
      priceChangeM5,
      priceChangeH1,
      high24h: safeNum(maxHigh),
      low24h: safeNum(minLow),
      range24hPct: parseFloat(range24hPct.toFixed(2)),
      buyVolume,
      sellVolume,
      trend: (priceChangeM5 > 1.5 && priceChangeH1 > 0) ? 'UPTREND'
        : (priceChangeM5 < -1.5 && priceChangeH1 < 0) ? 'DOWNTREND'
          : 'SIDEWAYS',
      volatilityCategory: range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      ta: {
        supertrend: {
          trend: st?.trend || 'NEUTRAL',
          value: Number.isFinite(st?.value) ? st.value : last.close,
          atr: Number.isFinite(st?.atr) ? st.atr : null,
          changed: Boolean(st?.changed),
          source: 'DexScreener-15m',
        },
        candleCount: closedCandles.length,
        historySuccess: true,
        "Evil Panda": {
          entry: {
            triggered: st?.trend === 'BULLISH',
            reason: st?.trend === 'BULLISH'
              ? `EVIL PANDA TREND: Supertrend 15m bullish (${closedCandles.length} candles, DexScreener).`
              : null,
          },
          exit: {
            triggered: st?.trend === 'BEARISH',
            reason: st?.trend === 'BEARISH'
              ? 'TREND EXIT: Supertrend 15m bearish (DexScreener).'
              : null,
          },
        },
      },
      historySuccess: true,
      historyAgeMinutes,
      historyWindowSec: safeNum(last.time - first.time),
    };
  } catch {
    return null;
  }
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
    const nonRefundableFlags = [
      pool?.pool_config?.non_refundable_fees,
      pool?.pool_config?.non_refundable_fee,
      pool?.pool_config?.is_non_refundable_fee,
      pool?.pool_config?.refundable_fee === false ? true : null,
      pool?.non_refundable_fees,
      pool?.non_refundable_fee,
      pool?.is_non_refundable_fee,
      pool?.fee_refundable === false ? true : null,
    ];
    const hasNonRefundableFees = nonRefundableFlags.some((v) => v === true || v === 1 || String(v).toLowerCase() === 'true');

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
      hasNonRefundableFees,
    };
  } catch { return null; }
}

async function getMeteoraPoolPriceUsd(poolAddress) {
  if (!poolAddress) return null;
  try {
    const res = await fetchWithTimeout(
      `${METEORA_DATAPI}/pools/${poolAddress}`,
      { headers: { Accept: 'application/json' } },
      6000
    );
    if (!res.ok) return null;
    const pool = await res.json();

    const directCandidates = [
      pool?.current_price_usd,
      pool?.price_usd,
      pool?.currentPriceUsd,
      pool?.priceUsd,
      pool?.active_price_usd,
      pool?.activePriceUsd,
    ];
    for (const candidate of directCandidates) {
      const parsed = safeNum(candidate, NaN);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    // Fallback estimate when explicit USD price is unavailable:
    // tokenX price in tokenY multiplied by tokenY USD price (if present).
    const tokenYUsdCandidates = [
      pool?.token_y?.price,
      pool?.tokenY?.price,
      pool?.token_y?.price_usd,
      pool?.tokenY?.priceUsd,
      pool?.token_y_price_usd,
    ];
    const tokenXPerYCandidates = [
      pool?.active_bin_price,
      pool?.activePrice,
      pool?.current_price,
      pool?.price,
    ];
    const tokenYUsd = tokenYUsdCandidates.map(v => safeNum(v, NaN)).find(v => Number.isFinite(v) && v > 0);
    const xPerY = tokenXPerYCandidates.map(v => safeNum(v, NaN)).find(v => Number.isFinite(v) && v > 0);
    if (Number.isFinite(tokenYUsd) && Number.isFinite(xPerY)) {
      return xPerY * tokenYUsd;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 4. Sentiment & Momentum ────────────────────────────────────

export async function getSentiment(tokenMint) {
  try {
    const [priceResult, infoResult] = await Promise.allSettled([
      getJupiterPrice(tokenMint),
      getGmgnTokenInfo(tokenMint),
    ]);
    const priceUsd = priceResult.status === 'fulfilled' && Number.isFinite(priceResult.value)
      ? priceResult.value : 0;
    const info = infoResult.status === 'fulfilled' ? infoResult.value : null;

    const fdv = safeNum(info?.market_cap || info?.fdv || 0);
    const liquidityUsd = safeNum(info?.liquidity || 0);
    const symbol = info?.symbol || '';

    if (!priceUsd && !fdv) return null;
    return {
      tokenSymbol: symbol,
      priceUsd: priceUsd || safeNum(info?.price || info?.price_usd || 0),
      priceChange5m: 0,
      priceChange1h: 0,
      priceChange6h: 0,
      priceChange24h: 0,
      liquidityUsd,
      buys24h: 0,
      sells24h: 0,
      buyPressurePct: 50,
      fdv,
      sentiment: 'NEUTRAL',
      fetchedAt: new Date().toISOString(),
    };
  } catch { return null; }
}

export async function getTokenMarketCapUsd(tokenMint) {
  if (!tokenMint || typeof tokenMint !== 'string') return null;
  try {
    const sentiment = await getSentiment(tokenMint);
    const fdv = safeNum(sentiment?.fdv, NaN);
    if (Number.isFinite(fdv) && fdv > 0) return fdv;

    const priceUsd = safeNum(sentiment?.priceUsd, NaN);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    const supplyRes = await heliusRpc('getTokenSupply', [tokenMint], 8000);
    const supplyVal = supplyRes?.value || {};
    const uiAmount = safeNum(supplyVal?.uiAmount, NaN);
    if (Number.isFinite(uiAmount) && uiAmount > 0) {
      return priceUsd * uiAmount;
    }

    const rawAmount = safeNum(supplyVal?.amount, NaN);
    const decimals = safeNum(supplyVal?.decimals, NaN);
    if (Number.isFinite(rawAmount) && Number.isFinite(decimals) && decimals >= 0) {
      return priceUsd * (rawAmount / Math.pow(10, decimals));
    }
    return null;
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function computeSnapshotQuality({
  ohlcv,
  sentiment,
  jupiterPrice,
  dexPrice,
  meteoraPrice,
  minPriceSources = 2,
  maxAllowedDivergencePct = 3.0,
}) {
  const issues = [];
  let taConfidence = 0.35;
  const taSource = ohlcv?.ta?.supertrend?.source || 'unknown';

  if (taSource === 'Birdeye-15m') taConfidence += 0.24;
  else if (taSource === 'Momentum-Proxy') taConfidence += 0.12;
  if (ohlcv?.historySuccess) taConfidence += 0.10;
  if (sentiment && Number.isFinite(sentiment.buyPressurePct)) taConfidence += 0.08;

  const rawSources = {
    dex: Number.isFinite(dexPrice) && dexPrice > 0 ? dexPrice : null,
    jupiter: Number.isFinite(jupiterPrice) && jupiterPrice > 0 ? jupiterPrice : null,
    meteora: Number.isFinite(meteoraPrice) && meteoraPrice > 0 ? meteoraPrice : null,
  };
  const sourceEntries = Object.entries(rawSources).filter(([, v]) => Number.isFinite(v) && v > 0);
  const sourceCount = sourceEntries.length;
  const sourceValues = sourceEntries.map(([, v]) => v).sort((a, b) => a - b);
  const medianPrice = sourceValues.length === 0
    ? null
    : sourceValues.length % 2 === 1
      ? sourceValues[(sourceValues.length - 1) / 2]
      : (sourceValues[sourceValues.length / 2 - 1] + sourceValues[sourceValues.length / 2]) / 2;

  const divergenceBySource = {};
  if (Number.isFinite(medianPrice) && medianPrice > 0) {
    for (const [name, price] of sourceEntries) {
      divergenceBySource[name] = Math.abs(price - medianPrice) / medianPrice * 100;
    }
  }
  const divergenceValues = Object.values(divergenceBySource).filter(v => Number.isFinite(v));
  const maxPairDivergencePct = divergenceValues.length > 0 ? Math.max(...divergenceValues) : null;

  if (sourceCount < minPriceSources) {
    issues.push(`Sumber harga kurang (${sourceCount}/${minPriceSources})`);
    taConfidence -= 0.18;
  }
  if (Number.isFinite(maxPairDivergencePct) && maxPairDivergencePct > maxAllowedDivergencePct) {
    issues.push(`Price quorum divergence tinggi (${maxPairDivergencePct.toFixed(2)}%)`);
    taConfidence -= 0.25;
  } else if (sourceCount >= minPriceSources) {
    taConfidence += 0.10;
  }

  if (!ohlcv) {
    issues.push('OHLCV tidak tersedia');
    taConfidence -= 0.20;
  }
  if (!sentiment) {
    issues.push('Sentiment tidak tersedia');
    taConfidence -= 0.15;
  }

  taConfidence = clamp(taConfidence, 0.05, 0.95);

  return {
    taSource,
    taConfidence: Number(taConfidence.toFixed(3)),
    priceDivergencePct: Number.isFinite(maxPairDivergencePct)
      ? Number(maxPairDivergencePct.toFixed(3))
      : null,
    priceSources: {
      available: sourceCount,
      minRequired: minPriceSources,
      values: Object.fromEntries(sourceEntries.map(([name, price]) => [name, Number(price.toFixed(8))])),
      medianPrice: Number.isFinite(medianPrice) ? Number(medianPrice.toFixed(8)) : null,
      divergenceBySource: Object.fromEntries(
        Object.entries(divergenceBySource).map(([k, v]) => [k, Number(v.toFixed(3))])
      ),
    },
    issues,
  };
}

async function getHistoryOHLCVFromBirdeye(tokenMint, lookbackHours = 12) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey || !tokenMint) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const timeFrom = now - (Math.max(2, lookbackHours) * 3600);
    const res = await fetchWithTimeout(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&type=15m&time_from=${timeFrom}&time_to=${now}`,
      {
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
          Accept: 'application/json',
        },
      },
      8000
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const items = json?.data?.items || json?.data?.candles || [];
    if (!Array.isArray(items) || items.length === 0) return null;

    const mapped = items.map((c) => {
      const rawTime = safeNum(c.unixTime ?? c.t ?? c.time, NaN);
      const time = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime;
      return {
        time,
        open: safeNum(c.o ?? c.open),
        high: safeNum(c.h ?? c.high),
        low: safeNum(c.l ?? c.low),
        close: safeNum(c.c ?? c.close),
        volume: safeNum(c.v ?? c.volume ?? 0),
      };
    }).filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.close) &&
      c.close > 0
    ).sort((a, b) => a.time - b.time);

    if (mapped.length === 0) return null;
    return mapped;
  } catch {
    return null;
  }
}

async function buildOHLCVFromBirdeye(tokenMint, dexFallback = null) {
  try {
    const cfg = getConfig();
    const history = await getHistoryOHLCVFromBirdeye(tokenMint, 12);
    if (!Array.isArray(history) || history.length < 12) return null;

    const closedCandles = history.slice(0, -1);
    if (closedCandles.length < 10) return null;
    if (isCandleSeriesStale(closedCandles, cfg.maxOhlcvStaleMinutes15m ?? 90)) {
      console.warn('[oracle] Birdeye OHLCV stale — fallback ignored');
      return null;
    }

    const last = closedCandles[closedCandles.length - 1];
    const first = closedCandles[0];
    const historyAgeMinutes = Number(((Date.now() / 1000 - safeNum(last.time, 0)) / 60).toFixed(2));
    const maxHigh = Math.max(...closedCandles.map((c) => c.high));
    const minLow = Math.min(...closedCandles.map((c) => c.low));
    const range24hPct = last.close > 0 ? Math.abs(((maxHigh - minLow) / last.close) * 100) : 0;
    const priceChangeM5 = dexFallback?.priceChangeM5 ?? 0;
    const priceChangeH1 = dexFallback?.priceChangeH1 ?? 0;
    const buyVolume = safeNum(dexFallback?.buyVolume ?? 0);
    const sellVolume = safeNum(dexFallback?.sellVolume ?? 0);

    const st = ta.calculateSupertrend(closedCandles, 10, 3);
    return {
      tokenMint,
      timeframe: '15m',
      source: 'birdeye-ohlcv',
      currentPrice: safeNum(last.close),
      atrPct: Number.isFinite(st?.atr) && last.close > 0 ? Number(((st.atr / last.close) * 100).toFixed(3)) : null,
      priceChangeM5,
      priceChangeH1,
      high24h: safeNum(maxHigh),
      low24h: safeNum(minLow),
      range24hPct: parseFloat(range24hPct.toFixed(2)),
      buyVolume,
      sellVolume,
      trend: (priceChangeM5 > 1.5 && priceChangeH1 > 0) ? 'UPTREND'
        : (priceChangeM5 < -1.5 && priceChangeH1 < 0) ? 'DOWNTREND'
          : 'SIDEWAYS',
      volatilityCategory: range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      ta: {
        supertrend: {
          trend: st?.trend || 'NEUTRAL',
          value: Number.isFinite(st?.value) ? st.value : last.close,
          atr: Number.isFinite(st?.atr) ? st.atr : null,
          changed: Boolean(st?.changed),
          source: 'Birdeye-15m',
        },
        candleCount: closedCandles.length,
        historySuccess: true,
        "Evil Panda": {
          entry: {
            triggered: st?.trend === 'BULLISH',
            reason: st?.trend === 'BULLISH'
              ? `EVIL PANDA TREND: Supertrend 15m bullish (${closedCandles.length} candles, Birdeye fallback).`
              : null,
          },
          exit: {
            triggered: st?.trend === 'BEARISH',
            reason: st?.trend === 'BEARISH'
              ? 'TREND EXIT: Supertrend 15m bearish (Birdeye fallback).'
              : null,
          },
        },
      },
      historySuccess: true,
      historyAgeMinutes,
      historyWindowSec: safeNum(last.time - first.time),
    };
  } catch {
    return null;
  }
}

// ─── OHLCV History (Birdeye) ─────────────────────────────────────

export async function getHistoryOHLCV(tokenMint) {
  return getHistoryOHLCVFromBirdeye(tokenMint, 12);
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress = null) {
  const [ohlcvR, poolR, onChainR, sentimentR, smartMoneyR, jupiterPriceR, meteoraPriceR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    poolAddress
      ? fetchWithTimeout(`${METEORA_DATAPI}/pools/${poolAddress}/top-lpers`, {}, 5000)
        .then(res => res.ok ? res.json() : null)
        .catch(() => null)
      : Promise.resolve(null),
    getJupiterPrice(tokenMint),
    poolAddress ? getMeteoraPoolPriceUsd(poolAddress) : Promise.resolve(null),
  ]);

  const ohlcv = ohlcvR.status === 'fulfilled' ? ohlcvR.value : null;
  const pool = poolR.status === 'fulfilled' ? poolR.value : null;
  const onChain = onChainR.status === 'fulfilled' ? onChainR.value : null;
  const sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const smartMoney = smartMoneyR.status === 'fulfilled' ? smartMoneyR.value : null;
  const jupiterPrice = jupiterPriceR.status === 'fulfilled' ? jupiterPriceR.value : null;
  const meteoraPrice = meteoraPriceR.status === 'fulfilled' ? meteoraPriceR.value : null;
  const cfg = getConfig();

  // Simplified Health Score (using only allowed sources)
  let healthScore = 50;
  if (pool) {
    const minFeeYieldRatio = Math.max(0, Number(cfg.minDailyFeeYieldPct ?? 1.0)) / 100;
    const strongFeeYieldRatio = Math.max(minFeeYieldRatio * 5, 0.05);
    const feeCat = pool.feeAprCategory || 'MEDIUM';
    healthScore += feeCat === 'HIGH' ? 20 : feeCat === 'LOW' ? -20 : 0;

    const feeRatio = Number.isFinite(pool.feeTvlRatio) ? pool.feeTvlRatio : 0;
    healthScore += feeRatio > strongFeeYieldRatio ? 15 : feeRatio < minFeeYieldRatio ? -10 : 0;
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
  const quality = computeSnapshotQuality({
    ohlcv,
    sentiment,
    jupiterPrice,
    dexPrice: sentiment?.priceUsd,
    meteoraPrice,
    minPriceSources: cfg.minPriceSourcesForEntry ?? 2,
    maxAllowedDivergencePct: cfg.oracleMaxPriceDivergencePct ?? 3.0,
  });
  const taTrend = ohlcv?.ta?.supertrend?.trend || 'NEUTRAL';
  const minTaConfidence = cfg.minTaConfidenceForAutoExit ?? 0.55;
  const taReliable = quality.taConfidence >= minTaConfidence;
  const dataReliable = (quality.priceSources?.available || 0) >= (quality.priceSources?.minRequired || 2)
    && (quality.priceDivergencePct == null || quality.priceDivergencePct <= (cfg.oracleMaxPriceDivergencePct ?? 3.0));

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool: pool ? { ...pool, mcap: sentiment?.fdv || 0 } : null, onChain, sentiment,
    smartMoney,
    healthScore,
    ta: ohlcv?.ta || null,
    quality: {
      ...quality,
      taReliable,
      dataReliable,
      minTaConfidence,
      jupiterPrice: Number.isFinite(jupiterPrice) ? Number(jupiterPrice.toFixed(8)) : null,
      dexPrice: Number.isFinite(sentiment?.priceUsd) ? Number(sentiment.priceUsd.toFixed(8)) : null,
      meteoraPrice: Number.isFinite(meteoraPrice) ? Number(meteoraPrice.toFixed(8)) : null,
      taTrend,
    },
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
export async function getOKXData() {
  const cfg = getConfig();
  const apiKey = String(cfg.okxApiKey || process.env.OKX_API_KEY || '');
  if (!apiKey) {
    return { available: false, reason: 'OKX_API_KEY missing' };
  }
  return {
    available: true,
    mode: 'api_key_only',
    reason: 'OKX credentials in simple mode (API key only) loaded',
  };
}
