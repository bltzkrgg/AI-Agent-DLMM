import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkSupertrendVeto } from '../src/market/meridianVeto.js';
import {
  __resetDeployQueueHoldNotifyState,
  buildDeployTriggeredTelegramMessage,
  buildUnreliableLiveSnapshotLog,
  dequeueToken,
  enqueueForDeploy,
  getFinalEntryCandleSanityDecision,
  getFinalEntryProximityDecision,
  getDeployQueueLiveSnapshot,
  ensureFinalEntryCandleSanity,
  getFinalSupertrendDeployDecision,
  getQueueSize,
  getLiveSnapshotReliability,
  isFreshBullishSupertrend15m,
  isFreshDeployMeta,
  isReliableLiveSnapshot,
  shouldSendDeployQueueHoldNotification,
  stopDeployQueueWatcher,
  summarizeQueueDecision,
} from '../src/utils/pendingDeployQueue.js';
import {
  aggregateClosed5mCandlesToClosedM15,
  evaluateClosedM15SupertrendReclaim,
  evaluateEntryCandleSanity,
} from '../src/utils/entryCandleSanity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

function makeEntryCandles({
  now = Date.now(),
  lastOpen = 100,
  lastClose = 104,
  lastVolume = 200,
  baseVolume = 100,
  count = 13,
  spacingSec = 300,
} = {}) {
  const startSec = Math.floor((now - ((count + 1) * spacingSec * 1000)) / 1000);
  const candles = [];
  for (let i = 0; i < count - 1; i++) {
    candles.push({
      time: startSec + (i * spacingSec),
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: baseVolume,
    });
  }
  candles.push({
    time: Math.floor((now - 60_000) / 1000),
    open: lastOpen,
    high: Math.max(lastOpen, lastClose),
    low: Math.min(lastOpen, lastClose),
    close: lastClose,
    volume: lastVolume,
  });
  return candles;
}

function makeAligned5mCandles({
  nowSec = Math.floor(Date.now() / 1000),
  count = 12,
  startPrice = 100,
  step = 1,
  volume = 100,
} = {}) {
  const endSec = Math.floor(nowSec / 300) * 300;
  const startSec = endSec - (count * 300);
  const candles = [];
  for (let i = 0; i < count; i++) {
    const open = startPrice + (i * step);
    const close = open + step;
    candles.push({
      time: startSec + (i * 300),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume,
    });
  }
  return candles;
}

function makeDerivedM15Backed5m({
  nowSec = Math.floor(Date.now() / 1000),
  m15Series = [],
} = {}) {
  const endBucketSec = Math.floor(nowSec / 900) * 900;
  const startBucketSec = endBucketSec - (m15Series.length * 900);
  const candles = [];
  for (let i = 0; i < m15Series.length; i++) {
    const item = m15Series[i] || {};
    const bucketSec = startBucketSec + (i * 900);
    const open = Number(item.open ?? 100);
    const close = Number(item.close ?? open);
    const volume = Math.max(0, Number(item.volume ?? 100));
    const step = (close - open) / 3;
    const close1 = open + step;
    const close2 = close1 + step;
    const c1 = { open, close: close1, volume: volume / 3 };
    const c2 = { open: close1, close: close2, volume: volume / 3 };
    const c3 = { open: close2, close, volume: volume / 3 };
    const parts = [c1, c2, c3];
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      candles.push({
        time: bucketSec + (p * 300),
        open: part.open,
        high: Math.max(part.open, part.close) + 0.5,
        low: Math.min(part.open, part.close) - 0.5,
        close: part.close,
        volume: part.volume,
      });
    }
  }
  return candles;
}

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
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'NEUTRAL',
    queueTrustedWatch: true,
    supertrend15m: 'BULLISH',
    supertrend15mAt: Date.now() - 60_000,
  }), false);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    taTrend: 'NEUTRAL',
    queueTrustedWatch: true,
    supertrend15m: 'BULLISH',
    supertrend15mAt: Date.now() - 5_000,
  }), true);

  assert.equal(isFreshDeployMeta({
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    queueTrustedWatch: true,
  }), false);

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
  assert.equal(fallbackFromMeta.decision, 'HOLD');
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

test('queue does not revive queued bullish trend when live snapshot exists but trend is unknown', () => {
  const bullishMeta = {
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'STRONG',
    taTrend: 'BULLISH',
    priceChangeM5: 1.5,
  };

  const decision = summarizeQueueDecision({
    meta: bullishMeta,
    liveSnapshot: {
      snapshotAt: Date.now(),
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'UNKNOWN' },
      ta: { supertrend: { trend: 'UNKNOWN' } },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 1.2 },
    },
    lpMode: true,
  });

  assert.equal(decision.decision, 'HOLD');
  assert.equal(decision.trend, 'UNKNOWN');
  assert.equal(decision.trendSource, 'unknown');
  assert.match(decision.reason, /trend unknown/i);
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
  assert.equal(fromQueue.decision, 'HOLD');
  assert.equal(fromQueue.reason.includes('M5 stale'), true);

  const liveNeutral = summarizeQueueDecision({
    meta: trustedWatchMeta,
    liveSnapshot: {
      quality: { taTrend: 'NEUTRAL' },
      ohlcv: { priceChangeM5: 0 },
    },
    lpMode: true,
  });
  assert.equal(liveNeutral.decision, 'HOLD');
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

test('queue blocks LP deploy when trend and M5 sources are unknown', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
    },
    liveSnapshot: null,
    lpMode: true,
  });

  assert.equal(decision.trend, 'UNKNOWN');
  assert.equal(decision.trendSource, 'unknown');
  assert.equal(decision.m5Source, 'unknown');
  assert.equal(decision.decision, 'HOLD');
  assert.match(decision.reason, /realtime trend\/M5 unknown/i);
});

test('queue allows LP deploy only on fresh bullish trend + fresh positive M5', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
      taTrend: 'UNKNOWN',
      priceChangeM5: 0,
    },
    liveSnapshot: {
      quality: { taTrend: 'BULLISH' },
      ohlcv: { priceChangeM5: 1.34, historySuccess: true },
      dataSource: 'dexscreener-ohlcv',
    },
    lpMode: true,
  });

  assert.equal(decision.trend, 'BULLISH');
  assert.equal(decision.trendSource, 'live');
  assert.equal(decision.m5Source, 'live');
  assert.equal(decision.decision, 'DEPLOY');
});

test('queue treats finite Meteora M5 as live source and holds when non-positive', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
      taTrend: 'UNKNOWN',
      priceChangeM5: 0,
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: {
        source: 'meteora-dlmm-ohlcv',
        historySuccess: true,
        entry5mHistorySuccess: true,
        priceChangeM5: 0,
      },
      quality: { taTrend: 'BULLISH' },
      ta: { supertrend: { trend: 'BULLISH' } },
    },
    lpMode: true,
  });

  assert.equal(decision.m5Source, 'live');
  assert.equal(decision.m5, 0);
  assert.equal(decision.decision, 'HOLD');
  assert.match(decision.reason, /non-positive/i);
});

test('lp_simple_m15 bypasses M5 non-positive hold when hard gate disabled', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
      taTrend: 'UNKNOWN',
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true },
    },
    cfg: {
      entryDecisionMode: 'lp_simple_m15',
      entryM5HardGateEnabled: false,
      deployQueueExpiryMin: 60,
    },
    lpMode: true,
  });

  assert.equal(decision.entryDecisionMode, 'lp_simple_m15');
  assert.equal(decision.m5Source, 'live');
  assert.equal(decision.m5, 0);
  assert.equal(decision.decision, 'DEPLOY');
});

test('lp_simple_m15 keeps M5 hold when hard gate enabled', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
      taTrend: 'UNKNOWN',
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv' },
    },
    cfg: {
      entryDecisionMode: 'lp_simple_m15',
      entryM5HardGateEnabled: true,
      deployQueueExpiryMin: 60,
    },
    lpMode: true,
  });

  assert.equal(decision.m5Source, 'live');
  assert.equal(decision.m5, 0);
  assert.equal(decision.decision, 'HOLD');
  assert.match(decision.reason, /M5 non-positive/i);
});

test('lp_simple_m15 still blocks bearish trend', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BEARISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', priceChangeM5: 0.3, historySuccess: true },
      ta: { supertrend: { trend: 'BEARISH' } },
    },
    cfg: {
      entryDecisionMode: 'lp_simple_m15',
      entryM5HardGateEnabled: false,
    },
    lpMode: true,
  });
  assert.equal(decision.decision, 'DROP');
});

test('queue holds when live quality trend and TA trend conflict', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 1.1 },
      ta: { supertrend: { trend: 'BEARISH' } },
    },
    lpMode: true,
  });

  assert.equal(decision.decision, 'HOLD');
  assert.equal(decision.trend, 'UNKNOWN');
  assert.match(decision.reason, /trend conflict/i);
});

test('final Supertrend deploy gate allows only fresh bullish cache', async () => {
  const now = 1_700_000_000_000;

  assert.equal(isFreshBullishSupertrend15m({ supertrend15m: 'BULLISH', supertrend15mAt: now - 5_000 }, {}, now), true);

  const freshBullish = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: {
      supertrend15m: 'BULLISH',
      supertrend15mAt: now - 5_000,
      supertrend15mSource: 'fresh_fetch',
    },
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

test('final Supertrend deploy gate prioritizes reliable live snapshot bearish over bullish cache', async () => {
  const now = 1_700_000_000_000;
  const meta = {
    supertrend15m: 'BULLISH',
    supertrend15mAt: now - 5_000,
    supertrend15mSource: 'fresh_fetch',
  };
  const pool = {};
  let calls = 0;

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta,
    pool,
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BEARISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 0.8 },
      ta: { supertrend: { trend: 'BEARISH' } },
    },
    checkFn: async () => {
      calls += 1;
      return { veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' };
    },
  });

  assert.equal(decision.action, 'VETO');
  assert.equal(decision.source, 'live_snapshot');
  assert.equal(calls, 0);
  assert.equal(meta.supertrend15m, undefined);
  assert.equal(meta.supertrend15mAt, undefined);
});

test('final Supertrend deploy gate requires canonical confirmation before allowing live bullish snapshot', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;
  const entryCandles5m = makeDerivedM15Backed5m({
    nowSec: Math.floor(now / 1000),
    m15Series: [
      { open: 95, close: 97, volume: 100 },
      { open: 97, close: 99, volume: 100 },
      { open: 99, close: 101, volume: 100 },
    ],
  });

  const vetoed = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 0.8, currentPrice: 101.4, entryCandles5m },
      ta: { supertrend: { trend: 'BULLISH', value: 100 } },
    },
    checkFn: async () => {
      calls += 1;
      return { veto: true, direction: 'BEARISH', reason: 'VETO: Trend 15m BEARISH via Meridian API' };
    },
  });

  assert.equal(vetoed.action, 'VETO');
  assert.equal(vetoed.source, 'fresh_fetch');
  assert.equal(vetoed.direction, 'BEARISH');
  assert.equal(calls, 1);
});

test('final Supertrend deploy gate reuses short canonical bullish cache for live bullish snapshot', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;
  const entryCandles5m = makeDerivedM15Backed5m({
    nowSec: Math.floor(now / 1000),
    m15Series: [
      { open: 95, close: 97, volume: 100 },
      { open: 97, close: 99, volume: 100 },
      { open: 99, close: 101, volume: 100 },
    ],
  });

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: {
      finalSupertrend15m: 'BULLISH',
      finalSupertrend15mAt: now - 5_000,
      finalSupertrend15mSource: 'fresh_fetch',
    },
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 0.8, currentPrice: 101, entryCandles5m },
      ta: { supertrend: { trend: 'BULLISH', value: 100 } },
    },
    checkFn: async () => {
      calls += 1;
      return { veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' };
    },
  });

  assert.equal(decision.action, 'ALLOW');
  assert.equal(decision.source, 'cache');
  assert.equal(calls, 0);
});

test('final Supertrend deploy gate holds live bullish snapshot when last closed M15 has not reclaimed above Supertrend line', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;
  const entryCandles5m = makeDerivedM15Backed5m({
    nowSec: Math.floor(now / 1000),
    m15Series: [
      { open: 95, close: 97, volume: 100 },
      { open: 97, close: 99, volume: 100 },
      { open: 100, close: 99.5, volume: 100 },
    ],
  });

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta: {
      finalSupertrend15m: 'BULLISH',
      finalSupertrend15mAt: now - 5_000,
      finalSupertrend15mSource: 'fresh_fetch',
    },
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 0.8, currentPrice: 101.2, entryCandles5m },
      ta: { supertrend: { trend: 'BULLISH', value: 100 } },
    },
    checkFn: async () => {
      calls += 1;
      return { veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' };
    },
  });

  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.source, 'live_snapshot');
  assert.equal(decision.direction, 'BULLISH');
  assert.match(decision.reason, /closed m15 candle is still below supertrend 15m line/i);
  assert.equal(calls, 0);
});

test('closed M15 Supertrend reclaim helper confirms only the last closed M15 close above line', () => {
  const now = 1_700_000_000_000;
  const confirmed = evaluateClosedM15SupertrendReclaim({
    now,
    supertrendValue: 100,
    snapshot: {
      ohlcv: {
        source: 'meteora-dlmm-ohlcv',
        entryCandles5m: makeDerivedM15Backed5m({
          nowSec: Math.floor(now / 1000),
          m15Series: [
            { open: 95, close: 97, volume: 100 },
            { open: 97, close: 99, volume: 100 },
            { open: 99, close: 101, volume: 100 },
          ],
        }),
      },
    },
  });
  assert.equal(confirmed.known, true);
  assert.equal(confirmed.aboveLine, true);

  const rejected = evaluateClosedM15SupertrendReclaim({
    now,
    supertrendValue: 100,
    snapshot: {
      ohlcv: {
        source: 'meteora-dlmm-ohlcv',
        entryCandles5m: makeDerivedM15Backed5m({
          nowSec: Math.floor(now / 1000),
          m15Series: [
            { open: 95, close: 97, volume: 100 },
            { open: 97, close: 99, volume: 100 },
            { open: 101, close: 99.5, volume: 100 },
          ],
        }),
      },
    },
  });
  assert.equal(rejected.known, true);
  assert.equal(rejected.aboveLine, false);
});

test('final Supertrend deploy gate still vetoes when live snapshot is bearish but unreliable', async () => {
  const now = 1_700_000_000_000;
  const meta = {
    supertrend15m: 'BULLISH',
    supertrend15mAt: now - 5_000,
    supertrend15mSource: 'fresh_fetch',
  };
  const pool = {};
  let calls = 0;

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta,
    pool,
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BEARISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: false, priceChangeM5: 0.8 },
      ta: { supertrend: { trend: 'BEARISH' } },
    },
    checkFn: async () => {
      calls += 1;
      return { veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' };
    },
  });

  assert.equal(decision.action, 'VETO');
  assert.equal(decision.source, 'live_snapshot');
  assert.equal(calls, 0);
  assert.equal(meta.supertrend15m, undefined);
  assert.equal(meta.supertrend15mAt, undefined);
});

test('final Supertrend deploy gate holds when live quality trend and TA trend conflict', async () => {
  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'BULLISH' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 1.0 },
      ta: { supertrend: { trend: 'BEARISH' } },
    },
    checkFn: async () => ({ veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' }),
  });

  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.source, 'live_snapshot');
  assert.equal(decision.direction, 'UNKNOWN');
  assert.match(decision.reason, /waiting canonical confirmation/i);
});
test('final entry candle sanity passes fresh green candle with volume confirmation', async () => {
  const now = 1_700_000_000_000;
  const decision = await getFinalEntryCandleSanityDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    cfg: {
      entryCandleSanityEnabled: true,
      entryRequireGreenCandle: true,
      entryRequireVolumeConfirm: true,
      entryMinVolumeRatio: 1.5,
      entryVolumeLookbackCandles: 12,
      entryCandleMaxAgeSec: 420,
    },
    pool: {
      _marketSnapshot: {
        ohlcv: {
          source: 'test-cache',
          entryCandles5m: makeEntryCandles({ now, lastOpen: 100, lastClose: 105, lastVolume: 180 }),
        },
      },
    },
    snapshotFn: async () => { throw new Error('should not fetch when cache is fresh'); },
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'ALLOW');
});

test('final entry candle sanity holds red, thin, stale, and missing candle data', async () => {
  const now = 1_700_000_000_000;
  const cfg = {
    entryCandleSanityEnabled: true,
    entryRequireGreenCandle: true,
    entryRequireVolumeConfirm: true,
    entryMinVolumeRatio: 1.5,
    entryVolumeLookbackCandles: 12,
    entryCandleMaxAgeSec: 420,
  };

  const red = await getFinalEntryCandleSanityDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    cfg,
    pool: { _marketSnapshot: { ohlcv: { entryCandles5m: makeEntryCandles({ now, lastOpen: 105, lastClose: 100, lastVolume: 200 }) } } },
  });
  assert.equal(red.ok, false);
  assert.equal(red.reason, 'HOLD: last closed 5m candle not green');

  const thin = await getFinalEntryCandleSanityDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    cfg,
    pool: { _marketSnapshot: { ohlcv: { entryCandles5m: makeEntryCandles({ now, lastOpen: 100, lastClose: 105, lastVolume: 120 }) } } },
  });
  assert.equal(thin.ok, false);
  assert.equal(thin.reason, 'HOLD: entry candle volume below threshold');

  let staleRefreshCalls = 0;
  const stale = await getFinalEntryCandleSanityDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    cfg,
    pool: { _marketSnapshot: { ohlcv: { entryCandles5m: makeEntryCandles({ now: now - 900_000, lastOpen: 100, lastClose: 105, lastVolume: 200 }) } } },
    snapshotFn: async () => {
      staleRefreshCalls += 1;
      return null;
    },
  });
  assert.equal(staleRefreshCalls, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'HOLD: entry candle sanity unavailable/stale');

  const missing = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg,
    pool: {},
    snapshotFn: async () => { throw new Error('missing mint should not fetch'); },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'HOLD: entry candle sanity unavailable/stale');
});

test('final entry candle sanity fetches only after missing cache', async () => {
  const now = 1_700_000_000_000;
  let calls = 0;
  const decision = await getFinalEntryCandleSanityDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    now,
    cfg: {
      entryCandleSanityEnabled: true,
      entryRequireGreenCandle: true,
      entryRequireVolumeConfirm: true,
      entryMinVolumeRatio: 1.5,
      entryVolumeLookbackCandles: 12,
      entryCandleMaxAgeSec: 420,
    },
    pool: {},
    snapshotFn: async () => {
      calls += 1;
      return { ohlcv: { entryCandles5m: makeEntryCandles({ now: Date.now(), lastOpen: 100, lastClose: 105, lastVolume: 200 }) } };
    },
  });

  assert.equal(calls, 1);
  assert.equal(decision.ok, true);
});

test('final entry candle sanity uses cfg entryCandleMaxAgeSec for stale hold', async () => {
  const now = 1_700_000_000_000;
  const snapshot = {
    ohlcv: {
      source: 'test-cache',
      entryCandles5m: makeEntryCandles({ now: now - 800_000, lastOpen: 100, lastClose: 104, lastVolume: 220 }),
    },
  };

  const strict = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: { entryCandleSanityEnabled: true, entryCandleMaxAgeSec: 60 },
    pool: { _marketSnapshot: snapshot },
  });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, 'STALE');

  const lenient = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: { entryCandleSanityEnabled: true, entryCandleMaxAgeSec: 3600, entryRequireVolumeConfirm: false },
    pool: { _marketSnapshot: snapshot },
  });
  assert.equal(lenient.ok, true);
});

test('final entry candle sanity uses cfg entryMinVolumeRatio and can skip volume confirm', async () => {
  const now = 1_700_000_000_000;
  const pool = {
    _marketSnapshot: {
      ohlcv: {
        source: 'test-cache',
        entryCandles5m: makeEntryCandles({ now, lastOpen: 100, lastClose: 105, lastVolume: 120, baseVolume: 100 }),
      },
    },
  };

  const strictRatio = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: {
      entryCandleSanityEnabled: true,
      entryRequireGreenCandle: true,
      entryRequireVolumeConfirm: true,
      entryMinVolumeRatio: 1.5,
      entryVolumeLookbackCandles: 12,
      entryCandleMaxAgeSec: 420,
    },
    pool,
  });
  assert.equal(strictRatio.ok, false);
  assert.equal(strictRatio.code, 'THIN_VOLUME');

  const relaxedRatio = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: {
      entryCandleSanityEnabled: true,
      entryRequireGreenCandle: true,
      entryRequireVolumeConfirm: true,
      entryMinVolumeRatio: 1.1,
      entryVolumeLookbackCandles: 12,
      entryCandleMaxAgeSec: 420,
    },
    pool,
  });
  assert.equal(relaxedRatio.ok, true);

  const skipVolume = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: {
      entryCandleSanityEnabled: true,
      entryRequireGreenCandle: true,
      entryRequireVolumeConfirm: false,
      entryMinVolumeRatio: 5,
      entryVolumeLookbackCandles: 12,
      entryCandleMaxAgeSec: 420,
    },
    pool,
  });
  assert.equal(skipVolume.ok, true);
});

test('aggregates closed 5m candles into closed M15 candles with complete buckets only', () => {
  const bucketStart = 1_700_000_100 - (1_700_000_100 % 900);
  const candles = [
    { time: bucketStart + 0, open: 100, high: 103, low: 99, close: 101, volume: 10 },
    { time: bucketStart + 300, open: 101, high: 105, low: 100, close: 104, volume: 20 },
    { time: bucketStart + 600, open: 104, high: 106, low: 103, close: 105, volume: 30 },
    { time: bucketStart + 900, open: 105, high: 106, low: 104, close: 104.5, volume: 5 },
  ];

  const m15 = aggregateClosed5mCandlesToClosedM15(candles);
  assert.equal(m15.length, 1);
  assert.equal(m15[0].open, 100);
  assert.equal(m15[0].close, 105);
  assert.equal(m15[0].high, 106);
  assert.equal(m15[0].low, 99);
  assert.equal(m15[0].volume, 60);
});

test('lp_simple_m15 ignores running/open 5m candle for derived M15 gate', () => {
  const now = 1_700_002_100_000;
  const nowSec = Math.floor(now / 1000);
  const candles5m = makeDerivedM15Backed5m({
    nowSec,
    m15Series: [
      { open: 100, close: 102, volume: 110 },
      { open: 102, close: 104, volume: 120 },
      { open: 104, close: 106, volume: 140 },
    ],
  });

  // Running candle: should be ignored by lp_simple_m15 closed-5m filter.
  candles5m.push({
    time: Math.floor(nowSec / 300) * 300,
    open: 200,
    high: 205,
    low: 180,
    close: 180,
    volume: 9999,
  });

  const decision = evaluateEntryCandleSanity({
    snapshot: { ohlcv: { source: 'meteora-dlmm-ohlcv', entryCandles5m: candles5m } },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: true,
      entryM15MinVolumeRatio: 0.7,
      entryM15VolumeLookbackCandles: 2,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.reason, 'entry M15 sanity pass');
});

test('lp_simple_m15 entry sanity uses derived M15 candle and does not require M5 gate', () => {
  const now = 1_700_001_800_000;
  const nowSec = Math.floor(now / 1000);
  const candles5m = makeAligned5mCandles({
    nowSec,
    count: 12,
    startPrice: 100,
    step: 0.5,
    volume: 100,
  });
  candles5m[candles5m.length - 1].volume = 140;

  const decision = evaluateEntryCandleSanity({
    snapshot: {
      ohlcv: {
        source: 'meteora-dlmm-ohlcv',
        entryCandles5m: candles5m,
      },
    },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: true,
      entryM15MinVolumeRatio: 0.7,
      entryM15VolumeLookbackCandles: 2,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'ALLOW');
  assert.equal(Number.isFinite(decision.m15VolumeRatio), true);
});

test('lp_simple_m15 entry sanity holds red last M15 candle with M15 wording', () => {
  const now = 1_700_001_800_000;
  const nowSec = Math.floor(now / 1000);
  const candles5m = makeDerivedM15Backed5m({
    nowSec,
    m15Series: [
      { open: 100, close: 102, volume: 100 },
      { open: 102, close: 104, volume: 100 },
      { open: 104, close: 101, volume: 120 },
    ],
  });

  const decision = evaluateEntryCandleSanity({
    snapshot: { ohlcv: { source: 'meteora-dlmm-ohlcv', entryCandles5m: candles5m } },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: false,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'HOLD: last closed M15 candle not green');
});

test('lp_simple_m15 entry sanity holds thin M15 volume with M15 wording', () => {
  const now = 1_700_001_800_000;
  const nowSec = Math.floor(now / 1000);
  const candles5m = makeDerivedM15Backed5m({
    nowSec,
    m15Series: [
      { open: 100, close: 102, volume: 100 },
      { open: 102, close: 104, volume: 100 },
      { open: 104, close: 106, volume: 40 },
    ],
  });

  const decision = evaluateEntryCandleSanity({
    snapshot: { ohlcv: { source: 'meteora-dlmm-ohlcv', entryCandles5m: candles5m } },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: true,
      entryM15MinVolumeRatio: 0.7,
      entryM15VolumeLookbackCandles: 2,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'HOLD: M15 candle volume below threshold');
});

test('lp_simple_m15 entry sanity holds when M15 lookback is unavailable', () => {
  const now = 1_700_001_800_000;
  const nowSec = Math.floor(now / 1000);
  const candles5m = makeAligned5mCandles({
    nowSec,
    count: 6,
    startPrice: 100,
    step: 0.5,
    volume: 100,
  });

  const decision = evaluateEntryCandleSanity({
    snapshot: {
      ohlcv: {
        source: 'meteora-dlmm-ohlcv',
        entryCandles5m: candles5m,
      },
    },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: true,
      entryM15MinVolumeRatio: 0.7,
      entryM15VolumeLookbackCandles: 8,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'M15_VOLUME_LOOKBACK_UNAVAILABLE');
});

test('lp_simple_m15 entry sanity holds stale or missing derived M15', () => {
  const now = 1_700_001_800_000;
  const staleNowSec = Math.floor((now - (4 * 60 * 60 * 1000)) / 1000);
  const staleCandles = makeDerivedM15Backed5m({
    nowSec: staleNowSec,
    m15Series: [
      { open: 100, close: 101, volume: 100 },
      { open: 101, close: 102, volume: 100 },
      { open: 102, close: 103, volume: 100 },
    ],
  });
  const stale = evaluateEntryCandleSanity({
    snapshot: { ohlcv: { source: 'meteora-dlmm-ohlcv', entryCandles5m: staleCandles } },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: false,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'HOLD: M15 candle sanity unavailable/stale');

  const missing = evaluateEntryCandleSanity({
    snapshot: { ohlcv: { source: 'meteora-dlmm-ohlcv', entryCandles5m: [{ time: Math.floor(now / 1000) - 60, open: 1, high: 1, low: 1, close: 1, volume: 1 }] } },
    cfg: {
      entryCandleSanityEnabled: true,
      entryDecisionMode: 'lp_simple_m15',
      entryM15RequireGreenCandle: true,
      entryM15RequireVolumeConfirm: false,
      entryM15MaxAgeSec: 1800,
    },
    now,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'HOLD: M15 candle sanity unavailable/stale');
});

test('final entry candle sanity can be bypassed when entryCandleSanityEnabled=false', async () => {
  const now = 1_700_000_000_000;
  const decision = await getFinalEntryCandleSanityDecision({
    mint: '',
    now,
    cfg: { entryCandleSanityEnabled: false },
    pool: {},
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.source, 'disabled');
});

test('final entry candle hold log prints runtime cfg knobs', async () => {
  const now = 1_700_000_000_000;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const decision = await ensureFinalEntryCandleSanity({
      mint: 'Mint111111111111111111111111111111111111111',
      symbol: 'TEST',
      now,
      cfg: {
        entryCandleSanityEnabled: true,
        entryRequireGreenCandle: true,
        entryRequireVolumeConfirm: true,
        entryMinVolumeRatio: 1.7,
        entryVolumeLookbackCandles: 15,
        entryCandleMaxAgeSec: 777,
      },
      pool: {
        _marketSnapshot: {
          ohlcv: {
            source: 'test-cache',
            entryCandles5m: makeEntryCandles({ now, lastOpen: 100, lastClose: 105, lastVolume: 120 }),
          },
        },
      },
      snapshotFn: async () => null,
    });
    assert.equal(decision.ok, false);
  } finally {
    console.log = originalLog;
  }

  const holdLine = logs.find((line) => line.includes('FINAL_CANDLE_GATE_HOLD')) || '';
  assert.match(holdLine, /maxAgeSec=777/);
  assert.match(holdLine, /minRatio=1.7/);
  assert.match(holdLine, /lookback=15/);
  assert.match(holdLine, /green=true/);
  assert.match(holdLine, /volConfirm=true/);
});

test('lp_simple_m15 final gate hold log and reason use M15 wording', async () => {
  const now = 1_700_001_800_000;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const decision = await ensureFinalEntryCandleSanity({
      mint: 'Mint111111111111111111111111111111111111111',
      symbol: 'TESTM15',
      now,
      cfg: {
        entryCandleSanityEnabled: true,
        entryDecisionMode: 'lp_simple_m15',
        entryM15RequireGreenCandle: true,
        entryM15RequireVolumeConfirm: false,
        entryM15MaxAgeSec: 1800,
      },
      pool: {
        _marketSnapshot: {
          ohlcv: {
            source: 'meteora-dlmm-ohlcv',
            entryCandles5m: makeDerivedM15Backed5m({
              nowSec: Math.floor(now / 1000),
              m15Series: [
                { open: 100, close: 102, volume: 100 },
                { open: 102, close: 104, volume: 100 },
                { open: 104, close: 103, volume: 100 },
              ],
            }),
          },
        },
      },
      snapshotFn: async () => null,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'HOLD: last closed M15 candle not green');
  } finally {
    console.log = originalLog;
  }

  const holdLine = logs.find((line) => line.includes('FINAL_CANDLE_GATE_HOLD')) || '';
  assert.match(holdLine, /mode=lp_simple_m15/);
  assert.match(holdLine, /reason="HOLD: last closed M15 candle not green"/);
  assert.match(holdLine, /m15Open=/);
  assert.match(holdLine, /m15Close=/);
});

test('lp_simple_m15 final gate diagnostics include closed counts, age and volume ratio', async () => {
  const now = 1_700_001_800_000;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await ensureFinalEntryCandleSanity({
      mint: 'Mint111111111111111111111111111111111111111',
      symbol: 'TESTM15',
      now,
      cfg: {
        entryCandleSanityEnabled: true,
        entryDecisionMode: 'lp_simple_m15',
        entryM15RequireGreenCandle: true,
        entryM15RequireVolumeConfirm: true,
        entryM15MinVolumeRatio: 0.7,
        entryM15VolumeLookbackCandles: 2,
        entryM15MaxAgeSec: 1800,
      },
      pool: {
        _marketSnapshot: {
          ohlcv: {
            source: 'meteora-dlmm-ohlcv',
            entryCandles5m: makeDerivedM15Backed5m({
              nowSec: Math.floor(now / 1000),
              m15Series: [
                { open: 100, close: 102, volume: 100 },
                { open: 102, close: 104, volume: 100 },
                { open: 104, close: 103, volume: 70 },
              ],
            }),
          },
        },
      },
      snapshotFn: async () => null,
    });
  } finally {
    console.log = originalLog;
  }

  const holdLine = logs.find((line) => line.includes('FINAL_CANDLE_GATE_HOLD')) || '';
  assert.match(holdLine, /mode=lp_simple_m15/);
  assert.match(holdLine, /raw5m=/);
  assert.match(holdLine, /closed5m=/);
  assert.match(holdLine, /m15=/);
  assert.match(holdLine, /lastM15Ts=/);
  assert.match(holdLine, /ageSec=/);
  assert.match(holdLine, /maxAgeSec=/);
  assert.match(holdLine, /m15VolRatio=/);
  assert.match(holdLine, /m15MinRatio=/);
});

test('deploy report uses M15 primary in lp_simple_m15 and keeps strict unchanged', () => {
  const lpMsg = buildDeployTriggeredTelegramMessage({
    symbol: 'BULL',
    poolAddress: 'Pool11111111111111111111111111111111111111',
    check: {
      liveTrend: 'BULLISH',
      trendSource: 'live',
      liveM5: 0,
      m5Source: 'live',
    },
    decision: 'DEPLOY',
    entry: {
      pool: { binStep: 100 },
      meta: { entryReadiness: 'HIGH', breakoutQuality: 'VALID', entryTimingState: 'LP_LIVE' },
    },
    solAmount: 0.1,
    cfg: { entryDecisionMode: 'lp_simple_m15' },
    finalCandle: {
      diagnostics: {
        source: 'meteora-dlmm-ohlcv',
        m15Green: true,
        m15Open: 100,
        m15Close: 101,
        m15VolumeRatio: 0.82,
        m15AgeSec: 600,
      },
    },
  });
  assert.match(lpMsg, /M15:/);
  assert.match(lpMsg, /VolRatio:/);
  assert.match(lpMsg, /M5:/);
  assert.match(lpMsg, /diagnostic\/live/);

  const strictMsg = buildDeployTriggeredTelegramMessage({
    symbol: 'BULL',
    poolAddress: 'Pool11111111111111111111111111111111111111',
    check: {
      liveTrend: 'BULLISH',
      trendSource: 'live',
      liveM5: 0,
      m5Source: 'live',
    },
    decision: 'DEPLOY',
    entry: {
      pool: { binStep: 100 },
      meta: { entryReadiness: 'HIGH', breakoutQuality: 'VALID', entryTimingState: 'LP_LIVE' },
    },
    solAmount: 0.1,
    cfg: { entryDecisionMode: 'strict' },
    finalCandle: null,
  });
  assert.doesNotMatch(strictMsg, /M15:/);
  assert.doesNotMatch(strictMsg, /diagnostic\/live/);
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

test('hunter scout logic keeps strict gates and supports lp_simple_m15 mode overrides', () => {
  const hunterSrc = readFileSync(new URL('../src/agents/hunterAlpha.js', import.meta.url), 'utf8');
  assert.match(hunterSrc, /const lpSimpleM15Mode = entryDecisionMode === 'lp_simple_m15';/);
  assert.match(hunterSrc, /\(m5HardGateEnabled \|\| !lpSimpleM15Mode\) && priceChangeM5 <= 0/);
  assert.match(hunterSrc, /deferOnM15PreviousUnknown && !Number\.isFinite\(priceChangeM15Prev\)/);
  assert.match(hunterSrc, /Mode lp_simple_m15 aktif: M15 jadi konfirmasi utama/);
  assert.match(hunterSrc, /Jika TA M15 Previous = UNKNOWN, JANGAN auto-DEFER/);
});

test('lp_simple_m15 deploy report labels M15 as primary and M5 as diagnostic', () => {
  const message = buildDeployTriggeredTelegramMessage({
    symbol: 'BULL',
    poolAddress: 'Pool11111111111111111111111111111111111111',
    check: { liveTrend: 'BULLISH', trendSource: 'live', liveM5: 0, m5Source: 'live' },
    decision: 'DEPLOY',
    entry: {
      pool: { binStep: 100 },
      meta: { entryReadiness: 'HIGH', breakoutQuality: 'VALID', entryTimingState: 'LP_LIVE' },
    },
    solAmount: 0.1,
    cfg: { entryDecisionMode: 'lp_simple_m15' },
    finalCandle: {
      diagnostics: {
        source: 'meteora-dlmm-ohlcv',
        m15Green: true,
        m15Open: 100,
        m15Close: 101,
        m15VolumeRatio: 0.82,
        m15AgeSec: 600,
      },
    },
  });
  assert.match(message, /M15:/);
  assert.match(message, /M5:/);
  assert.match(message, /diagnostic\/live/);
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
    assert.match(neutral.reason, /\[FAIL_CLOSED\] Meridian Supertrend unsupported direction/);

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

test('queue marks explicit pool-specific fallback as reliable only when flagged', () => {
  const fallbackReliable = {
    dataSource: 'meridian-fallback',
    ohlcv: { historySuccess: false, source: 'meridian-fallback', priceChangeM5: 1.2, fallbackReliable: true },
    quality: { taSource: 'Meridian-15m' },
  };
  const fallbackIncomplete = {
    dataSource: 'meridian-fallback',
    ohlcv: { historySuccess: false, source: 'meridian-fallback', priceChangeM5: 0 },
    quality: { taSource: 'unknown' },
  };
  const fallbackUnknownSource = {
    dataSource: 'unknown',
    ohlcv: { historySuccess: false, source: 'unknown', priceChangeM5: 1.3, fallbackReliable: true },
  };
  const momentumProxy = {
    dataSource: 'momentum-proxy',
    ohlcv: { historySuccess: true, source: 'momentum-proxy', priceChangeM5: 1.3, fallbackReliable: true },
  };

  assert.equal(isReliableLiveSnapshot(fallbackReliable), true);
  assert.equal(getLiveSnapshotReliability(fallbackReliable).reason, 'MERIDIAN_FALLBACK_RELIABLE');
  assert.equal(isReliableLiveSnapshot(fallbackIncomplete), false);
  assert.equal(getLiveSnapshotReliability(fallbackIncomplete).reason, 'OHLCV_HISTORY_UNAVAILABLE');
  assert.equal(isReliableLiveSnapshot(fallbackUnknownSource), false);
  assert.equal(isReliableLiveSnapshot(momentumProxy), false);
});

test('queue unreliable snapshot diagnostic log includes source/history/issues/poolAddress', () => {
  const line = buildUnreliableLiveSnapshotLog({
    symbol: 'BURNIE',
    mint: 'Mint111111111111111111111111111111111111111',
    poolAddress: 'Pool11111111111111111111111111111111111111',
    poolAddressPassed: true,
    snapshot: {
      dataSource: 'unknown',
      ohlcv: { source: 'unknown', historySuccess: false, priceChangeM5: 0, ta: { candleCount: 0 } },
      quality: { taSource: 'unknown', issues: ['OHLCV_UNAVAILABLE'] },
    },
  });

  assert.match(line, /BURNIE/);
  assert.match(line, /pool=Pool11111/);
  assert.match(line, /source=unknown/);
  assert.match(line, /historySuccess=false/);
  assert.match(line, /fallbackReliable=false/);
  assert.match(line, /issues=\[OHLCV_UNAVAILABLE\]/);
  assert.match(line, /poolAddressPassed=yes/);
});

test('reliable meridian fallback still holds when trend or m5 cannot be resolved', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
    },
    liveSnapshot: {
      dataSource: 'meridian-fallback',
      ohlcv: { source: 'meridian-fallback', historySuccess: false, fallbackReliable: true, priceChangeM5: 0 },
      quality: { taSource: 'Meridian-15m', taTrend: 'UNKNOWN' },
      ta: { supertrend: { trend: 'UNKNOWN' } },
    },
    lpMode: true,
  });

  assert.equal(decision.decision, 'HOLD');
});

test('queue holds when snapshot is unreliable and trend is not explicitly bullish', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      queueTrustedWatch: true,
      taTrend: 'UNKNOWN',
      priceChangeM5: 1.2,
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'NEUTRAL' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: false, priceChangeM5: 1.2 },
      ta: { supertrend: { trend: 'NEUTRAL' } },
    },
    lpMode: true,
  });

  assert.equal(decision.decision, 'HOLD');
  assert.match(decision.reason, /unreliable/i);
});

test('queue snapshot path passes poolAddress to market snapshot resolver', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /getMarketSnapshot\(mint, poolAddress \|\| null, \{/);
  assert.match(src, /from: includeEntryCandles5m \? 'entry_candle_sanity' : 'deploy_queue'/);
  assert.match(src, /includeEntryCandles5m/);
  assert.match(src, /getCachedMarketSnapshot\(mint, poolAddress \|\| null, entry\.symbol \|\| '', \{ includeEntryCandles5m: true \}\)/);
});

test('deploy queue hold notification dedupe suppresses same candidate + same reason within cooldown', () => {
  __resetDeployQueueHoldNotifyState();
  const now = 1_700_000_000_000;

  const first = shouldSendDeployQueueHoldNotification({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now,
    cooldownMs: 180_000,
  });
  const second = shouldSendDeployQueueHoldNotification({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now: now + 60_000,
    cooldownMs: 180_000,
  });

  assert.equal(first.shouldSend, true);
  assert.equal(second.shouldSend, false);
});

test('queue treats DLMM invalid input as hold-notifyable retry signal', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /blockedByInvalidInput/);
  assert.match(src, /DLMM_INVALID_INPUT/);
  assert.match(src, /HOLD: DLMM invalid input during simulation/);
});

test('deploy queue hold notification dedupe allows same candidate + same reason after cooldown', () => {
  __resetDeployQueueHoldNotifyState();
  const now = 1_700_000_000_000;

  shouldSendDeployQueueHoldNotification({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now,
    cooldownMs: 120_000,
  });
  const afterCooldown = shouldSendDeployQueueHoldNotification({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now: now + 180_000,
    cooldownMs: 120_000,
  });

  assert.equal(afterCooldown.shouldSend, true);
});

test('deploy queue hold notification dedupe sends immediately when reason changes', () => {
  __resetDeployQueueHoldNotifyState();
  const now = 1_700_000_000_000;

  shouldSendDeployQueueHoldNotification({
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now,
    cooldownMs: 300_000,
  });
  const changedReason = shouldSendDeployQueueHoldNotification({
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle sanity unavailable/stale',
    now: now + 10_000,
    cooldownMs: 300_000,
  });

  assert.equal(changedReason.shouldSend, true);
});

test('deploy queue hold notification dedupe sends separately for different candidates', () => {
  __resetDeployQueueHoldNotifyState();
  const now = 1_700_000_000_000;

  shouldSendDeployQueueHoldNotification({
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold',
    now,
    cooldownMs: 180_000,
  });
  const differentCandidate = shouldSendDeployQueueHoldNotification({
    mint: 'Mint222222222222222222222222222222222222222',
    reason: 'HOLD: entry candle volume below threshold',
    now: now + 5_000,
    cooldownMs: 180_000,
  });

  assert.equal(differentCandidate.shouldSend, true);
});

test('deploy queue hold notification dedupe normalizes volatile attempt suffix', () => {
  __resetDeployQueueHoldNotifyState();
  const now = 1_700_000_000_000;

  shouldSendDeployQueueHoldNotification({
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold (attempt 1/3)',
    now,
    cooldownMs: 180_000,
  });
  const dedupedByNormalizedReason = shouldSendDeployQueueHoldNotification({
    mint: 'Mint111111111111111111111111111111111111111',
    reason: 'HOLD: entry candle volume below threshold (attempt 2/3)',
    now: now + 30_000,
    cooldownMs: 180_000,
  });

  assert.equal(dedupedByNormalizedReason.shouldSend, false);
});

test('deploy queue hold dedupe state is cleaned when candidate is removed', () => {
  __resetDeployQueueHoldNotifyState();
  try {
    const mint = 'Mint111111111111111111111111111111111111111';
    const poolAddress = 'Pool11111111111111111111111111111111111111';
    enqueueForDeploy({
      tokenXMint: mint,
      address: poolAddress,
      tokenYMint: 'So11111111111111111111111111111111111111112',
    }, 'TEST', {
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      taTrend: 'BULLISH',
      queueTrustedWatch: true,
    });
    assert.equal(getQueueSize() >= 1, true);

    shouldSendDeployQueueHoldNotification({
      poolAddress,
      mint,
      reason: 'HOLD: entry candle volume below threshold',
      now: 1_700_000_000_000,
      cooldownMs: 180_000,
    });
    dequeueToken(mint);

    const afterCleanup = shouldSendDeployQueueHoldNotification({
      poolAddress,
      mint,
      reason: 'HOLD: entry candle volume below threshold',
      now: 1_700_000_010_000,
      cooldownMs: 180_000,
    });
    assert.equal(afterCleanup.shouldSend, true);
  } finally {
    stopDeployQueueWatcher();
  }
});

test('deploy/drop notifications are not gated by hold dedupe helper', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  const holdSectionStart = src.indexOf('if (!finalCandle.ok) {');
  const holdSectionEnd = src.indexOf('continue;', holdSectionStart);
  const holdSection = src.slice(holdSectionStart, holdSectionEnd);
  assert.match(holdSection, /isSlotSaturationHoldReason\(/);
  assert.match(src, /shouldSendDeployQueueHoldNotification\(/);
  assert.match(src, /Deploy Queue Drop/);
  assert.match(src, /DEPLOY READY/);
});

test('slot saturated queue suppresses hold/drop noise for new candidates', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /function isDeploySlotSaturated\(\)/);
  assert.match(src, /if \(isDeploySlotSaturated\(\)\) \{/);
  assert.match(src, /Slot saturated, suppressing hold\/drop noise/);
  assert.match(src, /if \(isSlotSaturationHoldReason\(finalCandle\.reason\) \|\| isDeploySlotSaturated\(\)\) \{/);
  assert.match(src, /if \(holdNotice\.shouldSend && !isDeploySlotSaturated\(\)\) \{/);
  assert.match(src, /if \(!isDeploySlotSaturated\(\)\) \{/);
});

test('queue final ST gate uses latest live snapshot wiring', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /ensureFinalSupertrendBullish\(\{\s*mint,\s*symbol,\s*pool,\s*meta,\s*liveSnapshot:\s*entry\.lastLiveSnapshot\s*\|\|\s*null,\s*currentPrice,\s*\}\)/s);
  assert.match(src, /entry\?\.lastLiveSnapshot\?\.ohlcv\?\.currentPrice/);
});

test('final Supertrend stamp persists canonical source metadata', async () => {
  const { ensureFinalSupertrendBullish } = await importFresh(join(repoRoot, 'src/utils/pendingDeployQueue.js'));
  const meta = {};
  const pool = {};

  const decision = await ensureFinalSupertrendBullish({
    mint: 'Mint111111111111111111111111111111111111111',
    meta,
    pool,
    now: 1_700_000_000_000,
    checkFn: async () => ({ veto: false, direction: 'BULLISH', reason: 'PASS: Trend 15m BULLISH via Meridian API' }),
  });

  assert.equal(decision.action, 'ALLOW');
  assert.equal(meta.finalSupertrend15mSource, 'fresh_fetch');
  assert.equal(meta.supertrend15mSource, 'fresh_fetch');
  assert.equal(pool._finalSupertrend15mSource, 'fresh_fetch');
  assert.equal(pool._supertrend15mSource, 'fresh_fetch');
});

test('trusted WATCH LP entries hold on non-bullish live ST even with fresh bullish cache', async () => {
  const now = 1_700_000_000_000;
  const meta = {
    entryGateMode: 'lp_simple_m15',
    entryTimingState: 'LP_LIVE',
    entryReadiness: 'HIGH',
    breakoutQuality: 'VALID',
    queueTrustedWatch: true,
    taTrend: 'NEUTRAL',
    supertrend15m: 'BULLISH',
    supertrend15mAt: now - 5_000,
  };

  const decision = await getFinalSupertrendDeployDecision({
    mint: 'Mint111111111111111111111111111111111111111',
    meta,
    now,
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'NEUTRAL' },
      ohlcv: { source: 'meteora-dlmm-ohlcv', historySuccess: true, priceChangeM5: 1.2 },
      ta: { supertrend: { trend: 'NEUTRAL' } },
    },
    checkFn: async () => ({ veto: false, direction: 'BULLISH', reason: 'PASS (should not run)' }),
  });

  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.source, 'live_snapshot');
  assert.equal(decision.direction, 'NEUTRAL');
  assert.match(decision.reason, /not bullish/i);
});

test('deploy queue freezes intent only when bin, price, and snapshot are valid', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /function hasValidFrozenDeployIntent/);
  assert.match(src, /const deployIntentBin = frozenEnabled \? intentBin : null/);
  assert.match(src, /const deployIntentPrice = frozenEnabled \? intentPrice : null/);
  assert.match(src, /const deployIntentSnapshotAt = frozenEnabled \? intentSnapshotAt : null/);
  assert.match(src, /entryActiveBin:\s*deployIntentBin/);
  assert.match(src, /entryPrice:\s*deployIntentPrice/);
  assert.match(src, /snapshotAt:\s*deployIntentSnapshotAt/);
  assert.match(src, /enabled:\s*frozenEnabled/);
  assert.match(src, /required:\s*false/);
});

test('final entry proximity allows near-live price and bin state', () => {
  const now = Date.now();
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
      },
    },
    liveSnapshot: {
      snapshotAt: now,
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: { currentPrice: 100.4 },
      pool: { activeBinId: 121 },
    },
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'ALLOW');
  assert.equal(decision.comparedBy, 'price+bin');
});

test('final entry proximity holds when live drift is too wide', () => {
  const now = Date.now();
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
      },
    },
    liveSnapshot: {
      snapshotAt: now,
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: { currentPrice: 101.5 },
      pool: { activeBinId: 123 },
    },
    cfg: { entryFinalProximityMaxDriftPct: 1.0 },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.action, 'HOLD');
  assert.match(decision.reason, /entry proximity drift too wide/i);
});

test('final entry proximity respects runtime drift config', () => {
  const now = Date.now();
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
      },
    },
    liveSnapshot: {
      snapshotAt: now,
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: { currentPrice: 101.8 },
      pool: { activeBinId: 121 },
    },
    cfg: { entryFinalProximityMaxDriftPct: 2.5 },
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'ALLOW');
});

test('final entry proximity holds when live price/bin snapshot is unavailable', () => {
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
      },
    },
    liveSnapshot: {
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: {},
      pool: {},
    },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.action, 'HOLD');
  assert.match(decision.reason, /entry proximity unavailable/i);
});

test('final entry proximity holds when live snapshot is stale', () => {
  const now = Date.now();
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
      },
    },
    liveSnapshot: {
      snapshotAt: now - 180_000,
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: { currentPrice: 100.2 },
      pool: { activeBinId: 120 },
    },
    cfg: { entryFreshWatchWindowSec: 30 },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.action, 'HOLD');
  assert.match(decision.reason, /entry proximity unavailable/i);
});

test('final entry proximity respects canonical watch window for LP live snapshots', () => {
  const now = Date.now();
  const decision = getFinalEntryProximityDecision({
    meta: {
      entryCanonicalSnapshot: {
        entryPrice: 100,
        entryActiveBin: 120,
        watchWindowSec: 180,
      },
    },
    liveSnapshot: {
      snapshotAt: now - 120_000,
      dataSource: 'meteora-dlmm-ohlcv',
      ohlcv: { currentPrice: 100.3 },
      pool: { activeBinId: 120 },
    },
    cfg: { entryFreshWatchWindowSec: 30 },
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'ALLOW');
});

test('deploy queue applies final entry proximity hold before deploy', () => {
  const src = readFileSync(new URL('../src/utils/pendingDeployQueue.js', import.meta.url), 'utf8');
  assert.match(src, /let proximityDecision = getFinalEntryProximityDecision\(/);
  assert.match(src, /const refreshedSnapshot = await getCachedMarketSnapshot\(/);
  assert.match(src, /entry\.deferReason = proximityDecision\.reason/);
  assert.match(src, /Deploy Queue Hold/);
  assert.match(src, /Reason: <code>\$\{escapeHTML\(proximityDecision\.reason\)\}<\/code>/);
  assert.match(src, /Drift: <code>\$\{Number\.isFinite\(proximityDecision\.priceDriftPct\)/);
  assert.match(src, /Limit: <code>\$\{driftLimitPct\.toFixed\(2\)\}%<\/code>/);
  assert.match(src, /Bin: <code>\$\{Number\.isFinite\(proximityDecision\.binDelta\)/);
  assert.match(src, /proximity=\$\{proximityDecision\.comparedBy \|\| 'na'\}/);
});

test('deploy queue live snapshot helper is exported for direct deploy reuse', () => {
  assert.equal(typeof getDeployQueueLiveSnapshot, 'function');
});

test('queue summary holds when queued canonical trend is conflicted', () => {
  const decision = summarizeQueueDecision({
    meta: {
      entryTimingState: 'LP_LIVE',
      taTrend: 'UNKNOWN',
      taTrendConflicted: true,
      taTrendQualitySource: 'BULLISH',
      taTrendTaSource: 'BEARISH',
    },
    liveSnapshot: {
      snapshotAt: Date.now(),
      dataSource: 'meteora-dlmm-ohlcv',
      quality: { taTrend: 'UNKNOWN' },
      ta: { supertrend: { trend: 'UNKNOWN' } },
      ohlcv: { priceChangeM5: 1.2, source: 'meteora-dlmm-ohlcv', historySuccess: true },
    },
    cfg: { entryDecisionMode: 'lp_simple_m15' },
    lpMode: true,
  });

  assert.equal(decision.decision, 'HOLD');
  assert.match(decision.reason, /trend conflict/i);
});
