import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import { heliusRpc } from '../utils/helius.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { getConfig } from '../config.js';
import * as ta from '../utils/ta.js';
import { getPoolSmartMoney } from '../market/lpAgent.js';
import { getGmgnTokenInfo } from '../utils/gmgn.js';

const METEORA_DATAPI = 'https://dlmm-api.meteora.ag';
const METEORA_DLMM_DATAPI = 'https://dlmm.datapi.meteora.ag';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// ─── 1. OHLCV — Price Snapshot (DexScreener primary, Birdeye fallback, Momentum-Proxy last) ───
// Primary: DexScreener 15m real candles + Supertrend for Evil Panda entry/exit (30-min stale threshold).
// Fallback 1: Birdeye 15m candles when DexScreener data absent/stale.
// Fallback 2: Jupiter spot price momentum proxy when both candle sources fail.

let birdeyeCooldownUntil = 0;
const MERIDIAN_FALLBACK_TTL_MS = 45_000;
const _meridianFallbackCache = new Map(); // key -> { at, value }
const MARKET_SNAPSHOT_CACHE_TTL_MS = 12_000;
const _marketSnapshotCache = new Map(); // key -> { at, value }
const _marketSnapshotInflight = new Map(); // key -> Promise<object>
const METEORA_OHLCV_CACHE_TTL_MS = 45_000;
const METEORA_OHLCV_FAILURE_MIN_COOLDOWN_MS = 120_000;
const METEORA_OHLCV_FAILURE_MAX_COOLDOWN_MS = 300_000;
const METEORA_OHLCV_WINDOW_SEC = 6 * 60 * 60;
const METEORA_OHLCV_CANDLE_SEC = 300;
const METEORA_OHLCV_CLOSE_BUFFER_SEC = 15;
const METEORA_MIN_ENTRY_5M_CANDLES = 13;
const METEORA_MIN_AGG_15M_CANDLES = 10;
const _meteoraOhlcvCache = new Map(); // key -> { at, candles, timeframe }
const _meteoraOhlcvFailureState = new Map(); // key -> { failCount, cooldownUntil, reason }

function getOracleFallbackCacheKey(tokenMint = '', poolAddress = '') {
  return `${tokenMint || 'unknown'}:${poolAddress || 'nopool'}`;
}

function getMeteoraOhlcvCacheKey(poolAddress = '', timeframe = '5m') {
  return `${String(poolAddress || '').trim()}:${String(timeframe || '5m').trim().toLowerCase()}`;
}

function getMarketSnapshotCacheKey(tokenMint = '', poolAddress = null, options = {}) {
  const includeEntryCandles5m = options?.includeEntryCandles5m === true ? 'entry5m:1' : 'entry5m:0';
  const includeOnChainSignals = options?.includeOnChainSignals === false ? 'onchain:0' : 'onchain:1';
  return [
    String(tokenMint || '').trim() || 'unknown',
    String(poolAddress || '').trim() || 'nopool',
    includeEntryCandles5m,
    includeOnChainSignals,
  ].join('|');
}

function normalizeMeteoraOhlcvCandle(row = null) {
  if (!row) return null;
  const raw = Array.isArray(row)
    ? {
      timestamp: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }
    : row;

  const tsRaw = safeNum(raw.timestamp ?? raw.time ?? raw.unixTime ?? raw.t, NaN);
  const time = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
  const open = safeNum(raw.open ?? raw.o, NaN);
  const high = safeNum(raw.high ?? raw.h, NaN);
  const low = safeNum(raw.low ?? raw.l, NaN);
  const close = safeNum(raw.close ?? raw.c, NaN);
  const volume = safeNum(raw.volume ?? raw.v ?? 0, NaN);
  if (!Number.isFinite(time) || time <= 0) return null;
  if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
  if (close <= 0 || !Number.isFinite(volume)) return null;
  return { time, open, high, low, close, volume };
}

function aggregate5mTo15m(candles5m = []) {
  if (!Array.isArray(candles5m) || candles5m.length < 9) return [];
  const buckets = new Map();
  for (const candle of candles5m) {
    const bucketTs = Math.floor(Number(candle.time) / 900) * 900;
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, []);
    buckets.get(bucketTs).push(candle);
  }
  const out = [];
  for (const [bucketTs, group] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    const sorted = group
      .slice()
      .sort((a, b) => Number(a.time) - Number(b.time))
      .filter((c) => Number.isFinite(Number(c.close)) && Number(c.close) > 0);
    if (sorted.length < 3) continue;
    const use = sorted.slice(0, 3);
    out.push({
      time: bucketTs + 900,
      open: use[0].open,
      high: Math.max(...use.map((c) => c.high)),
      low: Math.min(...use.map((c) => c.low)),
      close: use[use.length - 1].close,
      volume: use.reduce((sum, c) => sum + safeNum(c.volume, 0), 0),
    });
  }
  return out;
}

function getMeteoraFailureCooldownMs(failCount = 1) {
  const step = Math.max(1, Number(failCount) || 1);
  return Math.min(METEORA_OHLCV_FAILURE_MAX_COOLDOWN_MS, METEORA_OHLCV_FAILURE_MIN_COOLDOWN_MS * step);
}

async function fetchMeteoraDlmmOhlcv5m(poolAddress = '', options = {}) {
  const timeframe = '5m';
  const bypassCache = options?.bypassCache === true;
  const key = getMeteoraOhlcvCacheKey(poolAddress, timeframe);
  const now = Date.now();
  if (!bypassCache) {
    const cached = _meteoraOhlcvCache.get(key);
    if (cached && (now - cached.at) <= METEORA_OHLCV_CACHE_TTL_MS) {
      return { candles: cached.candles, timeframe, trace: 'cache_hit', cacheHit: true, request: cached.request || null };
    }
  }

  const failureState = _meteoraOhlcvFailureState.get(key);
  if (!bypassCache && failureState && Number(failureState.cooldownUntil || 0) > now) {
    return {
      candles: null,
      timeframe,
      trace: `cooldown:${failureState.reason || 'failed'}`,
      cooldownUntil: failureState.cooldownUntil,
      blockedByCooldown: true,
    };
  }

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - METEORA_OHLCV_WINDOW_SEC;
  const url = `${METEORA_DLMM_DATAPI}/pools/${poolAddress}/ohlcv?timeframe=5m&start_time=${startTime}&end_time=${endTime}`;
  const requestMeta = { timeframe, startTime, endTime };
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 4500);
    if (!res.ok) {
      const nextFailCount = Math.max(1, Number(failureState?.failCount || 0) + 1);
      const cooldownMs = getMeteoraFailureCooldownMs(nextFailCount);
      _meteoraOhlcvFailureState.set(key, {
        failCount: nextFailCount,
        cooldownUntil: Date.now() + cooldownMs,
        reason: `status_${res.status}`,
      });
      return { candles: null, timeframe, trace: `status_${res.status}`, status: res.status, request: requestMeta };
    }

    const json = await res.json().catch(() => null);
    const rawRows = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.ohlcv)
        ? json.ohlcv
        : Array.isArray(json?.candles)
          ? json.candles
          : [];
    const candles = rawRows
      .map(normalizeMeteoraOhlcvCandle)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
    if (candles.length === 0) {
      const nextFailCount = Math.max(1, Number(failureState?.failCount || 0) + 1);
      const cooldownMs = getMeteoraFailureCooldownMs(nextFailCount);
      _meteoraOhlcvFailureState.set(key, {
        failCount: nextFailCount,
        cooldownUntil: Date.now() + cooldownMs,
        reason: 'empty',
      });
      return { candles: null, timeframe, trace: 'empty', request: requestMeta };
    }

    _meteoraOhlcvCache.set(key, { at: Date.now(), candles, timeframe, request: requestMeta });
    _meteoraOhlcvFailureState.delete(key);
    return { candles, timeframe: String(json?.timeframe || timeframe).toLowerCase(), trace: 'success', request: requestMeta };
  } catch {
    const nextFailCount = Math.max(1, Number(failureState?.failCount || 0) + 1);
    const cooldownMs = getMeteoraFailureCooldownMs(nextFailCount);
    _meteoraOhlcvFailureState.set(key, {
      failCount: nextFailCount,
      cooldownUntil: Date.now() + cooldownMs,
      reason: 'network_error',
    });
    return { candles: null, timeframe, trace: 'network_error', request: requestMeta };
  }
}

async function buildOHLCVFromMeteoraDlmm(tokenMint, poolAddress = '', options = {}) {
  if (!poolAddress) return null;
  const fetched = await fetchMeteoraDlmmOhlcv5m(poolAddress, options);
  if (!Array.isArray(fetched?.candles)) {
    return fetched?.blockedByCooldown
      ? { source: 'unknown', historySuccess: false, trace: fetched.trace, providerTrace: { meteoraDlmm: fetched.trace || 'cooldown' } }
      : null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const rawCandles = fetched.candles.slice().sort((a, b) => a.time - b.time);
  const closed5m = rawCandles.filter((c) => (Number(c.time) + METEORA_OHLCV_CANDLE_SEC) <= (nowSec - METEORA_OHLCV_CLOSE_BUFFER_SEC));
  const droppedOpenCandle = rawCandles.length > closed5m.length;
  const last5m = closed5m[closed5m.length - 1] || null;
  if (!last5m) {
    return {
      tokenMint,
      poolAddress,
      timeframe: '5m',
      source: 'meteora-dlmm-ohlcv',
      currentPrice: 0,
      priceChangeM5: 0,
      priceChangeH1: 0,
      trend: 'SIDEWAYS',
      historySuccess: false,
      ta: {
        supertrend: { trend: 'UNKNOWN', value: null, atr: null, changed: false, source: 'Meteora-DLMM-5m' },
        candleCount: 0,
        historySuccess: false,
      },
      providerTrace: {
        meteoraDlmm: 'METEORA_OHLCV_NO_CLOSED_CANDLE',
        timeframe: fetched?.request?.timeframe || '5m',
        startTime: fetched?.request?.startTime || null,
        endTime: fetched?.request?.endTime || null,
        rawCandleCount: rawCandles.length,
        closedCandleCount: 0,
        droppedOpenCandle,
        enough5m: false,
        aggregated15mCount: 0,
        enough15m: false,
        finalHistorySuccess: false,
        reason: 'METEORA_OHLCV_NO_CLOSED_CANDLE',
      },
    };
  }

  const enough5m = closed5m.length >= METEORA_MIN_ENTRY_5M_CANDLES;
  const changeBase = closed5m.length >= 2 ? closed5m[closed5m.length - 2].close : null;
  const priceChangeM5 = Number.isFinite(changeBase) && changeBase > 0
    ? Number((((last5m.close - changeBase) / changeBase) * 100).toFixed(4))
    : 0;
  const h1Base = closed5m.length >= 13 ? closed5m[closed5m.length - 13].close : null;
  const priceChangeH1 = Number.isFinite(h1Base) && h1Base > 0
    ? Number((((last5m.close - h1Base) / h1Base) * 100).toFixed(4))
    : 0;
  const agg15m = aggregate5mTo15m(closed5m);
  const enough15m = agg15m.length >= METEORA_MIN_AGG_15M_CANDLES;
  const st = enough15m ? ta.calculateSupertrend(agg15m, 10, 3) : null;
  const trend = enough15m ? (st?.trend || 'UNKNOWN') : 'UNKNOWN';
  const maxHigh = Math.max(...closed5m.map((c) => c.high));
  const minLow = Math.min(...closed5m.map((c) => c.low));
  const range24hPct = last5m.close > 0 ? Math.abs(((maxHigh - minLow) / last5m.close) * 100) : 0;
  const historyAgeMinutes = Number(((Date.now() / 1000 - last5m.time) / 60).toFixed(2));
  const stale5m = historyAgeMinutes > 20;
  const entry5mHistorySuccess = enough5m && !stale5m;
  const aggregated15mHistorySuccess = enough15m && !stale5m;
  const historySuccess = entry5mHistorySuccess;
  const includeEntryCandles5m = options?.includeEntryCandles5m === true;
  const entryCandles5m = includeEntryCandles5m ? closed5m.slice(-30) : [];
  const insufficientReason = !entry5mHistorySuccess
    ? (stale5m ? 'METEORA_OHLCV_STALE' : 'METEORA_OHLCV_INSUFFICIENT_CANDLES')
    : (!aggregated15mHistorySuccess ? 'METEORA_OHLCV_INSUFFICIENT_15M_AGG' : 'METEORA_OHLCV_OK');

  return {
    tokenMint,
    poolAddress,
    timeframe: '5m',
    source: 'meteora-dlmm-ohlcv',
    currentPrice: safeNum(last5m.close),
    atrPct: Number.isFinite(st?.atr) && last5m.close > 0 ? Number(((st.atr / last5m.close) * 100).toFixed(3)) : null,
    priceChangeM5,
    priceChangeH1,
    high24h: safeNum(maxHigh),
    low24h: safeNum(minLow),
    range24hPct: parseFloat(range24hPct.toFixed(2)),
    buyVolume: 0,
    sellVolume: 0,
    trend: historySuccess
      ? ((priceChangeM5 > 1.5 && priceChangeH1 > 0) ? 'UPTREND'
        : (priceChangeM5 < -1.5 && priceChangeH1 < 0) ? 'DOWNTREND'
          : 'SIDEWAYS')
      : 'SIDEWAYS',
    volatilityCategory: range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
    entryCandleTimeframe: '5m',
    entryCandles5m,
    entryCandle5m: entryCandles5m[entryCandles5m.length - 1] || null,
    ta: {
      supertrend: {
        trend,
        value: Number.isFinite(st?.value) ? st.value : last5m.close,
        atr: Number.isFinite(st?.atr) ? st.atr : null,
        changed: Boolean(st?.changed),
        source: agg15m.length >= 10 ? 'Meteora-DLMM-5m->15m' : 'Meteora-DLMM-5m',
      },
      candleCount: agg15m.length,
      historySuccess,
      entry5mHistorySuccess,
      aggregated15mHistorySuccess,
      fullTrendHistorySuccess: entry5mHistorySuccess && aggregated15mHistorySuccess,
      "Evil Panda": {
        entry: {
          triggered: historySuccess && trend === 'BULLISH',
          reason: trend === 'BULLISH'
            ? `EVIL PANDA TREND: Supertrend 15m bullish (${agg15m.length} candles, Meteora 5m aggregate).`
            : null,
        },
        exit: {
          triggered: historySuccess && trend === 'BEARISH',
          reason: trend === 'BEARISH'
            ? 'TREND EXIT: Supertrend 15m bearish (Meteora 5m aggregate).'
            : null,
        },
      },
    },
    entry5mHistorySuccess,
    aggregated15mHistorySuccess,
    historySuccess,
    fallbackReliable: historySuccess,
    historyAgeMinutes,
    historyWindowSec: closed5m.length >= 2 ? safeNum(closed5m[closed5m.length - 1].time - closed5m[0].time) : 0,
    providerTrace: {
      meteoraDlmm: insufficientReason === 'METEORA_OHLCV_OK' ? (fetched.trace || 'success') : insufficientReason,
      timeframe: fetched?.request?.timeframe || '5m',
      startTime: fetched?.request?.startTime || null,
      endTime: fetched?.request?.endTime || null,
      rawCandleCount: rawCandles.length,
      closedCandleCount: closed5m.length,
      droppedOpenCandle,
      enough5m: entry5mHistorySuccess,
      aggregated15mCount: agg15m.length,
      enough15m: aggregated15mHistorySuccess,
      finalHistorySuccess: historySuccess,
      fullTrendHistorySuccess: entry5mHistorySuccess && aggregated15mHistorySuccess,
      reason: insufficientReason,
      dexCandles: 'skipped',
      birdeye: 'skipped',
    },
  };
}

function normalizeMeridianTrend(direction = '') {
  const dir = String(direction || '').trim().toLowerCase();
  if (dir === 'bullish') return 'BULLISH';
  if (dir === 'bearish') return 'BEARISH';
  if (dir === 'neutral') return 'NEUTRAL';
  return 'UNKNOWN';
}

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildMergedMeridianFallback({
  meridian = null,
  dexPair = null,
  dexFallbackMeta = null,
  poolAddress = null,
} = {}) {
  if (!meridian) return null;
  const mergedM5 = Number.isFinite(dexFallbackMeta?.priceChangeM5) && dexFallbackMeta.priceChangeM5 !== 0
    ? dexFallbackMeta.priceChangeM5
    : meridian.priceChangeM5;
  const trend = String(meridian?.ta?.supertrend?.trend || '').toUpperCase();
  const trendKnown = trend === 'BULLISH' || trend === 'BEARISH' || trend === 'NEUTRAL';
  const poolSpecific = Boolean(poolAddress) && Boolean(dexPair?.poolMatched);
  const fallbackReliable = poolSpecific && trendKnown && Number.isFinite(mergedM5) && mergedM5 !== 0;
  return {
    ...meridian,
    source: 'meridian-fallback',
    poolMatched: Boolean(dexPair?.poolMatched),
    priceChangeM5: mergedM5,
    fallbackReliable,
  };
}

export async function getOHLCV(tokenMint, poolAddress = null, options = {}) {
  const includeEntryCandles5m = options?.includeEntryCandles5m === true;
  const bypassCache = options?.bypassCache === true;
  const cfg = getConfig();
  if (poolAddress) {
    const meteoraDlmm = await buildOHLCVFromMeteoraDlmm(tokenMint, poolAddress, { includeEntryCandles5m, bypassCache });
    if (meteoraDlmm?.source === 'meteora-dlmm-ohlcv') {
      return meteoraDlmm;
    }
    if (meteoraDlmm?.source === 'unknown' && meteoraDlmm?.historySuccess === false) {
      console.log(`[oracle] MeteoraDLMM OHLCV unavailable pool=${String(poolAddress).slice(0, 8)} trace=${meteoraDlmm.trace || 'unknown'}`);
    }
  }

  const dexPair = await resolveDexScreenerPairContext(tokenMint, poolAddress || null);
  const dex = await buildOHLCVFromDexScreener(tokenMint, dexPair, { includeEntryCandles5m });
  if (dex?.historySuccess) return dex;

  const dexFallbackMeta = dexPair?.dexMeta ? {
    priceChangeM5: safeNum(dexPair.dexMeta?.priceChange?.m5 ?? 0),
    priceChangeH1: safeNum(dexPair.dexMeta?.priceChange?.h1 ?? 0),
    buyVolume: safeNum(dexPair.dexMeta?.txns?.h1?.buys ?? 0),
    sellVolume: safeNum(dexPair.dexMeta?.txns?.h1?.sells ?? 0),
  } : null;

  if (Date.now() < birdeyeCooldownUntil) {
    console.warn('[oracle] Birdeye throttled, fallback path active');
    if (cfg.allowLegacyMeridianOhlcvFallback === true) {
      const meridian = await buildPoolSpecificMeridianFallback(tokenMint, poolAddress || null);
      const mergedFallback = buildMergedMeridianFallback({
        meridian,
        dexPair,
        dexFallbackMeta,
        poolAddress,
      });
      if (mergedFallback) return mergedFallback;
    }
    return buildMomentumProxyOHLCV(tokenMint);
  }

  const backoffStepsMs = [500, 1000];
  let birdeye = await buildOHLCVFromBirdeye(tokenMint, dexFallbackMeta, { includeEntryCandles5m });

  for (let i = 0; i < backoffStepsMs.length; i++) {
    const retryAfterSec = Number(birdeye?.retryAfterSec ?? 0);
    const throttled = birdeye?.status === 'THROTTLED';
    if (!throttled) break;

    const waitMs = retryAfterSec > 0
      ? Math.max(250, retryAfterSec * 1000)
      : backoffStepsMs[i];
    await new Promise(r => setTimeout(r, waitMs));
    birdeye = await buildOHLCVFromBirdeye(tokenMint, dexFallbackMeta, { includeEntryCandles5m });
  }

  if (birdeye?.status === 'THROTTLED') {
    const retryAfterSec = Number(birdeye?.retryAfterSec ?? 0);
    const cooldownMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 2 * 60 * 1000;
    birdeyeCooldownUntil = Date.now() + cooldownMs;
    console.warn(`[oracle] Birdeye throttled (${cooldownMs}ms cooldown), fallback path active`);
    if (cfg.allowLegacyMeridianOhlcvFallback === true) {
      const meridian = await buildPoolSpecificMeridianFallback(tokenMint, poolAddress || null);
      const mergedFallback = buildMergedMeridianFallback({
        meridian,
        dexPair,
        dexFallbackMeta,
        poolAddress,
      });
      if (mergedFallback) return mergedFallback;
    }
    return buildMomentumProxyOHLCV(tokenMint);
  }

  if (birdeye?.historySuccess) return birdeye;

  if (cfg.allowLegacyMeridianOhlcvFallback === true) {
    const meridian = await buildPoolSpecificMeridianFallback(tokenMint, poolAddress || null);
    const mergedFallback = buildMergedMeridianFallback({
      meridian,
      dexPair,
      dexFallbackMeta,
      poolAddress,
    });
    if (mergedFallback) return mergedFallback;
  }

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

function mapDexCandle(c) {
  if (Array.isArray(c)) {
    const tsSec = c[0] > 1e12 ? Math.floor(c[0] / 1000) : Number(c[0]);
    return { time: tsSec, open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5] ?? 0) };
  }
  const tsSec = Number(c.time ?? c.t) > 1e12 ? Math.floor(Number(c.time ?? c.t) / 1000) : Number(c.time ?? c.t);
  return {
    time: tsSec,
    open: Number(c.o ?? c.open),
    high: Number(c.h ?? c.high),
    low: Number(c.l ?? c.low),
    close: Number(c.c ?? c.close),
    volume: Number(c.v ?? c.volume ?? 0),
  };
}

async function fetchDexScreenerCandles(pairAddress, resolution = 15, timeoutMs = 3000) {
  if (!pairAddress) return [];
  const candleRes = await fetchWithTimeout(
    `https://io.dexscreener.com/dex/candles/v3/solana/${pairAddress}?res=${resolution}&cb=1`,
    { headers: { Accept: 'application/json' } },
    timeoutMs
  );
  if (!candleRes.ok) return [];
  const candleJson = await candleRes.json().catch(() => null);
  const rawCandles = candleJson?.candles ?? candleJson?.data?.candles ?? [];
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) return [];
  return rawCandles
    .map(mapDexCandle)
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

async function resolveDexScreenerPairContext(tokenMint, poolAddress = null) {
  try {
    const pairRes = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { headers: { Accept: 'application/json' } },
      3000
    );
    if (!pairRes.ok) return null;
    const pairData = await pairRes.json().catch(() => null);
    const pairs = Array.isArray(pairData?.pairs) ? pairData.pairs : [];
    if (pairs.length === 0) return null;

    let selected = pairs[0];
    let poolMatched = false;
    if (poolAddress) {
      const wanted = String(poolAddress).trim();
      const match = pairs.find((p) => String(p?.pairAddress || '').trim() === wanted);
      if (match) {
        selected = match;
        poolMatched = true;
      }
    }

    return {
      pairAddress: selected?.pairAddress || '',
      dexMeta: selected || null,
      poolMatched,
      pairCount: pairs.length,
    };
  } catch {
    return null;
  }
}

async function buildOHLCVFromDexScreener(tokenMint, pairContext = null, options = {}) {
  try {
    const staleThreshold = 30;
    const resolved = pairContext || await resolveDexScreenerPairContext(tokenMint, null);
    const pairAddress = resolved?.pairAddress || '';
    const dexMeta = resolved?.dexMeta || null;
    if (!pairAddress) return null;

    const mapped = await fetchDexScreenerCandles(pairAddress, 15, 3000);

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
    let entryCandleFields = {};
    if (options?.includeEntryCandles5m === true) {
      let entryCandles5m = [];
      try {
        const mapped5m = await fetchDexScreenerCandles(pairAddress, 5, 2500);
        const closed5m = mapped5m.slice(0, -1);
        if (closed5m.length >= 3 && !isCandleSeriesStale(closed5m, 15)) {
          entryCandles5m = closed5m.slice(-30);
        }
      } catch {
        entryCandles5m = [];
      }
      entryCandleFields = {
        entryCandleTimeframe: '5m',
        entryCandles5m,
        entryCandle5m: entryCandles5m[entryCandles5m.length - 1] || null,
      };
    }

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
      ...entryCandleFields,
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
  else if (String(taSource).includes('Meteora-DLMM')) taConfidence += 0.24;
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

async function getHistoryOHLCVFromBirdeye(tokenMint, lookbackHours = 12, interval = '15m') {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey || !tokenMint) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const timeFrom = now - (Math.max(2, lookbackHours) * 3600);
    const res = await fetchWithTimeout(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&type=${encodeURIComponent(interval)}&time_from=${timeFrom}&time_to=${now}`,
      {
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
          Accept: 'application/json',
        },
      },
      8000
    );
    if (res.status === 429) {
      const retryAfterRaw = Number(res.headers?.get?.('retry-after') || 0);
      const retryAfterSec = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : 0;
      return { status: 'THROTTLED', retryAfterSec };
    }
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

async function buildOHLCVFromBirdeye(tokenMint, dexFallback = null, options = {}) {
  try {
    const history = await getHistoryOHLCVFromBirdeye(tokenMint, 12, '15m');
    if (history?.status === 'THROTTLED') return history;
    if (!Array.isArray(history) || history.length < 12) return null;

    const cfg = getConfig();
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
    let entryCandleFields = {};
    if (options?.includeEntryCandles5m === true) {
      let entryCandles5m = [];
      try {
        const history5m = await getHistoryOHLCVFromBirdeye(tokenMint, 4, '5m');
        if (Array.isArray(history5m) && history5m.length >= 4) {
          const closed5m = history5m.slice(0, -1);
          if (closed5m.length >= 3 && !isCandleSeriesStale(closed5m, 15)) {
            entryCandles5m = closed5m.slice(-30);
          }
        }
      } catch {
        entryCandles5m = [];
      }
      entryCandleFields = {
        entryCandleTimeframe: '5m',
        entryCandles5m,
        entryCandle5m: entryCandles5m[entryCandles5m.length - 1] || null,
      };
    }

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
      ...entryCandleFields,
    };
  } catch {
    return null;
  }
}

async function buildPoolSpecificMeridianFallback(tokenMint, poolAddress = null) {
  const cfg = getConfig();
  const base = String(cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (cfg.publicApiKey) headers['x-api-key'] = cfg.publicApiKey;
  const cacheKey = getOracleFallbackCacheKey(tokenMint, poolAddress || '');
  const now = Date.now();
  const cached = _meridianFallbackCache.get(cacheKey);
  if (cached && (now - cached.at) <= MERIDIAN_FALLBACK_TTL_MS) {
    return cached.value;
  }

  try {
    const [chartRes, priceRes] = await Promise.all([
      fetchWithTimeout(`${base}/chart-indicators/${tokenMint}?interval=15_MINUTE`, { headers }, 6000),
      fetchWithTimeout(`${base}/price-info/${tokenMint}`, { headers }, 6000),
    ]);
    if (!chartRes.ok || !priceRes.ok) return null;
    const chart = await chartRes.json().catch(() => null);
    const price = await priceRes.json().catch(() => null);

    const trend = normalizeMeridianTrend(chart?.latest?.supertrend?.direction);
    const priceChangeM5 = toFiniteNumber(
      price?.price_change_m5 ??
      price?.priceChangeM5 ??
      chart?.latest?.price_change_m5 ??
      chart?.latest?.priceChangeM5,
      null
    );
    const currentPrice = toFiniteNumber(
      price?.price ??
      price?.price_usd ??
      chart?.latest?.close ??
      chart?.latest?.price,
      null
    );

    if (!['BULLISH', 'BEARISH', 'NEUTRAL'].includes(trend)) return null;
    if (!Number.isFinite(priceChangeM5) || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;

    const fallback = {
      tokenMint,
      poolAddress: poolAddress || null,
      timeframe: '15m',
      source: 'meridian-fallback',
      currentPrice,
      atrPct: null,
      priceChangeM5,
      priceChangeH1: toFiniteNumber(price?.price_change_h1 ?? price?.priceChangeH1, 0),
      high24h: currentPrice,
      low24h: currentPrice,
      range24hPct: 0,
      buyVolume: 0,
      sellVolume: 0,
      trend: trend === 'BULLISH' ? 'UPTREND' : (trend === 'BEARISH' ? 'DOWNTREND' : 'SIDEWAYS'),
      volatilityCategory: 'LOW',
      ta: {
        supertrend: {
          trend,
          value: currentPrice,
          atr: null,
          changed: false,
          source: 'Meridian-15m',
        },
        candleCount: 1,
        historySuccess: false,
      },
      historySuccess: false,
      historyAgeMinutes: null,
      fallbackReliable: true,
    };
    _meridianFallbackCache.set(cacheKey, { at: now, value: fallback });
    return fallback;
  } catch {
    return null;
  }
}

// ─── OHLCV History (Birdeye) ─────────────────────────────────────

export async function getHistoryOHLCV(tokenMint) {
  return getHistoryOHLCVFromBirdeye(tokenMint, 12);
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress = null, options = {}) {
  const cacheKey = getMarketSnapshotCacheKey(tokenMint, poolAddress, options);
  const bypassCache = options?.bypassCache === true;
  const includeOnChainSignals = options?.includeOnChainSignals !== false;
  const snapshotMode = includeOnChainSignals ? 'full-context' : 'timing-only';
  if (!bypassCache) {
    const cached = _marketSnapshotCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) <= MARKET_SNAPSHOT_CACHE_TTL_MS) {
      return cached.value;
    }

    if (_marketSnapshotInflight.has(cacheKey)) {
      return _marketSnapshotInflight.get(cacheKey);
    }
  }

  const task = (async () => {
  const caller = String(options?.from || 'unknown');
  const usingPoolAddress = Boolean(poolAddress);
  if (caller === 'deploy_queue') {
    console.log(
      `[oracle] getMarketSnapshot queue token=${tokenMint?.slice?.(0, 8) || 'unknown'} ` +
      `pool=${poolAddress ? String(poolAddress).slice(0, 8) : 'none'} poolAddressUsed=${usingPoolAddress ? 'yes' : 'no'}`
    );
    console.log(`[oracle] getMarketSnapshot queue mode=${snapshotMode} bypassCache=${bypassCache ? 'yes' : 'no'}`);
  }
  const [ohlcvR, poolR, onChainR, sentimentR, smartMoneyR, jupiterPriceR, meteoraPriceR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress, {
      includeEntryCandles5m: options?.includeEntryCandles5m === true,
      bypassCache,
    }),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    includeOnChainSignals ? getOnChainSignals(tokenMint) : Promise.resolve(null),
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
    snapshotMode,
    includeOnChainSignals,
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
  })();

  if (!bypassCache) {
    _marketSnapshotInflight.set(cacheKey, task);
  }
  try {
    const snapshot = await task;
    _marketSnapshotCache.set(cacheKey, { at: Date.now(), value: snapshot });
    return snapshot;
  } finally {
    if (!bypassCache) {
      _marketSnapshotInflight.delete(cacheKey);
    }
  }
}

export function __resetMarketSnapshotCacheForTests() {
  _marketSnapshotCache.clear();
  _marketSnapshotInflight.clear();
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
