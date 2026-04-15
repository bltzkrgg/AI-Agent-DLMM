/**
 * Technical Analysis Utility
 * 
 * Lightweight implementation of indicators for micin tokens.
 * Focus: RSI, Supertrend.
 */

// ─── Basic Math ──────────────────────────────────────────────────

function sma(prices, period) {
  if (prices.length < period) return null;
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = prices[0];
  for (let i = 1; i < prices.length; i++) {
    emaVal = prices[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function stdDev(prices, period) {
  if (prices.length < period) return 0;
  const mean = sma(prices, period);
  const variance = prices.slice(-period).reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

// ─── Indicators ──────────────────────────────────────────────────

/**
 * Relative Strength Index (RSI)
 */
export function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;
  
  let gains = [];
  let losses = [];
  
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  
  let avgGain = sma(gains.slice(0, period), period);
  let avgLoss = sma(losses.slice(0, period), period);
  
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Supertrend
 */
export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period) return { trend: 'NEUTRAL', value: 0 };

  // 1. ATR calculation
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const hl = c.high - c.low;
    const hpc = Math.abs(c.high - candles[i-1].close);
    const lpc = Math.abs(c.low - candles[i-1].close);
    return Math.max(hl, hpc, lpc);
  });
  
  const atrs = [];
  let atr = sma(trs.slice(0, period), period);
  atrs.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }

  // 2. Bands
  let finalUpper = 0, finalLower = 0, trend = 1; // 1 = Bull, -1 = Bear
  let supertrendArr = [];
  let previousTrend = 1;

  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const currAtr = i < period ? atrs[0] : atrs[i - period + 1];
    
    let basicUpper = hl2 + multiplier * currAtr;
    let basicLower = hl2 - multiplier * currAtr;
    
    if (i === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      finalUpper = (basicUpper < finalUpper || candles[i-1].close > finalUpper) ? basicUpper : finalUpper;
      finalLower = (basicLower > finalLower || candles[i-1].close < finalLower) ? basicLower : finalLower;
    }
    
    if (i === candles.length - 2) previousTrend = trend; // Capture trend before the last candle

    if (trend === 1 && candles[i].close < finalLower) {
      trend = -1;
    } else if (trend === -1 && candles[i].close > finalUpper) {
      trend = 1;
    }
    supertrendArr.push(trend === 1 ? finalLower : finalUpper);
  }

  return {
    trend: trend === 1 ? 'BULLISH' : 'BEARISH',
    value: supertrendArr[supertrendArr.length - 1],
    atr: atrs[atrs.length - 1],
    changed: trend !== previousTrend
  };
}
