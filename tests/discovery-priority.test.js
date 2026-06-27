import test from 'node:test';
import assert from 'node:assert/strict';

import { __compareDiscoveryPriorityForTests } from '../src/market/meridianVeto.js';

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

test('top performers discovery keeps fee efficiency ahead, then activity', () => {
  const strongerPerformance = {
    binStep: 100,
    volume24h: 250000,
    swapCount24h: 300,
    feeActiveTvlRatio: 0.045,
    activeTvl: 40000,
  };
  const weakerPerformanceButBusier = {
    binStep: 100,
    volume24h: 800000,
    swapCount24h: 1500,
    feeActiveTvlRatio: 0.022,
    activeTvl: 42000,
  };

  const out = __compareDiscoveryPriorityForTests(strongerPerformance, weakerPerformanceButBusier, {
    binStepPriority: [200, 125, 100],
    priorityMode: 'performance_activity',
  });

  assert.equal(out < 0, true);
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
