import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketRegime } from '../src/market/strategyLibrary.js';

test('classifyMarketRegime detects BULL_TREND with strong confluence', () => {
  const res = classifyMarketRegime({
    ta: { supertrend: { trend: 'BULLISH' } },
    ohlcv: { priceChangeH1: 4.2, priceChangeM5: 1.3, range24hPct: 12 },
    pool: { tvl: 120000, volume24h: 260000, feeTvlRatio: 0.02 },
    sentiment: { buyPressurePct: 68 },
  });
  assert.equal(res.regime, 'BULL_TREND');
  assert.ok(res.confidence >= 0.8);
});

test('classifyMarketRegime detects BEAR_DEFENSE during bearish trend', () => {
  const res = classifyMarketRegime({
    ta: { supertrend: { trend: 'BEARISH' } },
    ohlcv: { priceChangeH1: -2.0, priceChangeM5: -0.6, range24hPct: 9 },
    pool: { tvl: 160000, volume24h: 210000, feeTvlRatio: 0.015 },
    sentiment: { buyPressurePct: 34 },
  });
  assert.equal(res.regime, 'BEAR_DEFENSE');
  assert.ok(res.confidence >= 0.7);
});

test('classifyMarketRegime detects LOW_LIQ_HIGH_RISK when flow is too weak', () => {
  const res = classifyMarketRegime({
    ta: { supertrend: { trend: 'NEUTRAL' } },
    ohlcv: { priceChangeH1: 0.5, priceChangeM5: 0.1, range24hPct: 5 },
    pool: { tvl: 20000, volume24h: 3000, feeTvlRatio: 0.003 },
    sentiment: { buyPressurePct: 49 },
  });
  assert.equal(res.regime, 'LOW_LIQ_HIGH_RISK');
  assert.ok(res.confidence >= 0.6);
});

test('classifyMarketRegime detects SIDEWAYS_CHOP during low-vol range', () => {
  const res = classifyMarketRegime({
    ta: { supertrend: { trend: 'NEUTRAL' } },
    ohlcv: { priceChangeH1: 1.1, priceChangeM5: 0.2, atrPct: 2.1, range24hPct: 6.4 },
    pool: { tvl: 130000, volume24h: 90000, feeTvlRatio: 0.009 },
    sentiment: { buyPressurePct: 51 },
  });
  assert.equal(res.regime, 'SIDEWAYS_CHOP');
  assert.ok(res.confidence >= 0.55);
});

test('classifyMarketRegime downgrades bullish setup when 1h data is stale', () => {
  const res = classifyMarketRegime({
    ta: { supertrend: { trend: 'BULLISH' } },
    ohlcv: { priceChangeH1: 4.2, priceChangeM5: 1.3, atrPct: 3.1, range24hPct: 12, historyAgeMinutes: 240 },
    pool: { tvl: 120000, volume24h: 260000, feeTvlRatio: 0.02 },
    sentiment: { buyPressurePct: 68 },
  });
  assert.equal(res.recommendation, 'WAIT');
  assert.ok(res.reasonCodes.includes('H1_STALE'));
});
