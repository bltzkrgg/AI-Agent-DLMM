import test from 'node:test';
import assert from 'node:assert/strict';

import { estimatePaperFeeAccrual } from '../src/paper/paperFeeEstimate.js';

test('paper fee estimate accrues pool fee/TVL yield while in range', () => {
  const result = estimatePaperFeeAccrual({
    capitalSol: 0.1,
    fees24h: 1_000,
    tvl: 100_000,
    elapsedMs: 12 * 60 * 60 * 1000,
    inRange: true,
  });

  assert.equal(result.available, true);
  assert.equal(result.dailyFeeTvlRatio, 0.01);
  assert.equal(result.incrementSol, 0.0005);
  assert.equal(result.feeSol, 0.0005);
});

test('paper fee estimate does not accrue while out of range', () => {
  const result = estimatePaperFeeAccrual({
    previousFeeSol: 0.0002,
    previousAvailable: true,
    capitalSol: 0.1,
    fees24h: 1_000,
    tvl: 100_000,
    elapsedMs: 12 * 60 * 60 * 1000,
    inRange: false,
  });

  assert.equal(result.available, true);
  assert.equal(result.incrementSol, 0);
  assert.equal(result.feeSol, 0.0002);
});

test('paper fee estimate preserves prior estimate when pool yield is unavailable', () => {
  const result = estimatePaperFeeAccrual({
    previousFeeSol: 0.0002,
    previousAvailable: true,
    capitalSol: 0.1,
    fees24h: null,
    tvl: null,
    elapsedMs: 300_000,
    inRange: true,
  });

  assert.equal(result.available, true);
  assert.equal(result.incrementSol, 0);
  assert.equal(result.feeSol, 0.0002);
  assert.equal(result.dailyFeeTvlRatio, null);
});
