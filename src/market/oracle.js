import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import { heliusRpc } from '../utils/helius.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { getConfig } from '../config.js';
import * as ta from '../utils/ta.js';
import { getPoolSmartMoney } from '../market/lpAgent.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const METEORA_DATAPI = 'https://dlmm-api.meteora.ag';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// ─── 1. OHLCV — Price Snapshot (DexScreener) ────────────────────
// Rerouted to DexScreener as the primary source for price/volatility logic.
// Oracle: OHLCV + TA dari DexScreener untuk Evil Panda entry/exit.

export async function getOHLCV(tokenMint, poolAddress = null) {
  const dex = await buildOHLCVFromDexScreener(tokenMint, poolAddress);
  if (!poolAddress) return dex;

  // Fallback to Birdeye only when 15m historical TA from Dex is unavailable.
  // Keep Dex as the default source to preserve existing behavior.
  const needFallback = !dex || dex?.historySuccess !== true || dex?.ta?.supertrend?.source === 'Momentum-Proxy';
  if (!needFallback) return dex;

  const birdeye = await buildOHLCVFromBirdeye(tokenMint, dex);
  return birdeye || dex;
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
      priceChange5m: safeNum(best.priceChange?.m5),
      priceChange1h: safeNum(best.priceChange?.h1),
      priceChange6h: safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      liquidityUsd: safeNum(best.liquidity?.usd),
      buys24h: buys, sells24h: sells, buyPressurePct,
      fdv: safeNum(best.fdv),
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
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

  if (taSource === 'DexScreener-15m') taConfidence += 0.24;
  else if (taSource === 'Birdeye-15m') taConfidence += 0.22;
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
    const history = await getHistoryOHLCVFromBirdeye(tokenMint, 12);
    if (!Array.isArray(history) || history.length < 12) return null;

    const closedCandles = history.slice(0, -1);
    if (closedCandles.length < 10) return null;

    const last = closedCandles[closedCandles.length - 1];
    const first = closedCandles[0];
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
      historyWindowSec: safeNum(last.time - first.time),
    };
  } catch {
    return null;
  }
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

    const txns24h = best.txns?.h24 || {};
    const buys24h = safeNum(txns24h.buys);
    const sells24h = safeNum(txns24h.sells);
    const total24h = buys24h + sells24h;
    const buyPressurePct = total24h > 0 ? safeNum((buys24h / total24h * 100).toFixed(1)) : 50;

    const p1h  = priceChange1h || 0;
    const p5m  = priceChangeM5 || 0;
    const bp   = buyPressurePct;

    // Momentum proxy fallback (always available from DexScreener latest pair stats).
    const isBullishProxy = (p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1);
    const isBearishProxy = (p1h < -5 || bp < 35);

    let historySuccess = false;
    let taData = {
      supertrend: {
        trend: isBullishProxy ? 'BULLISH' : (isBearishProxy ? 'BEARISH' : 'NEUTRAL'),
        value: currentPrice || 0,
        source: 'Momentum-Proxy'
      },
      candleCount: 0,
      historySuccess: false,
      "Evil Panda": {
        entry: {
          triggered: isBullishProxy,
          reason: isBullishProxy ? `EVIL PANDA MOMENTUM: Trend Bullish (1h: ${p1h}%, BP: ${bp}%).` : null
        },
        exit: {
          triggered: isBearishProxy,
          reason: isBearishProxy ? 'MOMENTUM EXIT: Sell pressure ekstrim.' : null
        }
      }
    };

    // Prefer real 15m Supertrend from OHLCV history when pool address is available.
    if (poolAddress) {
      const history = await getHistoryOHLCV(poolAddress);
      const closedCandles = Array.isArray(history) ? history.slice(0, -1) : [];
      if (closedCandles.length >= 10) {
        const st = ta.calculateSupertrend(closedCandles, 10, 3);
        const lastClose = closedCandles[closedCandles.length - 1]?.close || currentPrice || 0;
        const isBullish = st?.trend === 'BULLISH';
        const isBearish = st?.trend === 'BEARISH';

        taData = {
          supertrend: {
            trend: st?.trend || 'NEUTRAL',
            value: Number.isFinite(st?.value) ? st.value : lastClose,
            atr: Number.isFinite(st?.atr) ? st.atr : null,
            changed: Boolean(st?.changed),
            source: 'DexScreener-15m'
          },
          candleCount: closedCandles.length,
          historySuccess: true,
          "Evil Panda": {
            entry: {
              triggered: isBullish,
              reason: isBullish ? `EVIL PANDA TREND: Supertrend 15m bullish (${closedCandles.length} candles).` : null
            },
            exit: {
              triggered: isBearish,
              reason: isBearish ? 'TREND EXIT: Supertrend 15m bearish.' : null
            }
          }
        };
        historySuccess = true;
      }
    }

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

export async function getHistoryOHLCV(poolAddress) {
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

    // Validate that mapped fields are not all NaN (API shape change guard)
    const validCandles = raw.filter(c => Number.isFinite(c.close) && c.close > 0);
    if (raw.length > 0 && validCandles.length === 0) {
      console.warn('[oracle] DexScreener OHLCV: all candles have invalid close prices — possible API shape change');
      return null;
    }

    // Aggregate to 15m for Sniper Bullish Guard
    return aggregateCandles(validCandles, 15);
  } catch { return null; }
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
  const apiKey = process.env.OKX_API_KEY || '';
  if (!apiKey) {
    return { available: false, reason: 'OKX_API_KEY missing' };
  }
  return {
    available: true,
    mode: 'api_key_only',
    reason: 'OKX credentials in simple mode (API key only) loaded',
  };
}
