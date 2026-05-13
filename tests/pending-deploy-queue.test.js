import test from 'node:test';
import assert from 'node:assert/strict';

import { isFreshDeployMeta, isReliableLiveSnapshot, summarizeQueueDecision } from '../src/utils/pendingDeployQueue.js';

test('fresh deploy meta allows breakout-valid, high-readiness entries including LP live timing', () => {
  assert.equal(isFreshDeployMeta({
    entryTimingState: 'BREAKOUT',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'BULLISH',
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'ATH_BREAK',
    entryReadiness: 'HIGH',
    breakoutQuality: 'STRONG',
    taTrend: 'BULLISH',
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'WAIT_FOR_PULLBACK',
    entryReadiness: 'MEDIUM',
    breakoutQuality: 'PENDING_TA',
    isScoutDefer: true,
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'BREAKOUT',
    entryReadiness: 'MEDIUM',
    breakoutQuality: 'VALID',
    taTrend: 'BULLISH',
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'BULLISH',
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'BEARISH',
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'NEUTRAL',
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
  }), false);
});

test('queue freshness resolves live vs queued signals for LP-style chart scenarios', () => {
  const bullishMeta = {
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'STRONG',
    taTrend: 'BULLISH',
    priceChangeM5: 1.5,
  };

  const fallbackFromMeta = summarizeQueueDecision({
    meta: bullishMeta,
    liveSnapshot: null,
    lpMode: true,
  });
  assert.equal(fallbackFromMeta.decision, 'DEPLOY');
  assert.equal(fallbackFromMeta.trendSource, 'queue');
  assert.equal(fallbackFromMeta.m5Source, 'queue');
  assert.equal(fallbackFromMeta.trend, 'BULLISH');

  const liveNeutral = summarizeQueueDecision({
    meta: bullishMeta,
    liveSnapshot: {
      quality: { taTrend: 'NEUTRAL' },
      ohlcv: { priceChangeM5: 1.25 },
    },
    lpMode: true,
  });
  assert.equal(liveNeutral.decision, 'HOLD');
  assert.equal(liveNeutral.trendSource, 'live');
  assert.equal(liveNeutral.trend, 'NEUTRAL');

  const liveBearish = summarizeQueueDecision({
    meta: bullishMeta,
    liveSnapshot: {
      quality: { taTrend: 'BEARISH' },
      ohlcv: { priceChangeM5: 1.25 },
    },
    lpMode: true,
  });
  assert.equal(liveBearish.decision, 'DROP');
  assert.equal(liveBearish.trendSource, 'live');
  assert.equal(liveBearish.trend, 'BEARISH');
});

test('queue treats fallback momentum proxy as unreliable live confirmation', () => {
  assert.equal(isReliableLiveSnapshot(null), false);
  assert.equal(isReliableLiveSnapshot({
    dataSource: 'momentum-proxy',
    ohlcv: { historySuccess: false },
  }), false);
  assert.equal(isReliableLiveSnapshot({
    dataSource: 'dexscreener-ohlcv',
    ohlcv: { historySuccess: true },
  }), true);
});
