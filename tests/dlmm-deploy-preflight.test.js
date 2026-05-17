import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';

import {
  buildDlmmDeployStrategyArgs,
  buildDlmmSdkStrategyFromDeployArgs,
  ensureFinalRentCheckedDeployArgs,
} from '../src/sniper/evilPanda.js';
import { StrategyType } from '@meteora-ag/dlmm';

test('single-side quote including active bin is adjusted below active bin', () => {
  const out = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 990,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('500000000'),
  });

  assert.equal(out.adjustedBelowActive, true);
  assert.equal(out.rangeMax, 999);
  assert.equal(out.rangeMin, 989);
});

test('valid range and positive amount passes preflight', () => {
  const out = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('500000000'),
  });

  assert.equal(out.rangeMin, 980);
  assert.equal(out.rangeMax, 999);
  assert.equal(out.amountYBn.toString(), '500000000');
});

test('inverted range fails before SDK call', () => {
  assert.throws(
    () => buildDlmmDeployStrategyArgs({
      activeBinId: 1000,
      rangeMin: 1002,
      rangeMax: 1001,
      amountXBn: new BN('1'),
      amountYBn: new BN('1'),
    }),
    /Invalid DLMM deploy args: rangeMin must be <= rangeMax/
  );
});

test('zero total amount fails before SDK call', () => {
  assert.throws(
    () => buildDlmmDeployStrategyArgs({
      activeBinId: 1000,
      rangeMin: 980,
      rangeMax: 999,
      amountXBn: new BN('0'),
      amountYBn: new BN('0'),
    }),
    /Invalid DLMM deploy args: amountX \+ amountY must be > 0/
  );
});

test('strategy type defaults to SDK Spot enum when available', () => {
  const out = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('1'),
    amountYBn: new BN('1'),
  });

  const expectedSpot = Number(StrategyType?.Spot ?? 0);
  assert.equal(out.strategyType, expectedSpot);
});

test('final SDK strategy is built from adjusted deployArgs range, not original unsafe range', () => {
  const activeBinId = 1000;
  const originalRangeMin = 932;
  const originalRangeMax = 1000;
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId,
    rangeMin: originalRangeMin,
    rangeMax: originalRangeMax,
    amountXBn: new BN('0'),
    amountYBn: new BN('250000000'),
  });

  const strategy = buildDlmmSdkStrategyFromDeployArgs(deployArgs);
  assert.equal(strategy.maxBinId, deployArgs.rangeMax);
  assert.equal(strategy.minBinId, deployArgs.rangeMin);
  assert.ok(strategy.maxBinId < activeBinId);
  assert.notEqual(strategy.maxBinId, originalRangeMax);
});

test('final rent guard is skipped for normal pools (hasNonRefundableFees=false)', async () => {
  let assertCalls = 0;
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('10'),
  });

  const out = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: false,
    deployArgs,
    assertRangeFn: async () => { assertCalls += 1; },
  });

  assert.equal(out.ok, true);
  assert.equal(out.guard, 'SKIP_NON_REFUNDABLE_FALSE');
  assert.equal(assertCalls, 0);
});

test('final rent guard re-checks when preflight changed range and keeps unchanged range pass when same', async () => {
  let assertCalls = 0;
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 932,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('20'),
  });

  const changedOut = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: true,
    connection: {},
    poolPubkey: {},
    poolAddress: '11111111111111111111111111111111',
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    checkedRangeMin: 932,
    checkedRangeMax: 1000,
    rangeMaxBins: 100,
    activeBinId: 1000,
    deployArgs,
    assertRangeFn: async () => { assertCalls += 1; },
  });
  assert.equal(changedOut.ok, true);
  assert.equal(changedOut.finalRangeChanged, true);
  assert.equal(assertCalls, 1);

  assertCalls = 0;
  const sameOut = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: true,
    connection: {},
    poolPubkey: {},
    poolAddress: '11111111111111111111111111111111',
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    checkedRangeMin: deployArgs.rangeMin,
    checkedRangeMax: deployArgs.rangeMax,
    rangeMaxBins: 100,
    activeBinId: 1000,
    deployArgs,
    assertRangeFn: async () => { assertCalls += 1; },
  });
  assert.equal(sameOut.ok, true);
  assert.equal(sameOut.guard, 'UNCHANGED_RANGE_PASS');
  assert.equal(assertCalls, 0);
});

test('final rent guard can adapt unsafe final range and return safe deployArgs', async () => {
  let assertCalls = 0;
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 932,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('30'),
  });

  const out = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: true,
    connection: {},
    poolPubkey: {},
    poolAddress: '11111111111111111111111111111111',
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    checkedRangeMin: 932,
    checkedRangeMax: 1000,
    rangeMaxBins: 100,
    activeBinId: 1000,
    deployArgs,
    assertRangeFn: async (_connection, _poolPubkey, minBinId, maxBinId) => {
      assertCalls += 1;
      if (minBinId === deployArgs.rangeMin && maxBinId === deployArgs.rangeMax) {
        throw new Error('BIN_ARRAY_RENT_REQUIRED: unsafe range');
      }
    },
    findAdaptiveFn: async () => ({
      adjusted: { rangeMin: 910, rangeMax: 980 },
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.guard, 'ADJUSTED_PASS');
  assert.equal(out.deployArgs.rangeMin, 910);
  assert.equal(out.deployArgs.rangeMax, 980);
  assert.ok(assertCalls >= 2);
});

test('final rent guard vetoes when no safe final range exists and does not call SDK path', async () => {
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 932,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('40'),
  });

  const out = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: true,
    connection: {},
    poolPubkey: {},
    poolAddress: '11111111111111111111111111111111',
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    checkedRangeMin: 932,
    checkedRangeMax: 1000,
    rangeMaxBins: 100,
    activeBinId: 1000,
    deployArgs,
    assertRangeFn: async () => {
      throw new Error('BIN_ARRAY_RENT_REQUIRED: unsafe range');
    },
    findAdaptiveFn: async () => null,
  });

  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.equal(out.reason, 'VETO_NON_REFUNDABLE_RENT');
});
