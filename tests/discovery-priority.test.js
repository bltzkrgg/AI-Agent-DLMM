import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __compareDiscoveryPriorityForTests,
  __getDiscoveryActivityBiasScoreForTests,
  __getDiscoveryLivingFlowScoreForTests,
  __isObservedDryDiscoveryPoolForTests,
  __normalizeDiscoveryPoolForTests,
} from '../src/market/meridianVeto.js';

test('trending discovery prioritizes higher activity before fee ratio', () => {
  const activeButLowerFee = {
    binStep: 100,
    volume24h: 900000,
    swapCount24h: 1800,
    feeActiveTvlRatio: 0.021,
    activeTvl: 50000,
  };
  const quieterHigherFee = {
    binStep: 100,
    volume24h: 180000,
    swapCount24h: 220,
    feeActiveTvlRatio: 0.035,
    activeTvl: 52000,
  };

  const out = __compareDiscoveryPriorityForTests(activeButLowerFee, quieterHigherFee, {
    binStepPriority: [200, 125, 100],
    priorityMode: 'trend_activity',
  });

  assert.equal(out < 0, true);
});

test('top performers discovery still prefers living flow before raw fee ratio', () => {
  const higherFeeButLessAlive = {
    binStep: 100,
    volume24h: 250000,
    swapCount24h: 300,
    feeActiveTvlRatio: 0.045,
    activeTvl: 40000,
    fees24h: 180,
  };
  const busierAndAlive = {
    binStep: 100,
    volume24h: 800000,
    swapCount24h: 1500,
    feeActiveTvlRatio: 0.022,
    activeTvl: 42000,
    fees24h: 1100,
  };

  const out = __compareDiscoveryPriorityForTests(higherFeeButLessAlive, busierAndAlive, {
    binStepPriority: [200, 125, 100],
    priorityMode: 'performance_activity',
  });

  assert.equal(out > 0, true);
});

test('discovery priority treats bin-step as an allowlist after activity', () => {
  const lowerBinPriority = {
    binStep: 100,
    volume24h: 1000000,
    swapCount24h: 2000,
    feeActiveTvlRatio: 0.08,
  };
  const higherBinPriority = {
    binStep: 125,
    volume24h: 200000,
    swapCount24h: 150,
    feeActiveTvlRatio: 0.01,
  };

  const out = __compareDiscoveryPriorityForTests(higherBinPriority, lowerBinPriority, {
    binStepPriority: [200, 125, 100],
    priorityMode: 'trend_activity',
  });

  assert.equal(out > 0, true);
});

test('canonical Meteora metrics preserve recent activity and pool age', () => {
  const createdAt = Date.now() - (90 * 60 * 1000);
  const pool = __normalizeDiscoveryPoolForTests({
    address: 'PoolCanonical',
    pool_config: { bin_step: 125 },
    token_x: { address: 'MintCanonical', symbol: 'NEW' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
    volume: { '1h': 52000, '24h': 120000 },
    fees: { '1h': 95, '24h': 240 },
    swap_count_1h: 180,
    swap_count: 700,
    fee_tvl_ratio: { '1h': 0.007, '24h': 0.018 },
    tvl: 18000,
    created_at: createdAt,
  });

  assert.equal(pool.binStep, 125);
  assert.equal(pool.volume1h, 52000);
  assert.equal(pool.volume24h, 120000);
  assert.equal(pool.fees1h, 95);
  assert.equal(pool.feeActiveTvlRatio, 0.018);
  assert.equal(pool.activityState, 'OBSERVED_ACTIVE');
  assert.equal(pool.poolAgeHours >= 1.4 && pool.poolAgeHours <= 1.6, true);
});

test('flat Meteora discovery metrics populate the requested 1h activity window', () => {
  const pool = __normalizeDiscoveryPoolForTests({
    pool_address: 'PoolFlat',
    pool_config: { bin_step: 100 },
    token_x: { address: 'MintFlat', symbol: 'FLAT' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
    volume: 120445.51,
    fee: 2713.88,
    swap_count: 2504,
    avg_volume: 83.64,
    avg_fee: 1.8846,
    avg_swap_count: 1.7389,
    volume_change_pct: 376.48,
    fee_change_pct: 334.56,
    swap_count_change_pct: 194.59,
    fee_active_tvl_ratio: 0.155,
    tvl: 61600,
  }, 'TEST', '1h');

  assert.equal(pool.volume1h, 120445.51);
  assert.equal(pool.fees1h, 2713.88);
  assert.equal(pool.swapCount1h, 2504);
  assert.equal(pool.discoveryTimeframe, '1h');
  assert.equal(pool.activityState, 'OBSERVED_ACTIVE');
  assert.equal(pool.flowTrendScore, 100);
});

test('missing swap activity stays unknown instead of being coerced to dry', () => {
  const pool = __normalizeDiscoveryPoolForTests({
    address: 'PoolUnknown',
    pool_config: { bin_step: 100 },
    token_x: { address: 'MintUnknown', symbol: 'UNKNOWN' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
    volume: { '24h': 300000 },
    fees: { '24h': 500 },
    tvl: 25000,
  });

  assert.equal(pool.activityState, 'UNKNOWN_ACTIVITY');
  assert.equal(pool.swapCount24h, null);
  assert.equal(__isObservedDryDiscoveryPoolForTests(pool), false);
});

test('rising live flow outranks a larger historical pool that is cooling', () => {
  const rising = {
    binStep: 125,
    activityState: 'OBSERVED_ACTIVE',
    volume1h: 85000,
    fees1h: 420,
    swapCount1h: 900,
    volumeChangePct: 95,
    feeChangePct: 80,
    swapCountChangePct: 70,
    volume24h: 180000,
    fees24h: 700,
    swapCount24h: 1300,
    activeTvl: 30000,
  };
  const cooling = {
    binStep: 100,
    activityState: 'OBSERVED_ACTIVE',
    volume1h: 12000,
    fees1h: 40,
    swapCount1h: 90,
    volumeChangePct: -70,
    feeChangePct: -65,
    swapCountChangePct: -60,
    volume24h: 900000,
    fees24h: 2400,
    swapCount24h: 3500,
    activeTvl: 50000,
  };

  assert.equal(__compareDiscoveryPriorityForTests(rising, cooling, {
    binStepPriority: [100, 125, 200],
    priorityMode: 'trend_activity',
  }) < 0, true);
});

test('recent zero fee and swaps classify a historical spike as stale', () => {
  const pool = __normalizeDiscoveryPoolForTests({
    address: 'PoolStale',
    pool_config: { bin_step: 100 },
    token_x: { address: 'MintStale', symbol: 'STALE' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
    volume: { '1h': 18000, '24h': 920000 },
    fees: { '1h': 0, '24h': 0 },
    swap_count_1h: 0,
    swap_count: 0,
    tvl: 30000,
  });

  assert.equal(pool.activityState, 'STALE_SPIKE');
  assert.equal(__isObservedDryDiscoveryPoolForTests(pool), true);
});

test('activity bias penalizes quiet pools even when they are technically valid', () => {
  const activePool = {
    volume24h: 640000,
    feeActiveTvlRatio: 0.018,
    fees24h: 1200,
    swapCount24h: 1400,
    activeTvl: 120000,
  };
  const sleepyPool = {
    volume24h: 38000,
    feeActiveTvlRatio: 0.004,
    fees24h: 62,
    swapCount24h: 90,
    activeTvl: 110000,
  };

  assert.equal(__getDiscoveryActivityBiasScoreForTests(activePool) > __getDiscoveryActivityBiasScoreForTests(sleepyPool), true);
});

test('default discovery prefers active spike with real fee flow over dry higher fee ratio pool', () => {
  const activeSpike = {
    binStep: 100,
    volume24h: 980000,
    fees24h: 1450,
    swapCount24h: 1850,
    feeActiveTvlRatio: 0.019,
    activeTvl: 155000,
  };
  const dryHigherRatio = {
    binStep: 100,
    volume24h: 92000,
    fees24h: 72,
    swapCount24h: 108,
    feeActiveTvlRatio: 0.034,
    activeTvl: 18000,
  };

  const out = __compareDiscoveryPriorityForTests(activeSpike, dryHigherRatio, {
    binStepPriority: [200, 125, 100],
    priorityMode: 'fee_first',
  });

  assert.equal(__getDiscoveryLivingFlowScoreForTests(activeSpike) > __getDiscoveryLivingFlowScoreForTests(dryHigherRatio), true);
  assert.equal(out < 0, true);
});

test('discovery living-flow score penalizes volume spikes without supporting fee flow', () => {
  const supportedSpike = {
    volume24h: 760000,
    fees24h: 820,
    swapCount24h: 1220,
    feeActiveTvlRatio: 0.016,
    activeTvl: 110000,
  };
  const hollowSpike = {
    volume24h: 760000,
    fees24h: 0,
    swapCount24h: 0,
    feeActiveTvlRatio: 0.028,
    activeTvl: 90000,
  };

  assert.equal(
    __getDiscoveryLivingFlowScoreForTests(supportedSpike) > __getDiscoveryLivingFlowScoreForTests(hollowSpike),
    true,
  );
});
