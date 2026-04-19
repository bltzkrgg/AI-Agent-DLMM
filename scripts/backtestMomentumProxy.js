#!/usr/bin/env node
/**
 * scripts/backtestMomentumProxy.js
 *
 * Offline backtest: compares Momentum-Proxy (DexScreener price-change + buy-pressure)
 * against candle-based Supertrend (15m, period=10, multiplier=3).
 * Supports real OHLCV input file (recommended) and synthetic fallback.
 *
 * Usage:
 *   node scripts/backtestMomentumProxy.js [--input FILE] [--candles N] [--seed S]
 *
 * Output:
 *   • metrics printed to stdout
 *   • JSON written to scripts/backtest-results.json
 *
 * Signal mapping
 * ──────────────
 *   Supertrend (ground-truth): BULLISH | BEARISH | NEUTRAL
 *   Proxy:
 *     BULLISH  when (p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1)
 *     BEARISH  when (p1h < -5 || bp < 35)
 *     NEUTRAL  otherwise
 *
 * Metrics (per signal class):
 *   match rate      = signals where proxy === supertrend / total
 *   false-positive  = proxy says BULLISH / BEARISH but supertrend disagrees
 *   false-negative  = supertrend says BULLISH / BEARISH but proxy says NEUTRAL / opposite
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Import Supertrend from repo utils ───────────────────────────
const { calculateSupertrend } = await import('../src/utils/ta.js');

// ─── CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
};
const inputPathRaw = getArg('--input');
const candleCount = parseInt(getArg('--candles') || '200', 10) || 200;
const seed        = parseInt(getArg('--seed') || '42', 10) || 42;
const inputPath = inputPathRaw
  ? (inputPathRaw.startsWith('/') ? inputPathRaw : join(process.cwd(), inputPathRaw))
  : null;

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────
function makePrng(s) {
  return function () {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Synthetic OHLCV generator ───────────────────────────────────
/**
 * Generates realistic-ish 15m SOL/USDC-style candles via a mean-reverting random walk.
 * buy_pressure is derived from candle body direction + noise, mimicking real DexScreener stats.
 */
function generateOHLCV(n, rng) {
  const candles = [];
  let price = 140;                 // starting price (~SOL range)
  let trend  = 1;                  // 1 = up-drift, -1 = down-drift

  for (let i = 0; i < n; i++) {
    // Occasional regime flip
    if (rng() < 0.04) trend = -trend;

    const vol    = price * (0.004 + rng() * 0.014);   // 0.4%–1.8% candle range
    const drift  = trend * price * 0.001 * rng();

    const open   = price;
    const close  = Math.max(0.001, price + drift + (rng() - 0.5) * vol);
    const high   = Math.max(open, close) + rng() * vol * 0.4;
    const low    = Math.min(open, close) - rng() * vol * 0.4;

    // Simulate buy-pressure: bullish candle → high BP; bearish → low BP
    const bullishBody = close > open;
    const bp = bullishBody
      ? 50 + rng() * 40        // 50–90%
      : 10 + rng() * 40;       // 10–50%

    // Derived DexScreener-style stats (in percent)
    const priceChangeM5 = ((close - open) / open) * 100;
    // p1h is a weighted average of recent price changes (simplified: last candle contributes ~40%)
    const priceChangeH1 = priceChangeM5 * (0.3 + rng() * 0.4);

    candles.push({
      time: 1700000000 + i * 900,
      open, high, low, close,
      volume: 1000 + rng() * 50000,
      // Proxy inputs (not part of real OHLCV schema but stored alongside for backtest)
      _meta: { priceChangeM5, priceChangeH1, buyPressurePct: bp },
    });

    price = close;
  }

  return candles;
}

function mapRawCandle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tsRaw = Number(raw.time ?? raw.t ?? raw.unixTime ?? raw.timestamp ?? NaN);
  const time = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw;
  const open = Number(raw.open ?? raw.o ?? NaN);
  const high = Number(raw.high ?? raw.h ?? NaN);
  const low = Number(raw.low ?? raw.l ?? NaN);
  const close = Number(raw.close ?? raw.c ?? NaN);
  const volume = Number(raw.volume ?? raw.v ?? 0);

  if (![time, open, high, low, close].every(Number.isFinite) || close <= 0) return null;

  const p5m = Number(raw.priceChangeM5 ?? raw.p5m ?? raw._meta?.priceChangeM5 ?? ((close - open) / open) * 100);
  const p1h = Number(raw.priceChangeH1 ?? raw.p1h ?? raw._meta?.priceChangeH1 ?? p5m);
  const bp = Number(raw.buyPressurePct ?? raw.bp ?? raw._meta?.buyPressurePct ?? 50);

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    _meta: {
      priceChangeM5: Number.isFinite(p5m) ? p5m : 0,
      priceChangeH1: Number.isFinite(p1h) ? p1h : 0,
      buyPressurePct: Number.isFinite(bp) ? bp : 50,
    },
  };
}

function loadCandlesFromInput(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  const rawText = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(rawText);
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.candles)
      ? parsed.candles
      : Array.isArray(parsed?.data?.items)
        ? parsed.data.items
        : Array.isArray(parsed?.data?.candles)
          ? parsed.data.candles
          : [];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const mapped = arr.map(mapRawCandle).filter(Boolean).sort((a, b) => a.time - b.time);
  return mapped.length >= 20 ? mapped : null;
}

// ─── Momentum-Proxy classifier (mirrors oracle.js logic exactly) ─
function classifyProxy({ priceChangeM5: p5m, priceChangeH1: p1h, buyPressurePct: bp }) {
  const isBullish = (p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1);
  const isBearish = (p1h < -5 || bp < 35);
  if (isBullish) return 'BULLISH';
  if (isBearish) return 'BEARISH';
  return 'NEUTRAL';
}

// ─── Run backtest ─────────────────────────────────────────────────
function runBacktest(candles) {
  const WINDOW  = 11;   // min candles for Supertrend (period=10 + 1 lookback)
  const results = [];

  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(i - WINDOW, i);  // sliding 15m window
    const st     = calculateSupertrend(window, 10, 3);
    const proxy  = classifyProxy(candles[i]._meta);

    results.push({
      index: i,
      supertrendSignal: st.trend,     // ground-truth
      proxySignal:      proxy,
      match: st.trend === proxy,
    });
  }

  return results;
}

// ─── Compute metrics ──────────────────────────────────────────────
function computeMetrics(results) {
  const total = results.length;

  // Overall match rate
  const matches    = results.filter(r => r.match).length;
  const matchRate  = total > 0 ? matches / total : 0;

  // Per-class metrics
  const classes = ['BULLISH', 'BEARISH', 'NEUTRAL'];
  const perClass = {};

  for (const cls of classes) {
    const gtPositive   = results.filter(r => r.supertrendSignal === cls);
    const proxyPositive = results.filter(r => r.proxySignal === cls);

    // True positives: both agree on cls
    const tp = results.filter(r => r.supertrendSignal === cls && r.proxySignal === cls).length;

    // False positive: proxy says cls but supertrend disagrees
    const fp = proxyPositive.length - tp;
    const fpRate = proxyPositive.length > 0 ? fp / proxyPositive.length : 0;

    // False negative: supertrend says cls but proxy missed (says something else)
    const fn_ = gtPositive.length - tp;
    const fnRate = gtPositive.length > 0 ? fn_ / gtPositive.length : 0;

    const precision = proxyPositive.length > 0 ? tp / proxyPositive.length : 0;
    const recall    = gtPositive.length    > 0 ? tp / gtPositive.length    : 0;

    perClass[cls] = {
      gtCount:       gtPositive.length,
      proxyCount:    proxyPositive.length,
      truePositives: tp,
      falsePositiveRate:  parseFloat(fpRate.toFixed(4)),
      falseNegativeRate:  parseFloat(fnRate.toFixed(4)),
      precision:          parseFloat(precision.toFixed(4)),
      recall:             parseFloat(recall.toFixed(4)),
    };
  }

  return { total, matches, matchRate: parseFloat(matchRate.toFixed(4)), perClass };
}

// ─── Main ─────────────────────────────────────────────────────────
const rng = makePrng(seed);
const candlesFromInput = inputPath ? loadCandlesFromInput(inputPath) : null;
if (inputPath && !candlesFromInput) {
  console.warn(`[backtest] Input file tidak valid sebagai OHLCV candles: ${inputPath}`);
  console.warn('[backtest] Fallback ke synthetic generator. Gunakan file berisi array candles (time/o/h/l/c/v).');
}
const candles = candlesFromInput || generateOHLCV(candleCount, rng);
const results = runBacktest(candles);
const metrics = computeMetrics(results);

const output = {
  meta: {
    generatedAt:    new Date().toISOString(),
    candleCount: candles.length,
    seed,
    inputSource: candlesFromInput ? 'real_input' : 'synthetic',
    inputPath: candlesFromInput ? inputPath : null,
    supertrendParams: { period: 10, multiplier: 3 },
    proxyLogic: {
      bullish: '(p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1)',
      bearish: '(p1h < -5 || bp < 35)',
      neutral: 'otherwise',
    },
  },
  metrics,
  interpretation: {
    matchRate:   `${(metrics.matchRate * 100).toFixed(1)}% of candles: proxy signal === supertrend signal`,
    bullishFPR:  `${(metrics.perClass.BULLISH.falsePositiveRate * 100).toFixed(1)}% of proxy BULLISH calls are false alarms`,
    bullishFNR:  `${(metrics.perClass.BULLISH.falseNegativeRate * 100).toFixed(1)}% of real BULLISH moves missed by proxy`,
    bearishFPR:  `${(metrics.perClass.BEARISH.falsePositiveRate * 100).toFixed(1)}% of proxy BEARISH calls are false alarms`,
    bearishFNR:  `${(metrics.perClass.BEARISH.falseNegativeRate * 100).toFixed(1)}% of real BEARISH moves missed by proxy`,
  },
};

// ─── Print summary ────────────────────────────────────────────────
console.log('\n=== Momentum-Proxy vs Supertrend Backtest ===');
console.log(`Candles: ${candles.length} | Seed: ${seed} | Evaluated: ${metrics.total}`);
console.log(`Source: ${candlesFromInput ? `real input (${inputPath})` : 'synthetic generator'}`);
console.log(`\nOverall match rate:   ${(metrics.matchRate * 100).toFixed(1)}%  (${metrics.matches}/${metrics.total})`);
console.log('\nPer-class breakdown:');
for (const [cls, m] of Object.entries(metrics.perClass)) {
  console.log(`  ${cls.padEnd(8)} | GT: ${String(m.gtCount).padStart(4)} | Proxy: ${String(m.proxyCount).padStart(4)} | TP: ${String(m.truePositives).padStart(4)} | FPR: ${(m.falsePositiveRate*100).toFixed(1).padStart(5)}% | FNR: ${(m.falseNegativeRate*100).toFixed(1).padStart(5)}%`);
}
console.log('\nInterpretation:');
for (const [k, v] of Object.entries(output.interpretation)) {
  console.log(`  ${k}: ${v}`);
}

// ─── Write JSON result ────────────────────────────────────────────
const outPath = join(__dirname, 'backtest-results.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nResults written → ${outPath}\n`);
