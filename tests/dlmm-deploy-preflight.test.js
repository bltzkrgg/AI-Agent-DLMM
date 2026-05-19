import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';

import {
  buildDlmmDeployStrategyArgs,
  assertDlmmFinalSdkArgs,
  buildDlmmFinalArgsContext,
  buildDlmmSdkStrategyFromDeployArgs,
  rebuildDeployArgsWithRefreshedActiveBin,
  wrapDlmmSdkInvalidArgumentsError,
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

test('single-side tokenX including active bin is adjusted above active bin', () => {
  const out = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 1000,
    rangeMax: 1010,
    amountXBn: new BN('500000000'),
    amountYBn: new BN('0'),
  });

  assert.equal(out.adjustedAboveActive, true);
  assert.equal(out.rangeMin, 1001);
  assert.equal(out.rangeMax, 1011);
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

test('final args preflight rejects non-finite activeBin and inverted range before SDK', () => {
  assert.throws(
    () => assertDlmmFinalSdkArgs({
      deployArgs: {
        activeBinId: Number.NaN,
        rangeMin: 980,
        rangeMax: 999,
        amountXBn: new BN('1'),
        amountYBn: new BN('1'),
      },
      sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
      xMint: 'Mint111111111111111111111111111111111111111',
      yMint: 'So11111111111111111111111111111111111111112',
      poolAddress: 'Pool11111111111111111111111111111111111111',
    }),
    /activeBinId must be finite integer/
  );

  assert.throws(
    () => assertDlmmFinalSdkArgs({
      deployArgs: {
        activeBinId: 1000,
        rangeMin: 1001,
        rangeMax: 1000,
        amountXBn: new BN('1'),
        amountYBn: new BN('1'),
      },
      sdkStrategy: { minBinId: 1001, maxBinId: 1000, strategyType: 0 },
      xMint: 'Mint111111111111111111111111111111111111111',
      yMint: 'So11111111111111111111111111111111111111112',
      poolAddress: 'Pool11111111111111111111111111111111111111',
    }),
    /rangeMin must be <= rangeMax/
  );
});

test('final args preflight rejects zero amount and invalid single-side active bin relation', () => {
  assert.throws(
    () => assertDlmmFinalSdkArgs({
      deployArgs: {
        activeBinId: 1000,
        rangeMin: 980,
        rangeMax: 999,
        amountXBn: new BN('0'),
        amountYBn: new BN('0'),
      },
      sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
      xMint: 'Mint111111111111111111111111111111111111111',
      yMint: 'So11111111111111111111111111111111111111112',
      poolAddress: 'Pool11111111111111111111111111111111111111',
    }),
    /amountX \+ amountY must be > 0/
  );

  assert.throws(
    () => assertDlmmFinalSdkArgs({
      deployArgs: {
        activeBinId: 1000,
        rangeMin: 995,
        rangeMax: 1000,
        amountXBn: new BN('0'),
        amountYBn: new BN('1'),
      },
      sdkStrategy: { minBinId: 995, maxBinId: 1000, strategyType: 0 },
      xMint: 'Mint111111111111111111111111111111111111111',
      yMint: 'So11111111111111111111111111111111111111112',
      poolAddress: 'Pool11111111111111111111111111111111111111',
    }),
    /range violates final side invariant/
  );
});

test('final args preflight rejects non BN/number-like amount input before SDK', () => {
  assert.throws(
    () => assertDlmmFinalSdkArgs({
      deployArgs: {
        activeBinId: 1000,
        rangeMin: 980,
        rangeMax: 999,
        amountXBn: 'foo',
        amountYBn: new BN('1'),
      },
      sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
      xMint: 'Mint111111111111111111111111111111111111111',
      yMint: 'So11111111111111111111111111111111111111112',
      poolAddress: 'Pool11111111111111111111111111111111111111',
    }),
    /amountX must be BN\/number-like integer/
  );
});

test('final args context sanitizes range, amounts and active bin for SDK rejection logs', () => {
  const ctx = buildDlmmFinalArgsContext({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    xMint: 'Mint111111111111111111111111111111111111111',
    yMint: 'So11111111111111111111111111111111111111112',
    deployArgs: {
      activeBinId: 1000,
      rangeMin: 980,
      rangeMax: 999,
      amountXBn: new BN('10'),
      amountYBn: new BN('20'),
    },
    sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
  });

  assert.equal(ctx.pool.startsWith('Pool1111'), true);
  assert.equal(ctx.activeBinId, 1000);
  assert.equal(ctx.rangeMin, 980);
  assert.equal(ctx.rangeMax, 999);
  assert.equal(ctx.amountX, '10');
  assert.equal(ctx.amountY, '20');
  assert.equal(ctx.singleSide, 'MIXED');
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

test('deploy args are rebuilt from refreshed active bin before final strategy', () => {
  const original = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 995,
    rangeMax: 1005,
    amountXBn: new BN('1'),
    amountYBn: new BN('0'),
  });
  const rebuilt = rebuildDeployArgsWithRefreshedActiveBin({
    deployArgs: original,
    refreshedActiveBinId: 1003,
  });

  assert.equal(rebuilt.activeBinId, 1003);
  assert.equal(rebuilt.rangeMin, 1004);
  assert.equal(rebuilt.rangeMax, 1014);
});

test('invalid adjusted range fails before SDK call', () => {
  assert.throws(
    () => buildDlmmDeployStrategyArgs({
      activeBinId: Number.NaN,
      rangeMin: Number.NaN,
      rangeMax: Number.NaN,
      amountXBn: new BN('0'),
      amountYBn: new BN('1'),
    }),
    /activeBin\.binId must be finite integer/
  );
});

test('rent guard can be rechecked after active-bin refresh range change', async () => {
  const initial = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 995,
    rangeMax: 1005,
    amountXBn: new BN('1'),
    amountYBn: new BN('0'),
  });
  const refreshed = rebuildDeployArgsWithRefreshedActiveBin({
    deployArgs: initial,
    refreshedActiveBinId: 1003,
  });

  let assertCalls = 0;
  const out = await ensureFinalRentCheckedDeployArgs({
    hasNonRefundableFees: true,
    connection: {},
    poolPubkey: {},
    poolAddress: '11111111111111111111111111111111',
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    checkedRangeMin: initial.rangeMin,
    checkedRangeMax: initial.rangeMax,
    rangeMaxBins: 100,
    activeBinId: refreshed.activeBinId,
    deployArgs: refreshed,
    assertRangeFn: async () => { assertCalls += 1; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.finalRangeChanged, true);
  assert.equal(assertCalls, 1);
});

test('SDK invalid arguments wrapper includes final args context', () => {
  const wrapped = wrapDlmmSdkInvalidArgumentsError({
    error: new Error('invalid arguments: strategy'),
    finalArgsContext: {
      pool: 'Pool111',
      tokenXMint: 'Mint111',
      tokenYMint: 'So111',
      activeBinId: 1000,
      rangeMin: 980,
      rangeMax: 999,
      amountXIsZero: true,
      amountYIsZero: false,
      strategyType: 0,
    },
  });

  assert.equal(wrapped?.code, 'INVALID_DLMM_DEPLOY_ARGS');
  assert.match(String(wrapped?.message || ''), /context=\{/);
  assert.match(String(wrapped?.message || ''), /activeBinId/);
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

test('SDK strategy range equals final rent-checked deployArgs range', async () => {
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 932,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('55'),
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
      if (minBinId === deployArgs.rangeMin && maxBinId === deployArgs.rangeMax) {
        throw new Error('BIN_ARRAY_RENT_REQUIRED: unsafe range');
      }
    },
    findAdaptiveFn: async () => ({
      adjusted: { rangeMin: 900, rangeMax: 970 },
    }),
  });

  assert.equal(out.ok, true);
  const sdkStrategy = buildDlmmSdkStrategyFromDeployArgs(out.deployArgs);
  assert.equal(sdkStrategy.minBinId, out.deployArgs.rangeMin);
  assert.equal(sdkStrategy.maxBinId, out.deployArgs.rangeMax);
});
