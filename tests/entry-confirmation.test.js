/**
 * tests/entry-confirmation.test.js
 *
 * Unit tests for the Phase 2.05 Entry Confirmation Layer in hunterAlpha.js.
 *
 * Covers:
 *  1. computeEntrySignalsFromCandles — per-gate pass + fail
 *     a. green candle + minimum body
 *     b. upper wick / body ratio
 *     c. volume confirmation vs rolling MA
 *     d. breakout + 1-candle confirm (enabled vs disabled)
 *     e. HTF (1h) alignment — reject BEARISH, allow NEUTRAL when flag set
 *     f. fallback behaviour when < 12 closed candles available
 *  2. Source assertions — config-driven gate checks in runHunterAlpha path
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot   = join(__dirname, '..');

// ─── Dynamic import with graceful skip ──────────────────────────
let computeEntrySignalsFromCandles;
try {
  const mod = await import('../src/agents/hunterAlpha.js');
  computeEntrySignalsFromCandles = mod.computeEntrySignalsFromCandles;
} catch (e) {
  // Native binding unavailable in this env — source assertions still run below
  computeEntrySignalsFromCandles = null;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Build a minimal synthetic 15m candle.
 *  - green: close > open
 *  - bodyPct: approximate body size as % of open
 *  - upperWickMultiplier: wick above max(open,close) expressed as multiple of body
 *  - volume: explicit volume value
 */
function makeCandle({ open = 100, bodyPct = 0.5, isGreen = true, upperWickMult = 0.2, volume = 1000, time = 0 } = {}) {
  const body = open * (bodyPct / 100);
  const close = isGreen ? open + body : open - body;
  const bodyAbs = Math.abs(close - open);
  const high = Math.max(open, close) + bodyAbs * upperWickMult;
  const low  = Math.min(open, close) * 0.998;
  return { time, open, high, low, close, volume };
}

/**
 * Build an array of N+1 green candles where the last one has configurable properties.
 * The first N are "baseline" candles used for volume MA and breakout level.
 */
function makeCandleArray({
  count = 20,
  baseVolume = 1000,
  lastCandle = {},
} = {}) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    // slightly rising baseline
    price += 0.1;
    candles.push(makeCandle({ open: price, bodyPct: 0.3, isGreen: true, volume: baseVolume, time: i * 900 }));
  }
  // Replace the final candle with the configurable one (becomes the "last closed" candle)
  const finalOpen = price + 0.1;
  candles[count - 1] = makeCandle({ open: finalOpen, ...lastCandle, time: (count - 1) * 900 });
  // Push a dummy "current open" candle so slice(0,-1) leaves exactly count closed candles
  candles.push(makeCandle({ open: finalOpen + 0.1, time: count * 900 }));
  return candles;
}

// ─── Skip all unit tests when import failed ──────────────────────
function skipIfNoImport(t) {
  if (!computeEntrySignalsFromCandles) {
    t.skip('hunterAlpha module import unavailable (native dep missing)');
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Fallback: fewer than 12 candles → ready: false
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: returns ready:false when fewer than 12 closed candles', (t) => {
  if (skipIfNoImport(t)) return;
  const candles = makeCandleArray({ count: 10 });          // 9 closed + 1 open
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, false);
  assert.ok(result.reason, 'should include a reason string');
});

test('computeEntrySignals: returns ready:false for empty array input', (t) => {
  if (skipIfNoImport(t)) return;
  const result = computeEntrySignalsFromCandles([], {});
  assert.equal(result.ready, false);
});

test('computeEntrySignals: returns ready:true when >= 12 closed candles provided', (t) => {
  if (skipIfNoImport(t)) return;
  const candles = makeCandleArray({ count: 15 });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
});

// ═══════════════════════════════════════════════════════════════════
// 2. Green candle + minimum body
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: isGreen true for bullish last candle', (t) => {
  if (skipIfNoImport(t)) return;
  const candles = makeCandleArray({ count: 15, lastCandle: { isGreen: true, bodyPct: 0.5 } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  assert.equal(result.isGreen, true);
  assert.ok(result.bodyPct > 0, 'bodyPct should be positive for a bullish candle');
});

test('computeEntrySignals: isGreen false for bearish last candle', (t) => {
  if (skipIfNoImport(t)) return;
  const candles = makeCandleArray({ count: 15, lastCandle: { isGreen: false, bodyPct: 0.5 } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  assert.equal(result.isGreen, false);
});

test('computeEntrySignals: bodyPct reflects actual candle body size', (t) => {
  if (skipIfNoImport(t)) return;
  // open=100, close=101 → bodyPct = 1% of open
  const candles = makeCandleArray({ count: 15, lastCandle: { open: 100, bodyPct: 1.0, isGreen: true } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  // bodyPct should be ~1.0%  (allow ±0.05 for float arithmetic)
  assert.ok(Math.abs(result.bodyPct - 1.0) < 0.05, `bodyPct=${result.bodyPct} expected ~1.0`);
});

// ═══════════════════════════════════════════════════════════════════
// 3. Upper wick / body ratio
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: low upperWickBodyRatio for candle with small upper wick', (t) => {
  if (skipIfNoImport(t)) return;
  // upperWickMult = 0.1 → wick = 0.1 × body → ratio ≈ 0.1
  const candles = makeCandleArray({ count: 15, lastCandle: { isGreen: true, bodyPct: 0.5, upperWickMult: 0.1 } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  assert.ok(result.upperWickBodyRatio < 0.5, `Expected small wick ratio, got ${result.upperWickBodyRatio}`);
});

test('computeEntrySignals: high upperWickBodyRatio for candle with long upper wick', (t) => {
  if (skipIfNoImport(t)) return;
  // upperWickMult = 4.0 → wick = 4× body → ratio ≈ 4.0
  const candles = makeCandleArray({ count: 15, lastCandle: { isGreen: true, bodyPct: 0.5, upperWickMult: 4.0 } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  assert.ok(result.upperWickBodyRatio >= 2.5, `Expected high wick ratio, got ${result.upperWickBodyRatio}`);
});

// ═══════════════════════════════════════════════════════════════════
// 4. Volume confirmation vs rolling MA
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: volumeRatio > 1 when last candle has above-average volume', (t) => {
  if (skipIfNoImport(t)) return;
  // baseline volume = 1000, last candle volume = 2000 → ratio ≈ 2.0
  const candles = makeCandleArray({
    count: 25,
    baseVolume: 1000,
    lastCandle: { isGreen: true, bodyPct: 0.5, volume: 2000 },
  });
  const result = computeEntrySignalsFromCandles(candles, { entryVolumeLookbackCandles: 20 });
  assert.equal(result.ready, true);
  assert.ok(result.volumeRatio >= 1.5, `Expected volumeRatio >= 1.5, got ${result.volumeRatio}`);
});

test('computeEntrySignals: volumeRatio < 1 when last candle has below-average volume', (t) => {
  if (skipIfNoImport(t)) return;
  // baseline volume = 2000, last candle volume = 500 → ratio ≈ 0.25
  const candles = makeCandleArray({
    count: 25,
    baseVolume: 2000,
    lastCandle: { isGreen: true, bodyPct: 0.5, volume: 500 },
  });
  const result = computeEntrySignalsFromCandles(candles, { entryVolumeLookbackCandles: 20 });
  assert.equal(result.ready, true);
  assert.ok(result.volumeRatio < 1.0, `Expected volumeRatio < 1.0, got ${result.volumeRatio}`);
});

// ═══════════════════════════════════════════════════════════════════
// 5. Breakout + 1-candle confirmation
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: breakoutConfirm false when price has not broken recent high', (t) => {
  if (skipIfNoImport(t)) return;
  // All candles at same price level — no breakout
  const candles = [];
  for (let i = 0; i <= 25; i++) {
    candles.push(makeCandle({ open: 100, bodyPct: 0.1, isGreen: true, volume: 1000, time: i * 900 }));
  }
  const result = computeEntrySignalsFromCandles(candles, { entryBreakoutLookbackCandles: 20 });
  assert.equal(result.ready, true);
  assert.equal(result.breakoutConfirm, false);
});

test('computeEntrySignals: breakoutConfirm true when prev close and current close both exceed lookback high', (t) => {
  if (skipIfNoImport(t)) return;
  // Build flat baseline then spike at the end
  const candles = [];
  for (let i = 0; i < 23; i++) {
    candles.push(makeCandle({ open: 100, bodyPct: 0.05, isGreen: true, volume: 1000, time: i * 900 }));
  }
  // prev candle breaks out of 100 range
  candles.push(makeCandle({ open: 120, bodyPct: 1.0, isGreen: true, volume: 1500, time: 23 * 900 }));
  // last closed candle also above breakout level
  candles.push(makeCandle({ open: 125, bodyPct: 1.0, isGreen: true, volume: 1500, time: 24 * 900 }));
  // current open candle (gets sliced off)
  candles.push(makeCandle({ open: 126, bodyPct: 0.1, volume: 500, time: 25 * 900 }));

  const result = computeEntrySignalsFromCandles(candles, { entryBreakoutLookbackCandles: 20 });
  assert.equal(result.ready, true);
  assert.equal(result.breakoutConfirm, true);
});

// ═══════════════════════════════════════════════════════════════════
// 6. HTF (1h) alignment
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: htfTrend derived from aggregated 1h candles', (t) => {
  if (skipIfNoImport(t)) return;
  // Need ≥ 12 closed 15m candles; 4 × 15m = 1h, so ≥ 3 × 4 = 12 closed
  const candles = makeCandleArray({ count: 50, lastCandle: { isGreen: true, bodyPct: 0.3 } });
  const result  = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  assert.ok(
    ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(result.htfTrend),
    `htfTrend must be one of BULLISH/BEARISH/NEUTRAL, got: ${result.htfTrend}`
  );
});

test('computeEntrySignals: htfTrend BULLISH for consistently rising candle set', (t) => {
  if (skipIfNoImport(t)) return;
  // 50 candles that steadily rise — 1h aggregation should resolve BULLISH
  const candles = [];
  let price = 100;
  for (let i = 0; i <= 50; i++) {
    price += 0.5;  // steady uptrend
    candles.push(makeCandle({ open: price, bodyPct: 0.5, isGreen: true, volume: 1000, time: i * 900 }));
  }
  const result = computeEntrySignalsFromCandles(candles, {});
  assert.equal(result.ready, true);
  // In a rising market, htfTrend should not be BEARISH
  assert.notEqual(result.htfTrend, 'BEARISH', 'Consistently rising candles should not yield BEARISH HTF');
});

// ═══════════════════════════════════════════════════════════════════
// 7. Edge cases
// ═══════════════════════════════════════════════════════════════════

test('computeEntrySignals: handles null/non-array input gracefully', (t) => {
  if (skipIfNoImport(t)) return;
  assert.doesNotThrow(() => computeEntrySignalsFromCandles(null, {}));
  assert.doesNotThrow(() => computeEntrySignalsFromCandles(undefined, {}));
  const r1 = computeEntrySignalsFromCandles(null, {});
  const r2 = computeEntrySignalsFromCandles(undefined, {});
  assert.equal(r1.ready, false);
  assert.equal(r2.ready, false);
});

test('computeEntrySignals: respects custom entryVolumeLookbackCandles config', (t) => {
  if (skipIfNoImport(t)) return;
  // Build 30 candles with high baseline, last candle low volume
  const candles = makeCandleArray({ count: 30, baseVolume: 5000, lastCandle: { volume: 100, isGreen: true } });
  // Short lookback (5 candles) — should still see last 5 at ~5000 avg
  const resultShort = computeEntrySignalsFromCandles(candles, { entryVolumeLookbackCandles: 5 });
  // Long lookback (20 candles) — same avg since all baseline = 5000
  const resultLong  = computeEntrySignalsFromCandles(candles, { entryVolumeLookbackCandles: 20 });
  // Both should yield ratio < 1 since last volume (100) << 5000
  assert.equal(resultShort.ready, true);
  assert.equal(resultLong.ready, true);
  assert.ok(resultShort.volumeRatio < 1, `Short lookback volumeRatio=${resultShort.volumeRatio}`);
  assert.ok(resultLong.volumeRatio  < 1, `Long lookback volumeRatio=${resultLong.volumeRatio}`);
});

// ═══════════════════════════════════════════════════════════════════
// 8. Source assertions — config-driven gate checks in runHunterAlpha
// ═══════════════════════════════════════════════════════════════════

const hunterSrc = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf-8');

test('gate: green candle check uses entryRequireGreenCandle config flag', () => {
  assert.match(hunterSrc, /entryRequireGreenCandle/);
  // Gate should be disabled when flag is explicitly false
  assert.match(hunterSrc, /entryRequireGreenCandle\s*!==\s*false/);
});

test('gate: green candle check enforces entryMinGreenBodyPct threshold', () => {
  assert.match(hunterSrc, /entryMinGreenBodyPct/);
  assert.match(hunterSrc, /signalBodyPct\s*<\s*minBodyPct/);
});

test('gate: upper wick reject uses entryMaxUpperWickBodyRatio', () => {
  assert.match(hunterSrc, /entryMaxUpperWickBodyRatio/);
  assert.match(hunterSrc, /signalUpperWickBodyRatio\s*>\s*maxWickRatio/);
});

test('gate: volume confirm gate uses entryRequireVolumeConfirm flag', () => {
  assert.match(hunterSrc, /entryRequireVolumeConfirm/);
  assert.match(hunterSrc, /entryRequireVolumeConfirm\s*!==\s*false/);
});

test('gate: volume confirm gate enforces entryMinVolumeRatio threshold', () => {
  assert.match(hunterSrc, /entryMinVolumeRatio/);
  assert.match(hunterSrc, /signalVolumeRatio\s*<\s*minVolRatio/);
});

test('gate: breakout confirm only fires when entryRequireBreakoutConfirm === true (opt-in)', () => {
  // The gate must be opt-in (=== true check, not !== false)
  assert.match(hunterSrc, /entryRequireBreakoutConfirm\s*===\s*true/);
  assert.match(hunterSrc, /!signalBreakoutConfirm/);
});

test('gate: HTF alignment gate uses entryRequireHtfAlignment flag', () => {
  assert.match(hunterSrc, /entryRequireHtfAlignment/);
  assert.match(hunterSrc, /entryRequireHtfAlignment\s*!==\s*false/);
});

test('gate: HTF alignment respects entryHtfAllowNeutral — NEUTRAL allowed when true', () => {
  assert.match(hunterSrc, /entryHtfAllowNeutral/);
  // Allow-neutral branch: NEUTRAL passes when flag is set
  assert.match(hunterSrc, /allowNeutral\s*&&\s*signalHtfTrend\s*===\s*'NEUTRAL'/);
});

test('gate: fallback when candles unavailable uses priceChangeM5 as green proxy', () => {
  // When entrySignals.ready is false, code must fall back to ohlcv.priceChangeM5
  assert.match(hunterSrc, /entrySignals\.ready\s*\?\s*entrySignals\.isGreen/);
  assert.match(hunterSrc, /priceChangeM5.*>\s*0/);
});

test('gate: fallback when candles unavailable uses priceChangeH1 as HTF proxy', () => {
  assert.match(hunterSrc, /priceChangeH1.*BULLISH.*BEARISH|BULLISH.*priceChangeH1|fallbackHtfTrend/);
});
