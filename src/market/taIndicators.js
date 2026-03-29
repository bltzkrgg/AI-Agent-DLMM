/**
 * Technical Analysis Indicators
 *
 * Pure computation functions — no side effects, no API calls.
 * Input:  arrays of candle OHLCV data
 * Output: indicator values with trading interpretation
 *
 * All functions return null when there is not enough data.
 */

// ─── EMA helper (internal) ───────────────────────────────────────

function emaArray(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(val);
  for (let i = period; i < data.length; i++) {
    val = data[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// ─── RSI (Wilder smoothing) ──────────────────────────────────────
// period=2 for Evil Panda exit signal (RSI(2) > 90)

export function computeRSI(closes, period = 14) {
  if (closes.length < period + 2) return null;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains  = deltas.map(d => d > 0 ? d : 0);
  const losses = deltas.map(d => d < 0 ? -d : 0);

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ─── Bollinger Bands ─────────────────────────────────────────────
// Default: period=20, stdDevMult=2

export function computeBollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const slice   = closes.slice(-period);
  const sma     = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
  const stdDev  = Math.sqrt(variance);
  const upper   = sma + stdDevMult * stdDev;
  const lower   = sma - stdDevMult * stdDev;
  const last    = closes[closes.length - 1];

  return {
    upper:      parseFloat(upper.toFixed(10)),
    middle:     parseFloat(sma.toFixed(10)),
    lower:      parseFloat(lower.toFixed(10)),
    bandwidth:  parseFloat(((upper - lower) / sma * 100).toFixed(2)),
    aboveUpper: last > upper,
    belowLower: last < lower,
    percentB:   upper !== lower
      ? parseFloat(((last - lower) / (upper - lower) * 100).toFixed(2))
      : 50,
  };
}

// ─── MACD ────────────────────────────────────────────────────────
// Default: fast=12, slow=26, signal=9

export function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal + 1) return null;

  const emaFast = emaArray(closes, fast);
  const emaSlow = emaArray(closes, slow);

  // Align: emaSlow is shorter by (slow - fast) elements
  const offset   = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((v, i) => emaFast[i + offset] - v);

  if (macdLine.length < signal) return null;

  const signalLine    = emaArray(macdLine, signal);
  const alignOffset   = macdLine.length - signalLine.length;
  const histogram     = signalLine.map((v, i) => macdLine[i + alignOffset] - v);

  const last = histogram.length - 1;
  const prev = last - 1;

  return {
    macd:             parseFloat(macdLine[macdLine.length - 1].toFixed(10)),
    signal:           parseFloat(signalLine[last].toFixed(10)),
    histogram:        parseFloat(histogram[last].toFixed(10)),
    prevHistogram:    prev >= 0 ? parseFloat(histogram[prev].toFixed(10)) : null,
    // "First green after red" = histogram crosses from ≤0 to >0
    firstGreenAfterRed: prev >= 0 && histogram[prev] <= 0 && histogram[last] > 0,
  };
}

// ─── Supertrend (ATR-based) ───────────────────────────────────────
// Default: atrPeriod=10, multiplier=3 (common for 15m Evil Panda)
//
// direction: 1 = bullish (price above ST line), -1 = bearish (price below ST line)
// justCrossedAbove: true on the candle where it flipped from bearish to bullish
//   → this is the Evil Panda entry signal

export function computeSupertrend(highs, lows, closes, atrPeriod = 10, multiplier = 3) {
  const n = closes.length;
  if (n < atrPeriod + 2) return null;

  // True Range
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  // ATR — Wilder smoothing
  let atrVal = tr.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  const atrArr = new Array(n).fill(0);
  for (let i = 0; i < atrPeriod; i++) atrArr[i] = atrVal;
  for (let i = atrPeriod; i < n; i++) {
    atrVal = (atrVal * (atrPeriod - 1) + tr[i]) / atrPeriod;
    atrArr[i] = atrVal;
  }

  // Basic bands
  const basicUpper = new Array(n);
  const basicLower = new Array(n);
  for (let i = 0; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    basicUpper[i] = hl2 + multiplier * atrArr[i];
    basicLower[i] = hl2 - multiplier * atrArr[i];
  }

  // Final bands (prevent flipping)
  const finalUpper = [...basicUpper];
  const finalLower = [...basicLower];

  for (let i = 1; i < n; i++) {
    finalUpper[i] = (basicUpper[i] < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1])
      ? basicUpper[i] : finalUpper[i - 1];
    finalLower[i] = (basicLower[i] > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1])
      ? basicLower[i] : finalLower[i - 1];
  }

  // Supertrend line and direction
  const st  = new Array(n).fill(0);
  const dir = new Array(n).fill(-1); // -1 = bearish initial

  st[0]  = finalUpper[0];
  dir[0] = -1;

  for (let i = 1; i < n; i++) {
    if (st[i - 1] === finalUpper[i - 1]) {
      // Previous was bearish
      if (closes[i] > finalUpper[i]) {
        st[i]  = finalLower[i]; // flipped bullish
        dir[i] = 1;
      } else {
        st[i]  = finalUpper[i]; // still bearish
        dir[i] = -1;
      }
    } else {
      // Previous was bullish
      if (closes[i] < finalLower[i]) {
        st[i]  = finalUpper[i]; // flipped bearish
        dir[i] = -1;
      } else {
        st[i]  = finalLower[i]; // still bullish
        dir[i] = 1;
      }
    }
  }

  const last = n - 1;
  const prev = last - 1;

  return {
    value:            parseFloat(st[last].toFixed(10)),
    direction:        dir[last],            // 1 = bullish, -1 = bearish
    isBullish:        dir[last] === 1,
    justCrossedAbove: dir[prev] === -1 && dir[last] === 1,  // ← Evil Panda entry
    lastClose:        closes[last],
  };
}

// ─── ATR (Average True Range) ────────────────────────────────────
// Returns ATR as both absolute price and % of current price.
// Used by calcDynamicRangePct below.

export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);
  const closes = candles.map(c => c.c);

  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }

  const currentPrice = closes[closes.length - 1];
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

  return {
    atrAbs:      parseFloat(atr.toFixed(10)),
    atrPct:      parseFloat(atrPct.toFixed(3)),
    atrCategory: atrPct > 5 ? 'HIGH' : atrPct > 1.5 ? 'MEDIUM' : 'LOW',
  };
}

// ─── Dynamic LP Range Calculator ─────────────────────────────────
// Target: 80-95% probability price stays in range during holding period.
//
// Base formula:
//   ATR × 6  ≈ 95% CI for 4h hold on 15m TF (√16 candles × 2σ × safe buffer)
//   OR range24h × 0.9  (cover 90% of yesterday's full swing)
//   whichever is larger → true range floor
//
// strategyType: 'evil_panda' | 'single_side_y'

export function calcDynamicRangePct({
  atr14Pct    = 0,
  range24hPct = 0,
  trend       = 'SIDEWAYS',
  bbBandwidth = 0,
  strategyType = 'single_side_y',
} = {}) {
  const atrBase = atr14Pct * 6.0;
  let base = Math.max(atrBase, range24hPct * 0.9, 5);

  // Trend adjustments
  if (trend === 'DOWNTREND') base *= 1.35; // wider — dumps are fast & deep
  if (trend === 'UPTREND')   base *= 0.90; // tighter — price moving in our favor

  // BB bandwidth regime
  if (bbBandwidth > 20) base *= 1.20; // expanding = breakout, needs more room
  if (bbBandwidth < 5)  base *= 0.85; // squeeze = tight consolidation, safer to narrow

  if (strategyType === 'evil_panda') {
    // EP: momentum strategy — wide range for 80-95% coverage
    return parseFloat(Math.min(Math.max(base * 1.3, 12), 80).toFixed(1));
  }
  // Default Single-Side SOL
  return parseFloat(Math.min(Math.max(base, 8), 50).toFixed(1));
}

// ─── Volume vs Average ────────────────────────────────────────────
// Compare volume of last 96 candles (24h on 15m TF) vs prior 96 candles

export function computeVolumeVsAvg(candles) {
  if (!candles || candles.length < 48) return 1.0; // not enough data
  const recent = candles.slice(-96);
  const prior  = candles.slice(-192, -96);
  if (prior.length < 10) return 1.0;
  const recentVol = recent.reduce((s, c) => s + (c.v || 0), 0);
  const priorVol  = prior.reduce((s, c) => s + (c.v || 0), 0);
  if (priorVol === 0) return 1.0;
  return parseFloat((recentVol / priorVol).toFixed(2));
}

// ─── Evil Panda Entry + Exit detection ───────────────────────────
//
// Entry:  Price break above Supertrend on 15m
// Exit:   ≥1 confluence pair from:
//   • RSI(2) > 90  +  price tutup di atas BB upper (period 20)
//   • RSI(2) > 90  +  MACD first green histogram after red

export function detectEvilPandaSignals(candles) {
  if (!candles || candles.length < 35) {
    return { entry: null, exit: null, raw: null };
  }

  const closes = candles.map(c => c.c);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);

  const rsi2 = computeRSI(closes, 2);
  const bb   = computeBollingerBands(closes, 20, 2);
  const macd = computeMACD(closes, 12, 26, 9);
  const st   = computeSupertrend(highs, lows, closes, 10, 3);

  // ── Entry ────────────────────────────────────────────────────
  const entry = st ? {
    triggered:        st.justCrossedAbove,
    isBullishTrend:   st.isBullish,
    reason: st.justCrossedAbove
      ? `Price baru cross di atas Supertrend 15m (close ${st.lastClose?.toFixed(6)} > ST ${st.value?.toFixed(6)})`
      : st.isBullish
        ? `Sudah di atas Supertrend — bisa entry jika fresh (tapi bukan fresh cross)`
        : `Price masih di BAWAH Supertrend — WAIT, belum saatnya entry`,
  } : null;

  // ── Exit ─────────────────────────────────────────────────────
  const rsiOverbought    = rsi2 !== null && rsi2 > 90;
  const bbUpperHit       = bb?.aboveUpper === true;
  const macdFirstGreen   = macd?.firstGreenAfterRed === true;

  const confluencePairs = [];
  if (rsiOverbought && bbUpperHit)     confluencePairs.push('RSI(2)>90 + BB upper hit');
  if (rsiOverbought && macdFirstGreen) confluencePairs.push('RSI(2)>90 + MACD first green');

  const exitTriggered = confluencePairs.length >= 1;

  const exit = {
    triggered: exitTriggered,
    signals:   confluencePairs,
    reason: exitTriggered
      ? `EXIT confluence: ${confluencePairs.join(' | ')}`
      : `HOLD — sinyal belum cukup (RSI2=${rsi2?.toFixed(1)}, BB upper ${bbUpperHit ? '✅' : '❌'}, MACD first green ${macdFirstGreen ? '✅' : '❌'})`,
    // Individual signal state for display
    rsi2,
    bbAboveUpper: bbUpperHit,
    macdFirstGreen,
  };

  return {
    entry,
    exit,
    raw: { rsi2, bb, macd, supertrend: st },
  };
}
