import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __compareDiscoveryPriorityForTests,
  __getDiscoveryActivityBiasScoreForTests,
  __getDiscoveryLivingFlowScoreForTests,
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

test('discovery priority still respects configured bin-step order first', () => {
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

  assert.equal(out < 0, true);
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
