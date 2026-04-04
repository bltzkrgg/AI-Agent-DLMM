/**
 * DLMM Oracle — multi-lens data gathering untuk LP decisions
 *
 * Semua signal dikumpulkan dan diinterpretasi dalam konteks DLMM LP,
 * bukan futures trading. Setiap signal punya arti berbeda untuk LP:
 *
 * OHLCV       → arah harga & volatilitas → pilih range width & strategi
 * On-Chain    → whale/holder risk → apakah SOL kamu aman di pool ini?
 * OKX         → smart money flow → orang beli token pakai SOL (bagus untuk single-side SOL)
 * Pool DLMM   → fee APR, velocity, health → apakah pool masih menghasilkan?
 * DexScreener → buy/sell pressure → range bias: atas atau bawah harga saat ini?
 */

import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import {
  computeRSI,
  computeBollingerBands,
  computeMACD,
  computeSupertrend,
  computeVolumeVsAvg,
  detectEvilPandaSignals,
  calculateATR,
} from './taIndicators.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const OKX_BASE         = 'https://www.okx.com/api/v5';
const METEORA_DATAPI   = 'https://dlmm.datapi.meteora.ag';
const GECKO_BASE       = 'https://api.geckoterminal.com/api/v2';

// ─── 0. Candle fetcher (GeckoTerminal) ───────────────────────────
// Returns normalized candles: [{ t, o, h, l, c, v }] oldest → newest
// timeframe: '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'
// poolAddressHint: skip token→pool lookup if caller already knows the pool address

export async function fetchCandles(tokenMint, timeframe = '15m', limit = 200, poolAddressHint = null) {
  try {
    const { period, aggregate } = mapTimeframe(timeframe);

    // Try pool address hint first (skip extra HTTP request)
    if (poolAddressHint) {
      const result = await fetchGeckoOHLCV(poolAddressHint, period, aggregate, limit);
      if (result) return result;
    }

    // Discover best pool for this token (by 24h volume)
    const poolAddress = await getTopPoolForToken(tokenMint);
    if (!poolAddress) return null;

    return fetchGeckoOHLCV(poolAddress, period, aggregate, limit);
  } catch {
    return null;
  }
}

function mapTimeframe(tf) {
  switch (tf) {
    case '1m':             return { period: 'minute', aggregate: 1 };
    case '3m':             return { period: 'minute', aggregate: 3 };
    case '5m':             return { period: 'minute', aggregate: 5 };
    case '15m':            return { period: 'minute', aggregate: 15 };
    case '30m':            return { period: 'minute', aggregate: 30 };
    case '45m':             return { period: 'minute', aggregate: 45 };
    case '1H': case '1h':  return { period: 'hour',   aggregate: 1 };
    case '4H': case '4h':  return { period: 'hour',   aggregate: 4 };
    case '8h':             return { period: 'hour',   aggregate: 8 };
    case '12h':            return { period: 'hour',   aggregate: 12 };
    case '24h':            return { period: 'hour',   aggregate: 24 };
    case '1D': case '1d':  return { period: 'day',    aggregate: 1 };
    default:               return { period: 'minute', aggregate: 15 };
  }
}

async function getTopPoolForToken(tokenMint) {
  const res = await fetchWithTimeout(
    `${GECKO_BASE}/networks/solana/tokens/${tokenMint}/pools?page=1&sort=h24_volume_usd_desc`,
    { headers: { Accept: 'application/json' } },
    8000
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const pools = data?.data || [];
  if (!pools.length) return null;
  // Use attributes.address (raw) or strip prefix from id
  const p = pools[0];
  return p?.attributes?.address
    || (p?.id ? p.id.replace(/^solana_/i, '') : null)
    || null;
}

async function fetchGeckoOHLCV(poolAddress, period, aggregate, limit) {
  const res = await fetchWithTimeout(
    `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${period}?aggregate=${aggregate}&limit=${limit}&currency=usd`,
    { headers: { Accept: 'application/json' } },
    10000
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const list = data?.data?.attributes?.ohlcv_list;
  if (!list || list.length < 5) return null;
  // GeckoTerminal returns newest-first → reverse to oldest-first
  return [...list].reverse().map(([t, o, h, l, c, v]) => ({
    t: +t, o: +o, h: +h, l: +l, c: +c, v: +v,
  }));
}

// ─── 1. OHLCV — untuk range positioning & volatilitas ───────────
// DLMM context:
//   - Trend UPTREND   → harga naik → single-side SOL range bawah akan ter-convert ke token
//   - Trend SIDEWAYS  → harga konsolidasi → spot balanced / single-side SOL ideal
//   - Trend DOWNTREND → harga turun → single-side SOL bisa kena IL berat
//   - Volatilitas tinggi → perlu range lebih lebar (bin step lebih besar)
//   - Support/Resistance → bisa dijadikan batas range atas/bawah

// GeckoTerminal primary (real 15m candles, free no key) → DexScreener fallback (price changes only, no TA)
export async function getOHLCV(tokenMint, poolAddress = null) {
  const candles = await fetchCandles(tokenMint, '15m', 200, poolAddress);

  if (candles && candles.length >= 20) {
    return buildOHLCVFromCandles(tokenMint, candles);
  }

  // Fallback: DexScreener price changes (no candles, approximate)
  return buildOHLCVFromDexScreener(tokenMint);
}

async function buildOHLCVFromCandles(tokenMint, candles) {
  const closes = candles.map(c => c.c);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);

  const currentPrice = closes[closes.length - 1];

  // Real high/low from last 96 15m candles = 24h
  const last96 = candles.slice(-96);
  const high24h = Math.max(...last96.map(c => c.h));
  const low24h  = Math.min(...last96.map(c => c.l));

  const range24hPct = low24h > 0
    ? parseFloat(((high24h - low24h) / low24h * 100).toFixed(2))
    : 0;

  // Trend from real candle closes (last 20 vs prior 20 candles)
  const recent20 = closes.slice(-20);
  const prior20  = closes.slice(-40, -20);
  let trend = 'SIDEWAYS';
  if (prior20.length >= 10) {
    const recentAvg = recent20.reduce((a, b) => a + b, 0) / recent20.length;
    const priorAvg  = prior20.reduce((a, b) => a + b, 0) / prior20.length;
    const changePct = priorAvg > 0 ? (recentAvg - priorAvg) / priorAvg * 100 : 0;
    if (changePct > 2)  trend = 'UPTREND';
    if (changePct < -2) trend = 'DOWNTREND';
  }

  // Real volume vs avg
  const volumeVsAvg = computeVolumeVsAvg(candles);

  // TA indicators
  const rsi14 = computeRSI(closes, 14);
  const rsi2  = computeRSI(closes, 2);
  const bb    = computeBollingerBands(closes, 20, 2);
  const macd  = computeMACD(closes, 12, 26, 9);
  const st    = computeSupertrend(highs, lows, closes, 10, 3);
  const ep    = detectEvilPandaSignals(candles);
  const atr14 = calculateATR(candles, 14);

  return {
    tokenMint,
    timeframe:      '15m',
    source:         'geckoterminal',
    currentPrice,
    priceChange:    closes.length >= 5 ? ((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5] * 100) : 0,
    high24h,
    low24h,
    range24hPct,
    avgVolume:      last96.reduce((s, c) => s + c.v, 0) / last96.length,
    latestVolume:   candles[candles.length - 1].v,
    volumeVsAvg,
    trend,
    support:    low24h,
    resistance: high24h,
    suggestedBinStepMin: range24hPct > 20 ? 20 : range24hPct > 7 ? 10 : 5,
    volatilityCategory:  range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
    dlmmNote: range24hPct > 30
      ? 'Volatilitas ekstrem — gunakan Bid-Ask Wide, hindari Curve Concentrated'
      : range24hPct > 15
      ? 'Volatilitas tinggi — single-side SOL cocok, range perlu lebih lebar'
      : 'Volatilitas normal — single-side SOL atau spot balanced ideal',
    // TA — real indicators
    ta: {
      rsi14,
      rsi2,
      bb,
      macd,
      supertrend: st ? { value: st.value, isBullish: st.isBullish, justCrossedAbove: st.justCrossedAbove } : null,
      evilPanda: ep,
    },
    atr14,
    candleCount: candles.length,
  };
}

// ─── Multi-Timeframe OHLCV + TA ──────────────────────────────────
// Fetches 15m, 1h, 4h in parallel.
// Each TF result includes TA signals + exitSignals count (for Healer).
// exitSignals scale: 0 = hold, 1 = watch, 2+ = consider exit, 4+ = strong exit

export async function fetchMultiTFOHLCV(tokenMint, poolAddress = null) {
  const [r15m, r1h, r4h] = await Promise.allSettled([
    fetchCandles(tokenMint, '15m', 100, poolAddress),
    fetchCandles(tokenMint, '1h',  60,  poolAddress),
    fetchCandles(tokenMint, '4h',  30,  poolAddress),
  ]);

  const result = {};
  if (r15m.status === 'fulfilled' && r15m.value?.length >= 35)
    result.tf15m = _buildTFAnalysis(r15m.value, '15m');
  if (r1h.status === 'fulfilled' && r1h.value?.length >= 20)
    result.tf1h  = _buildTFAnalysis(r1h.value,  '1h');
  if (r4h.status === 'fulfilled' && r4h.value?.length >= 14)
    result.tf4h  = _buildTFAnalysis(r4h.value,  '4h');
  return result;
}

// ─── Multi-TF Screening Score — 6 timeframe alignment ────────────
// Dipakai oleh hunter & opportunity scanner untuk menilai kekuatan trend
// lintas timeframe: 15m, 30m, 1h, 4h, 12h, 24h.
//
// Score 0.0–1.0:
//   0.0–0.3 → bearish/conflicted (skip)
//   0.3–0.6 → neutral (ok)
//   0.6–0.8 → bullish alignment (good entry)
//   0.8–1.0 → strong alignment across all TFs (high conviction)

export async function getMultiTFScore(tokenMint, poolAddress = null) {
  const TFS = [
    { tf: '15m', limit: 80,  minLen: 30 },
    { tf: '30m', limit: 60,  minLen: 20 },
    { tf: '1h',  limit: 48,  minLen: 15 },
    { tf: '4h',  limit: 30,  minLen: 10 },
    { tf: '12h', limit: 20,  minLen: 8  },
    { tf: '24h', limit: 14,  minLen: 5  },
  ];

  const results = await Promise.allSettled(
    TFS.map(({ tf, limit }) => fetchCandles(tokenMint, tf, limit, poolAddress))
  );

  let bullishCount = 0;
  let validCount   = 0;
  const breakdown  = {};

  for (let i = 0; i < TFS.length; i++) {
    const { tf, minLen } = TFS[i];
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value || r.value.length < minLen) continue;

    const candles = r.value;
    const closes  = candles.map(c => c.c);
    const highs   = candles.map(c => c.h);
    const lows    = candles.map(c => c.l);

    const st    = computeSupertrend(highs, lows, closes, 10, 3);
    const rsi14 = computeRSI(closes, 14);
    const macd  = computeMACD(closes, 12, 26, 9);

    // Bullish criteria: Supertrend bullish + RSI > 45 + MACD histogram > 0
    let bullish = 0;
    if (st?.isBullish === true)               bullish++;
    if (rsi14 !== null && rsi14 > 45)         bullish++;
    if (macd?.histogram !== null && macd.histogram > 0) bullish++;

    const isBullish = bullish >= 2; // ≥2/3 criteria = bullish for this TF
    if (isBullish) bullishCount++;
    validCount++;

    breakdown[tf] = {
      bullish: isBullish,
      supertrend: st?.isBullish ?? null,
      rsi14: rsi14 !== null ? parseFloat(rsi14.toFixed(1)) : null,
      macdPositive: macd?.histogram !== null ? macd.histogram > 0 : null,
    };
  }

  const score = validCount > 0 ? parseFloat((bullishCount / validCount).toFixed(3)) : 0;
  return { score, bullishCount, validCount, breakdown };
}

function _buildTFAnalysis(candles, label) {
  const closes = candles.map(c => c.c);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);

  const atr  = calculateATR(candles, 14);
  const st   = computeSupertrend(highs, lows, closes, 10, 3);
  const rsi14 = computeRSI(closes, 14);
  const rsi2  = computeRSI(closes, 2);
  const bb    = computeBollingerBands(closes, 20, 2);
  const macd  = computeMACD(closes, 12, 26, 9);
  const ep    = detectEvilPandaSignals(candles);

  // Count exit signals: 0 = hold, 4+ = strong exit
  let exitSignals = 0;
  if (rsi2 !== null && rsi2 > 85)                             exitSignals++;
  if (bb?.aboveUpper === true)                                exitSignals++;
  if (macd?.histogram !== null && macd.histogram < 0
    && macd.prevHistogram !== null && macd.prevHistogram >= 0) exitSignals++; // MACD cross bearish
  if (st?.isBullish === false)                                exitSignals += 2; // trend flip = strong

  return {
    label,
    currentPrice: closes[closes.length - 1],
    atr,
    supertrend: st ? { isBullish: st.isBullish, justCrossedAbove: st.justCrossedAbove } : null,
    rsi14, rsi2,
    bb:   bb   ? { bandwidth: bb.bandwidth, aboveUpper: bb.aboveUpper, percentB: bb.percentB } : null,
    macd: macd ? { histogram: macd.histogram, firstGreenAfterRed: macd.firstGreenAfterRed } : null,
    evilPanda: ep,
    exitSignals,
  };
}

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
    const priceChange1h  = safeNum(best.priceChange?.h1);
    const priceChange6h  = safeNum(best.priceChange?.h6);
    const priceChange24h = safeNum(best.priceChange?.h24);
    const volume24h      = safeNum(best.volume?.h24);
    const range24hPct    = Math.abs(priceChange24h);
    const high24h = currentPrice / (1 - Math.max(0, priceChange24h) / 100) || currentPrice;
    const low24h  = currentPrice / (1 + Math.max(0, -priceChange24h) / 100) || currentPrice;
    const trend   = (priceChange1h > 1 && priceChange6h > 0) ? 'UPTREND'
      : (priceChange1h < -1 && priceChange6h < 0)            ? 'DOWNTREND'
      : 'SIDEWAYS';

    return {
      tokenMint,
      timeframe:      '1h',
      source:         'dexscreener',
      currentPrice,
      priceChange:    priceChange1h,
      high24h, low24h,
      range24hPct:    parseFloat(range24hPct.toFixed(2)),
      avgVolume:      parseFloat((volume24h / 24).toFixed(2)),
      latestVolume:   parseFloat((volume24h / 24).toFixed(2)),
      volumeVsAvg:    1, // cannot compute accurately without candles
      trend,
      support:    low24h,
      resistance: high24h,
      suggestedBinStepMin: range24hPct > 20 ? 20 : range24hPct > 7 ? 10 : 5,
      volatilityCategory:  range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      dlmmNote: range24hPct > 30
        ? 'Volatilitas ekstrem — gunakan Bid-Ask Wide, hindari Curve Concentrated'
        : range24hPct > 15
        ? 'Volatilitas tinggi — single-side SOL cocok, range perlu lebih lebar'
        : 'Volatilitas normal — single-side SOL atau spot balanced ideal',
      ta: null, // no real TA without candles
      candleCount: 0,
    };
  } catch {
    return null;
  }
}

// ─── 2. On-Chain Signals (Helius) — untuk risk assessment ────────
// DLMM context:
//   - Whale selling massif → SOL kamu akan ter-absorb cepat ke posisi rugi
//   - Top 10 holder tinggi → dump risk → hindari pool dengan token ini
//   - Banyak transaksi recent → token masih aktif diperdagangkan → bagus untuk fee

export async function getOnChainSignals(tokenMint) {
  return getHeliusOnChainSignals(tokenMint);
}

// ─── 3. OKX Smart Money — untuk arah entry & strategi ────────────
// DLMM context:
//   - SM buying token (pakai SOL) → demand tinggi → single-side SOL akan ter-convert
//     ke token cepat (fee terkumpul, tapi SOL habis duluan)
//   - SM selling token → supply tinggi → single-side SOL range bawah akan aktif
//     (orang jual token dapat SOL dari range kamu) → fee terkumpul lama
//   - SM neutral → spot balanced atau single-side SOL ideal

export async function getOKXData(tokenMint) {
  if (!process.env.OKX_API_KEY) {
    return { available: false, reason: 'OKX_API_KEY not set' };
  }
  const chainId = '501'; // Solana
  const headers = { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'Content-Type': 'application/json' };
  try {
    const [secRes, smartRes] = await Promise.allSettled([
      fetchWithTimeout(
        `${OKX_BASE}/dex/security/token?chainId=${chainId}&tokenContractAddress=${tokenMint}`,
        { headers }, 8000
      ),
      fetchWithTimeout(
        `${OKX_BASE}/dex/ai-market/token-signal?chainId=${chainId}&tokenAddress=${tokenMint}`,
        { headers }, 8000
      ),
    ]);

    const sec   = (secRes.status   === 'fulfilled' && secRes.value.ok)
      ? (await secRes.value.json().catch(() => ({}))).data?.[0]   || {} : {};
    const smart = (smartRes.status === 'fulfilled' && smartRes.value.ok)
      ? (await smartRes.value.json().catch(() => ({}))).data?.[0] || {} : {};

    const smSignal = smart.signal ?? null;
    const smBuying = smart.smartMoneyBuying ?? null;

    return {
      available: true,
      riskLevel:          sec.riskLevel          ?? null,
      isHoneypot:         sec.isHoneypot          ?? false,
      isMintable:         sec.isMintable          ?? false,
      ownershipRenounced: sec.ownershipRenounced  ?? null,
      smartMoneyBuying:   smBuying,
      smartMoneySelling:  smart.smartMoneySelling ?? null,
      smartMoneySignal:   smSignal,
      signalStrength:     smart.signalStrength    ?? null,
      // DLMM context
      dlmmNote: smBuying === true
        ? 'Smart money BELI token — SOL range kamu akan cepat ter-convert ke token, fee terkumpul tapi SOL habis'
        : smBuying === false
        ? 'Smart money JUAL token — SOL range kamu akan jadi tempat orang jual, fee terkumpul stabil'
        : 'Smart money neutral — single-side SOL atau spot balanced cocok',
      solRangeOutlook: smBuying === true ? 'FAST_CONSUME' : smBuying === false ? 'STABLE_EARNING' : 'NEUTRAL',
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── 4. DLMM Pool Data (Meteora datapi) ─────────────────────────

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
    const fees7d      = safeNum(pool.fees?.['7d']   ?? pool.fees_7d  ?? 0);
    const volume24h   = safeNum(pool.volume?.['24h'] ?? pool.trade_volume_24h ?? 0);
    const tvl         = safeNum(pool.tvl ?? pool.liquidity ?? 0);
    const feeApr      = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep     = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    const feeAprCategory = feeApr >= 100 ? 'HIGH' : feeApr >= 30 ? 'MEDIUM' : 'LOW';
    const avgDaily7d     = fees7d > 0 ? fees7d / 7 : 0;
    const feeVelocity    =
      avgDaily7d > 0 && fees24h > avgDaily7d * 1.2 ? 'INCREASING' :
      avgDaily7d > 0 && fees24h < avgDaily7d * 0.8 ? 'DECREASING' : 'STABLE';

    return {
      address: poolAddress, name: pool.name || '',
      tvl, volume24h, fees24h,
      feeApr: parseFloat(feeApr.toFixed(2)), feeAprCategory,
      feeTvlRatio: parseFloat(feeTvlRatio.toFixed(4)), feeVelocity,
      binStep,
      tokenXMint: pool.token_x?.address || null,
      tokenYMint: pool.token_y?.address || null,
    };
  } catch { return null; }
}

// ─── 5. DexScreener — buy/sell pressure & range bias ────────────

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
      // DLMM context
      dlmmNote: buyPressurePct > 65
        ? 'Banyak yang BELI token — range SOL di bawah harga akan cepat habis ter-convert, fee cepat tapi posisi singkat'
        : buyPressurePct < 35
        ? 'Banyak yang JUAL token — single-side SOL ideal, SOL range aktif lama mengumpulkan fee'
        : 'Seimbang — single-side SOL atau spot balanced sama-sama viable',
    };
  } catch { return null; }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [ohlcvR, poolR, onChainR, sentimentR, okxR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    getOKXData(tokenMint),
  ]);

  const ohlcv     = ohlcvR.status     === 'fulfilled' ? ohlcvR.value     : null;
  const pool      = poolR.status      === 'fulfilled' ? poolR.value      : null;
  const onChain   = onChainR.status   === 'fulfilled' ? onChainR.value   : null;
  const sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const okx       = okxR.status       === 'fulfilled' ? okxR.value       : null;

  // DLMM health score
  let healthScore = 50;
  if (pool) {
    healthScore += pool.feeAprCategory === 'HIGH' ? 20 : pool.feeAprCategory === 'LOW' ? -20 : 0;
    healthScore += pool.feeVelocity === 'INCREASING' ? 15 : pool.feeVelocity === 'DECREASING' ? -15 : 0;
    healthScore += pool.feeTvlRatio > 0.05 ? 10 : pool.feeTvlRatio < 0.01 ? -10 : 0;
  }
  if (onChain?.available) {
    healthScore += onChain.whaleRisk === 'HIGH' ? -15 : onChain.whaleRisk === 'LOW' ? 5 : 0;
  }
  if (okx?.available) {
    healthScore += okx.isHoneypot ? -30 : 0;
    healthScore += okx.riskLevel === 'high' ? -15 : okx.riskLevel === 'low' ? 5 : 0;
  }
  healthScore = Math.max(0, Math.min(100, healthScore));

  // Backward-compat fields untuk matchStrategyToMarket
  const trend = ohlcv?.trend || sentiment?.sentiment === 'BULLISH' ? 'UPTREND'
    : sentiment?.sentiment === 'BEARISH' ? 'DOWNTREND' : 'SIDEWAYS';

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool, onChain, sentiment, okx,
    healthScore,
    // TA signals — surfaced at top level for easy access by agents
    ta:   ohlcv?.ta   || null,
    dataSource: ohlcv?.source || 'unknown',
    // Backward-compat
    liquidity: pool ? { tvl: pool.tvl, volume24h: pool.volume24h, feeApr: pool.feeApr } : null,
    price: sentiment ? {
      currentPrice: sentiment.priceUsd,
      trend: ohlcv?.trend || 'SIDEWAYS',
      volatility24h: ohlcv?.range24hPct || 0,
      volatilityCategory: ohlcv?.volatilityCategory || 'MEDIUM',
      buyPressurePct: sentiment.buyPressurePct,
      sentiment: sentiment.sentiment,
      suggestedBinStepMin: ohlcv?.suggestedBinStepMin || 10,
    } : null,
  };
}
