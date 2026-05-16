import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkSupertrendVeto } from '../src/market/meridianVeto.js';
import {
  getFinalSupertrendDeployDecision,
  isFreshBullishSupertrend15m,
  isFreshDeployMeta,
  isReliableLiveSnapshot,
  summarizeQueueDecision,
} from '../src/utils/pendingDeployQueue.js';

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

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'NEUTRAL',
    queueTrustedWatch: true,
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    queueTrustedWatch: true,
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'BEARISH',
    queueTrustedWatch: true,
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

test('trusted WATCH-ready LP entries can prepare queue but still need final ST gate', async () => {
  const trustedWatchMeta = {
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    queueTrustedWatch: true,
    taTrend: 'NEUTRAL',
    priceChangeM5: 0,
  };

  const fromQueue = summarizeQueueDecision({
    meta: trustedWatchMeta,
    liveSnapshot: null,
    lpMode: true,
  });
  assert.equal(fromQueue.decision, 'DEPLOY');
  assert.equal(fromQueue.reason.includes('Trusted WATCH ready'), true);

  const liveNeutral = summarizeQueueDecision({
    meta: trustedWatchMeta,
    liveSnapshot: {
      quality: { taTrend: 'NEUTRAL' },
      ohlcv: { priceChangeM5: 0 },
    },
    lpMode: true,
  });
  assert.equal(liveNeutral.decision, 'DEPLOY');
  assert.equal(liveNeutral.trendSource, 'live');

  const liveBearish = summarizeQueueDecision({
    meta: trustedWatchMeta,
    liveSnapshot: {
      quality: { taTrend: 'BEARISH' },
      ohlcv: { priceChangeM5: 1.25 },
    },
    lpMode: true,
  });
  assert.equal(liveBearish.decision, 'DROP');

  const finalGate = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: trustedWatchMeta,
    checkFn: async () => ({ veto: true, direction: 'UNKNOWN', reason: 'Supertrend 15m unavailable' }),
  });
  assert.equal(finalGate.action, 'HOLD');
});

test('final Supertrend deploy gate allows only fresh bullish cache', async () => {
  const now = 1_700_000_000_000;

  assert.equal(isFreshBullishSupertrend15m({ supertrend15m: 'BULLISH', supertrend15mAt: now - 5_000 }, {}, now), true);

  const freshBullish = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: { supertrend15m: 'BULLISH', supertrend15mAt: now - 5_000 },
    now,
    checkFn: async () => { throw new Error('should not fetch fresh ST'); },
  });
  assert.equal(freshBullish.action, 'ALLOW');
  assert.equal(freshBullish.source, 'cache');

  const freshBearish = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: { supertrend15m: 'BEARISH', supertrend15mAt: now - 5_000 },
    now,
  });
  assert.equal(freshBearish.action, 'VETO');
  assert.equal(freshBearish.direction, 'BEARISH');
});

test('final Supertrend deploy gate does not trust generic taTrend snapshot cache', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: { taTrend: 'BULLISH', liveTrend: 'BULLISH', snapshotAt: now - 5_000 },
    pool: {
      _entrySignals: { taTrend: 'BULLISH' },
      _watchTaTrend: 'BULLISH',
      _watchSnapshotAt: now - 5_000,
    },
    now,
    checkFn: async () => {
      calls += 1;
      return { veto: false, direction: 'BULLISH', reason: 'PASS: Trend 15m BULLISH via Meridian API' };
    },
  });

  assert.equal(calls, 1);
  assert.equal(decision.action, 'ALLOW');
  assert.equal(decision.source, 'fresh_fetch');
});

test('final Supertrend deploy gate refreshes stale cache and fails closed on error', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;

  const staleThenBearish = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: { supertrend15m: 'BULLISH', supertrend15mAt: now - 60_000 },
    now,
    checkFn: async () => {
      calls += 1;
      return { veto: true, direction: 'BEARISH', reason: 'VETO: Trend 15m BEARISH via Meridian API' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(staleThenBearish.action, 'VETO');
  assert.equal(staleThenBearish.source, 'fresh_fetch');

  const fetchError = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: {},
    now,
    checkFn: async () => {
      throw new Error('network unavailable');
    },
  });
  assert.equal(fetchError.action, 'HOLD');
  assert.equal(fetchError.ok, false);
  assert.match(fetchError.reason, /network unavailable/);
});

test('manual CA final gate does not pass generic taTrend snapshot cache', () => {
  const hunterSrc = readFileSync(new URL('../src/agents/hunterAlpha.js', import.meta.url), 'utf8');
  const start = hunterSrc.indexOf('const manualStGate = await ensureFinalSupertrendBullish({');
  assert.notEqual(start, -1);
  const end = hunterSrc.indexOf('});', start);
  const manualGateBlock = hunterSrc.slice(start, end);
  assert.match(manualGateBlock, /meta: \{\}/);
  assert.doesNotMatch(manualGateBlock, /taTrend: entrySignals\.taTrend/);
  assert.doesNotMatch(manualGateBlock, /snapshotAt: now/);
});

test('checkSupertrendVeto only passes exact bullish direction', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ latest: { supertrend: { direction: 'neutral' } } }),
      headers: { get: () => null },
    });
    const neutral = await checkSupertrendVeto('Mint111111111111111111111111111111111111111');
    assert.equal(neutral.veto, true);
    assert.equal(neutral.direction, 'UNKNOWN');
    assert.match(neutral.reason, /unsupported Supertrend 15m direction/);

    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ latest: { supertrend: { direction: 'bullish' } } }),
      headers: { get: () => null },
    });
    const bullish = await checkSupertrendVeto('Mint111111111111111111111111111111111111111');
    assert.equal(bullish.veto, false);
    assert.equal(bullish.direction, 'BULLISH');
  } finally {
    global.fetch = originalFetch;
  }
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
