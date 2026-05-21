import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
  assertNoCombinedWeightForQuoteOnly,
  buildDlmmDeployStrategyArgs,
  assertDlmmFinalSdkArgs,
  buildDlmmFinalArgsContext,
  buildQuoteOnlyDryRunPlan,
  buildDlmmSdkStrategyFromDeployArgs,
  buildQuoteOnlyWeightDistribution,
  executeQuoteOnlyPositionFirstFlow,
  rebuildDeployArgsWithRefreshedActiveBin,
  prepareFinalDlmmDeployAttemptState,
  executeDlmmInitializePositionWithRetry,
  __getQuoteOnlyDeployMarkerForTests,
  __handleQuoteOnlyPartialDeployFailureForTests,
  __isBotQuoteOnlyPartialMarkerForTests,
  __markQuoteOnlyLiquidityConfirmedForTests,
  __setQuoteOnlyDeployMarkerForTests,
  __verifyQuoteOnlyLiquidityOnChainForTests,
  __extractRequiredSignerPubkeysForTests,
  __inspectTxForBinArrayInitForTests,
  __guardDlmmCostBeforeSendForTests,
  __deriveSpotBidAskSeedPlanForTests,
  __assertNoUnexpectedSolTransferInTxForTests,
  filterKnownTransactionSigners,
  getPositionMeta,
  getPositionOnChainStatus,
  setPositionLifecycle,
  extractDlmmSdkDeployErrorMeta,
  isDlmmSdkInvalidArgumentsError,
  selectDlmmSdkPathForDeployArgs,
  wrapDlmmSdkInvalidArgumentsError,
  computeFinalExitAccounting,
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

test('pure quote-only final deploy selects one-side weight SDK path', () => {
  const quoteOnly = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100'),
  });
  const mixed = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('1'),
    amountYBn: new BN('100'),
  });

  assert.equal(selectDlmmSdkPathForDeployArgs(quoteOnly), 'weight_quote_only');
  assert.equal(selectDlmmSdkPathForDeployArgs(mixed), 'strategy');
});

test('non-quote-only final deploy keeps strategy SDK path', () => {
  const baseOnly = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 1001,
    rangeMax: 1010,
    amountXBn: new BN('100'),
    amountYBn: new BN('0'),
  });
  assert.equal(selectDlmmSdkPathForDeployArgs(baseOnly), 'strategy');
});

test('quote-only weight distribution is y-only, contiguous, and totals 10000 bps', () => {
  const dist = buildQuoteOnlyWeightDistribution({ rangeMin: -467, rangeMax: -400 });
  assert.equal(dist.length, 68);
  assert.equal(dist[0].binId, -467);
  assert.equal(dist[dist.length - 1].binId, -400);

  const totalYBps = dist.reduce((acc, row) => acc.add(row.yAmountBpsOfTotal), new BN('0'));
  const totalXBps = dist.reduce((acc, row) => acc.add(row.xAmountBpsOfTotal), new BN('0'));
  assert.equal(totalYBps.toString(), '10000');
  assert.equal(totalXBps.toString(), '0');
  assert.equal(dist.every((row) => row.xAmountBpsOfTotal.isZero()), true);
  assert.equal(dist.some((row) => row.yAmountBpsOfTotal.gt(new BN('0'))), true);
});

test('guard blocks combined weight helper usage for pure quote-only', () => {
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100'),
  });
  assert.throws(
    () => assertNoCombinedWeightForQuoteOnly({
      deployArgs,
      sdkPath: 'weight_quote_only',
      sdkMethod: 'initializePositionAndAddLiquidityByWeight',
    }),
    /must not call initializePositionAndAddLiquidityByWeight/
  );
});

test('guard allows non-quote-only strategy path', () => {
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 1001,
    rangeMax: 1010,
    amountXBn: new BN('100'),
    amountYBn: new BN('0'),
  });
  assert.doesNotThrow(
    () => assertNoCombinedWeightForQuoteOnly({
      deployArgs,
      sdkPath: 'strategy',
      sdkMethod: 'initializePositionAndAddLiquidityByStrategy',
    })
  );
});

test('quote-only dry-run plan does not call combined helper and carries plan context', () => {
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100000000'),
  });
  const distribution = buildQuoteOnlyWeightDistribution({
    rangeMin: deployArgs.rangeMin,
    rangeMax: deployArgs.rangeMax,
  });
  const plan = buildQuoteOnlyDryRunPlan({
    poolAddress: 'Pool11111111111111111111111111111111111111',
    deployArgs,
    xYAmountDistribution: distribution,
    finalArgsContext: { sdkPath: 'weight_quote_only' },
  });
  assert.equal(plan.quoteOnlyDryRunPlan, true);
  assert.equal(plan.sdkPath, 'weight_quote_only');
  assert.equal(plan.sdkFlow, 'quote_only_dry_run_plan');
  assert.equal(plan.sdkMethod, 'dryRunPlan');
  assert.equal(plan.bins, distribution.length);
  assert.equal(plan.rangeMin, 980);
  assert.equal(plan.rangeMax, 999);
  assert.doesNotThrow(
    () => assertNoCombinedWeightForQuoteOnly({
      deployArgs,
      sdkPath: 'weight_quote_only',
      sdkMethod: plan.sdkMethod,
    })
  );
});

test('quote-only position-first flow initializes position before add liquidity and does not call combined init+weight helper', async () => {
  const calls = [];
  const positionKeypair = Keypair.generate();
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100000000'),
  });
  const dist = buildQuoteOnlyWeightDistribution({
    rangeMin: deployArgs.rangeMin,
    rangeMax: deployArgs.rangeMax,
  });
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const connection = {
    getAccountInfo: async (_pubkey) => {
      const initDone = calls.includes('createEmptyPosition');
      if (!initDone) return null;
      return { owner: expectedProgramId };
    },
  };
  const dlmmPool = {
    program: { programId: expectedProgramId },
    createEmptyPosition: async ({ minBinId, maxBinId }) => {
      calls.push('createEmptyPosition');
      calls.push(`range-[${minBinId},${maxBinId}]`);
      return { instructions: [] };
    },
    addLiquidityByWeight: async ({ xYAmountDistribution }) => {
      calls.push('addLiquidityByWeight');
      calls.push(`dist-[${xYAmountDistribution[0].binId},${xYAmountDistribution[xYAmountDistribution.length - 1].binId}]`);
      return [{ ok: true }];
    },
    initializePositionAndAddLiquidityByWeight: async () => {
      calls.push('initializePositionAndAddLiquidityByWeight');
      return [{ bad: true }];
    },
  };

  const out = await executeQuoteOnlyPositionFirstFlow({
    dlmmPool,
    connection,
    walletPublicKey: Keypair.generate().publicKey,
    positionKeypair,
    deployArgs,
    xYAmountDistribution: dist,
    slippagePct: 2.5,
    finalArgsContext: {
      sdkPath: 'weight_quote_only',
      rangeMin: deployArgs.rangeMin,
      rangeMax: deployArgs.rangeMax,
    },
    sendTxFn: async () => {
      calls.push('sendInitTx');
      return 'sig-init';
    },
    pollTxConfirmFn: async () => {
      calls.push('confirmInitTx');
    },
  });

  assert.equal(out.quoteOnlyPositionFirst, true);
  assert.equal(calls.indexOf('createEmptyPosition') < calls.indexOf('addLiquidityByWeight'), true);
  assert.equal(calls.includes('initializePositionAndAddLiquidityByWeight'), false);
  assert.equal(calls.includes('range-[980,999]'), true);
  assert.equal(calls.includes('dist-[980,999]'), true);
  assert.doesNotThrow(
    () => assertNoCombinedWeightForQuoteOnly({
      deployArgs,
      sdkPath: 'weight_quote_only',
      sdkMethod: 'addLiquidityByWeight',
    })
  );
});

test('transaction signer filter keeps position signer when tx requires it', () => {
  const kp = Keypair.generate();
  const tx = {
    signatures: [
      { publicKey: kp.publicKey },
    ],
  };
  const filtered = filterKnownTransactionSigners(tx, [kp], { txStage: 'createPosition' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].publicKey.toString(), kp.publicKey.toString());
});

test('transaction signer filter drops position signer when tx does not require it', () => {
  const kp = Keypair.generate();
  const other = Keypair.generate();
  const tx = {
    signatures: [
      { publicKey: other.publicKey },
    ],
  };
  const filtered = filterKnownTransactionSigners(tx, [kp], { txStage: 'addLiquidity' });
  assert.equal(filtered.length, 0);
});

test('required signer extraction supports legacy transaction signatures array fallback', () => {
  const kp = Keypair.generate();
  const tx = {
    signatures: [
      { publicKey: kp.publicKey },
    ],
  };
  const keys = __extractRequiredSignerPubkeysForTests(tx);
  assert.equal(keys.includes(kp.publicKey.toString()), true);
});

test('quote-only position-first flow fails when post-init owner remains system-owned before add', async () => {
  const calls = [];
  const positionKeypair = Keypair.generate();
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const connection = {
    getAccountInfo: async () => {
      if (!calls.includes('createEmptyPosition')) return null;
      return { owner: new PublicKey('11111111111111111111111111111111') };
    },
  };
  const dlmmPool = {
    program: { programId: expectedProgramId },
    createEmptyPosition: async () => {
      calls.push('createEmptyPosition');
      return { instructions: [] };
    },
    addLiquidityByWeight: async () => {
      calls.push('addLiquidityByWeight');
      return [{ ok: true }];
    },
  };
  await assert.rejects(
    executeQuoteOnlyPositionFirstFlow({
      dlmmPool,
      connection,
      walletPublicKey: Keypair.generate().publicKey,
      positionKeypair,
      deployArgs: {
        rangeMin: 980,
        rangeMax: 999,
        amountXBn: new BN('0'),
        amountYBn: new BN('100'),
      },
      xYAmountDistribution: buildQuoteOnlyWeightDistribution({ rangeMin: 980, rangeMax: 999 }),
      sendTxFn: async () => 'sig-init',
      pollTxConfirmFn: async () => {},
    }),
    (err) => {
      assert.equal(err?.code, 'INVALID_DLMM_DEPLOY_ARGS');
      assert.match(String(err?.message || ''), /not owned by DLMM program/);
      return true;
    }
  );
  assert.equal(calls.includes('addLiquidityByWeight'), false);
});

test('quote-only position-first flow fails early when existing position owner mismatches', async () => {
  const positionKeypair = Keypair.generate();
  const wrongOwner = new PublicKey('11111111111111111111111111111111');
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  let addCalls = 0;
  const dlmmPool = {
    program: { programId: expectedProgramId },
    createEmptyPosition: async () => ({ instructions: [] }),
    addLiquidityByWeight: async () => {
      addCalls += 1;
      return [{ ok: true }];
    },
  };
  await assert.rejects(
    executeQuoteOnlyPositionFirstFlow({
      dlmmPool,
      connection: {
        getAccountInfo: async () => ({ owner: wrongOwner }),
      },
      walletPublicKey: Keypair.generate().publicKey,
      positionKeypair,
      deployArgs: {
        rangeMin: 980,
        rangeMax: 999,
        amountXBn: new BN('0'),
        amountYBn: new BN('1'),
      },
      xYAmountDistribution: buildQuoteOnlyWeightDistribution({ rangeMin: 980, rangeMax: 999 }),
    }),
    (err) => {
      assert.equal(err?.code, 'INVALID_DLMM_DEPLOY_ARGS');
      const msg = String(err?.message || '');
      assert.match(msg, /position account owner mismatch/);
      return true;
    }
  );
  assert.equal(addCalls, 0);
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

test('first SDK invalid args triggers activeBin refetch and deployArgs rebuild', async () => {
  let refetchCalls = 0;
  const initial = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 995,
    rangeMax: 1005,
    amountXBn: new BN('1'),
    amountYBn: new BN('0'),
  });

  const out = await prepareFinalDlmmDeployAttemptState({
    dlmmPool: {},
    poolAddress: 'Pool11111111111111111111111111111111111111',
    xMint: 'Mint111111111111111111111111111111111111111',
    yMint: 'So11111111111111111111111111111111111111112',
    deployArgs: initial,
    currentRentGuard: { ok: true, deployArgs: initial, guard: 'UNCHANGED_RANGE_PASS' },
    hasNonRefundableFees: false,
    checkedRangeMin: initial.rangeMin,
    checkedRangeMax: initial.rangeMax,
    initialActiveBinId: 1000,
    refetchStatesFn: async () => { refetchCalls += 1; },
    getActiveBinFn: async () => ({ binId: 1003 }),
  });

  assert.equal(out.ok, true);
  assert.equal(refetchCalls, 1);
  assert.equal(out.deployArgs.activeBinId, 1003);
  assert.equal(out.deployArgs.rangeMin, 1004);
  assert.equal(out.deployArgs.rangeMax, 1014);
});

test('retry SDK call uses refreshed deployArgs and re-runs preflight/rent guard', async () => {
  const calls = [];
  let ensureCalls = 0;
  let assertCalls = 0;
  const initial = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 995,
    rangeMax: 1005,
    amountXBn: new BN('1'),
    amountYBn: new BN('0'),
  });
  let activeBinCursor = 1003;

  const prepareState = async (attempt, baseDeployArgs, currentRentGuard) => prepareFinalDlmmDeployAttemptState({
    dlmmPool: {},
    connection: {},
    poolPubkey: {},
    poolAddress: 'Pool11111111111111111111111111111111111111',
    xMint: 'Mint111111111111111111111111111111111111111',
    yMint: 'So11111111111111111111111111111111111111112',
    deployArgs: baseDeployArgs,
    currentRentGuard,
    hasNonRefundableFees: true,
    rangeMaxBins: 100,
    checkedRangeMin: initial.rangeMin,
    checkedRangeMax: initial.rangeMax,
    initialActiveBinId: 1000,
    attempt,
    refetchStatesFn: async () => calls.push(`refetch-${attempt}`),
    getActiveBinFn: async () => ({ binId: activeBinCursor++ }),
    ensureFinalRentCheckedDeployArgsFn: async (args) => {
      ensureCalls += 1;
      calls.push(`rent-${attempt}-[${args.deployArgs.rangeMin},${args.deployArgs.rangeMax}]`);
      return { ok: true, deployArgs: args.deployArgs, guard: 'ASSERT_PASS', finalRangeChanged: true };
    },
    assertDlmmFinalSdkArgsFn: (args) => {
      assertCalls += 1;
      calls.push(`preflight-${attempt}-[${args.deployArgs.rangeMin},${args.deployArgs.rangeMax}]`);
      return {
        pool: args.poolAddress,
        tokenXMint: args.xMint,
        tokenYMint: args.yMint,
        activeBinId: args.deployArgs.activeBinId,
        refreshedActiveBinId: args.refreshedActiveBinId,
        rangeMin: args.deployArgs.rangeMin,
        rangeMax: args.deployArgs.rangeMax,
        rangeWidth: Number(args.deployArgs.rangeMax) - Number(args.deployArgs.rangeMin) + 1,
        amountXIsZero: args.deployArgs.amountXBn.isZero(),
        amountYIsZero: args.deployArgs.amountYBn.isZero(),
        strategyType: args.deployArgs.strategyType,
      };
    },
  });

  const first = await prepareState(1, initial, { ok: true, deployArgs: initial, guard: 'ASSERT_PASS' });
  assert.equal(first.ok, true);

  let sdkCalls = 0;
  const result = await executeDlmmInitializePositionWithRetry({
    initialState: first,
    buildRetryStateFn: async ({ previousState }) => prepareState(2, previousState.deployArgs, previousState.finalRentGuard),
    sdkCallFn: async (state) => {
      sdkCalls += 1;
      calls.push(`sdk-${sdkCalls}-[${state.deployArgs.rangeMin},${state.deployArgs.rangeMax}]`);
      if (sdkCalls === 1) {
        throw new Error('invalid arguments from sdk');
      }
      return [{ ok: true }];
    },
  });

  assert.equal(result.attempt, 2);
  assert.equal(sdkCalls, 2);
  assert.equal(assertCalls >= 2, true);
  assert.equal(ensureCalls >= 2, true);
  assert.equal(calls.some((line) => line.startsWith('preflight-2-')), true);
  assert.equal(calls.some((line) => line.startsWith('rent-2-')), true);
  assert.equal(calls.some((line) => line.startsWith('sdk-2-')), true);
});

test('retry success continues deploy flow', async () => {
  const initial = {
    deployArgs: buildDlmmDeployStrategyArgs({
      activeBinId: 1000,
      rangeMin: 980,
      rangeMax: 999,
      amountXBn: new BN('0'),
      amountYBn: new BN('100'),
    }),
    sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
    finalArgsContext: { pool: 'Pool111' },
  };
  let sdkCalls = 0;
  const result = await executeDlmmInitializePositionWithRetry({
    initialState: initial,
    buildRetryStateFn: async ({ previousState }) => ({
      ...previousState,
      deployArgs: {
        ...previousState.deployArgs,
        activeBinId: 1001,
      },
      finalArgsContext: { ...previousState.finalArgsContext, activeBinId: 1001 },
    }),
    sdkCallFn: async () => {
      sdkCalls += 1;
      if (sdkCalls === 1) throw new Error('invalid arguments from sdk');
      return ['tx2'];
    },
  });

  assert.equal(result.attempt, 2);
  assert.deepEqual(result.txOrTxs, ['tx2']);
});

test('quote-only retry uses refreshed range for rebuilt one-side distribution', async () => {
  const calls = [];
  const initial = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 995,
    rangeMax: 1000,
    amountXBn: new BN('0'),
    amountYBn: new BN('1000'),
  });
  const refreshedBins = [1002, 998];
  const prepare = async (attempt, baseDeployArgs, currentRentGuard) => prepareFinalDlmmDeployAttemptState({
    dlmmPool: {},
    connection: {},
    poolPubkey: {},
    poolAddress: 'Pool11111111111111111111111111111111111111',
    xMint: 'Mint111111111111111111111111111111111111111',
    yMint: 'So11111111111111111111111111111111111111112',
    deployArgs: baseDeployArgs,
    currentRentGuard,
    hasNonRefundableFees: true,
    rangeMaxBins: 100,
    checkedRangeMin: initial.rangeMin,
    checkedRangeMax: initial.rangeMax,
    initialActiveBinId: 1000,
    attempt,
    refetchStatesFn: async () => calls.push(`refetch-${attempt}`),
    getActiveBinFn: async () => ({ binId: refreshedBins.shift() }),
    ensureFinalRentCheckedDeployArgsFn: async (args) => {
      calls.push(`rent-${attempt}-[${args.deployArgs.rangeMin},${args.deployArgs.rangeMax}]`);
      return { ok: true, deployArgs: args.deployArgs, guard: 'ASSERT_PASS', finalRangeChanged: true };
    },
  });

  const first = await prepare(1, initial, { ok: true, deployArgs: initial, guard: 'ASSERT_PASS' });
  let sdkCalls = 0;
  const out = await executeDlmmInitializePositionWithRetry({
    initialState: first,
    buildRetryStateFn: async ({ previousState }) => prepare(2, previousState.deployArgs, previousState.finalRentGuard),
    sdkCallFn: async (state) => {
      sdkCalls += 1;
      const sdkPath = selectDlmmSdkPathForDeployArgs(state.deployArgs);
      assert.equal(sdkPath, 'weight_quote_only');
      const dist = buildQuoteOnlyWeightDistribution({
        rangeMin: Number(state.deployArgs.rangeMin),
        rangeMax: Number(state.deployArgs.rangeMax),
      });
      const firstBin = dist[0].binId;
      const lastBin = dist[dist.length - 1].binId;
      calls.push(`sdk-${sdkCalls}-range=[${state.deployArgs.rangeMin},${state.deployArgs.rangeMax}] dist=[${firstBin},${lastBin}]`);
      if (sdkCalls === 1) throw new Error('invalid arguments from sdk');
      return ['ok'];
    },
  });

  assert.equal(out.attempt, 2);
  assert.equal(sdkCalls, 2);
  assert.equal(calls.some((line) => line.startsWith('refetch-2')), true);
  assert.equal(calls.some((line) => line.startsWith('rent-2-')), true);
  const firstSdk = calls.find((line) => line.startsWith('sdk-1-'));
  const secondSdk = calls.find((line) => line.startsWith('sdk-2-'));
  assert.equal(Boolean(firstSdk), true);
  assert.equal(Boolean(secondSdk), true);
  assert.notEqual(firstSdk, secondSdk);
});

test('retry still invalid args throws wrapped error with final context and no blacklist side-effect marker', async () => {
  const initial = {
    deployArgs: buildDlmmDeployStrategyArgs({
      activeBinId: 1000,
      rangeMin: 980,
      rangeMax: 999,
      amountXBn: new BN('0'),
      amountYBn: new BN('100'),
    }),
    sdkStrategy: { minBinId: 980, maxBinId: 999, strategyType: 0 },
    finalArgsContext: {
      pool: 'Pool111',
      tokenXMint: 'Mint111',
      tokenYMint: 'So111',
      activeBinId: 1000,
      refreshedActiveBinId: 1001,
      rangeMin: 980,
      rangeMax: 999,
      rangeWidth: 20,
      amountXIsZero: true,
      amountYIsZero: false,
      strategyType: 0,
      sdkPath: 'weight_quote_only',
    },
  };

  await assert.rejects(
    executeDlmmInitializePositionWithRetry({
      initialState: initial,
      buildRetryStateFn: async ({ previousState }) => ({
        ...previousState,
        finalArgsContext: { ...previousState.finalArgsContext, refreshedActiveBinId: 1002 },
      }),
      sdkCallFn: async () => {
        throw new Error('invalid arguments from sdk');
      },
    }),
    (err) => {
      assert.equal(err?.code, 'INVALID_DLMM_DEPLOY_ARGS');
      const msg = String(err?.message || '');
      assert.match(msg, /context=\{/);
      assert.match(msg, /pool/);
      assert.match(msg, /activeBinId/);
      assert.match(msg, /retryAttempt/);
      assert.match(msg, /weight_quote_only/);
      assert.match(msg, /attempt\":2/);
      assert.equal(msg.includes('blacklist'), false);
      return true;
    }
  );
});

test('wrapper uses weight method name for quote-only sdkPath', () => {
  const wrapped = wrapDlmmSdkInvalidArgumentsError({
    error: new Error('invalid arguments'),
    finalArgsContext: {
      pool: 'Pool111',
      sdkPath: 'weight_quote_only',
    },
  });
  assert.equal(wrapped?.code, 'INVALID_DLMM_DEPLOY_ARGS');
  assert.match(String(wrapped?.message || ''), /initializePositionAndAddLiquidityByWeight/);
});

test('quote-only wrapped errors prefer sdkMethod from context extra (position-first)', () => {
  const err = new Error('custom program error: 0xbbf');
  err.dlmmContextExtra = {
    sdkMethod: 'addLiquidityByWeight',
    sdkFlow: 'quote_only_position_first',
    positionPubkey: 'Pos111111111111111111111111111111111111111',
  };
  const wrapped = wrapDlmmSdkInvalidArgumentsError({
    error: err,
    finalArgsContext: {
      sdkPath: 'weight_quote_only',
    },
  });
  assert.equal(wrapped?.code, 'INVALID_DLMM_DEPLOY_ARGS');
  const msg = String(wrapped?.message || '');
  assert.match(msg, /addLiquidityByWeight/);
  assert.match(msg, /quote_only_position_first/);
});

test('dlmm sdk error meta detects anchor 3007 / 0xbbf variants', () => {
  const errHex = new Error('Program failed: custom program error: 0xbbf');
  const metaHex = extractDlmmSdkDeployErrorMeta(errHex);
  assert.equal(metaHex.isDlmmSdkDeployError, true);
  assert.equal(metaHex.anchorErrorHex, '0xbbf');
  assert.equal(metaHex.anchorErrorCode, 3007);
  assert.equal(metaHex.anchorErrorName, 'AccountOwnedByWrongProgram');

  const errInstruction = new Error('{"InstructionError":[1,{"Custom":3007}]}');
  const metaInstruction = extractDlmmSdkDeployErrorMeta(errInstruction);
  assert.equal(metaInstruction.isDlmmSdkDeployError, true);
  assert.equal(metaInstruction.anchorErrorCode, 3007);
  assert.equal(metaInstruction.instructionIndex, 1);
  assert.equal(metaInstruction.anchorErrorHex, '0xbbf');

  const errName = new Error('AnchorError: AccountOwnedByWrongProgram');
  const metaName = extractDlmmSdkDeployErrorMeta(errName);
  assert.equal(metaName.isDlmmSdkDeployError, true);
  assert.equal(metaName.anchorErrorName, 'AccountOwnedByWrongProgram');
});

test('quote-only weight path anchor 3007 wraps with full sdk and anchor context', () => {
  const wrapped = wrapDlmmSdkInvalidArgumentsError({
    error: new Error('{"InstructionError":[1,{"Custom":3007}]} Program failed: custom program error: 0xbbf'),
    finalArgsContext: {
      pool: 'Pool111',
      tokenXMint: 'Mint111',
      tokenYMint: 'So111',
      activeBinId: -399,
      initialActiveBinId: -380,
      refreshedActiveBinId: -399,
      rangeMin: -467,
      rangeMax: -400,
      rangeWidth: 68,
      amountX: '0',
      amountY: '100000000',
      amountXIsZero: true,
      amountYIsZero: false,
      singleSide: 'QUOTE_ONLY',
      quoteSide: 'SOL',
      activeInsideRange: false,
      strategyType: 0,
      sdkPath: 'weight_quote_only',
      attempt: 2,
    },
  });

  assert.equal(wrapped?.code, 'INVALID_DLMM_DEPLOY_ARGS');
  const msg = String(wrapped?.message || '');
  assert.match(msg, /initializePositionAndAddLiquidityByWeight/);
  assert.match(msg, /weight_quote_only/);
  assert.match(msg, /"anchorErrorCode":3007/);
  assert.match(msg, /"anchorErrorHex":"0xbbf"/);
  assert.match(msg, /"anchorErrorName":"AccountOwnedByWrongProgram"/);
  assert.match(msg, /"instructionIndex":1/);
  assert.match(msg, /"rangeMin":-467/);
  assert.match(msg, /"rangeMax":-400/);
  assert.match(msg, /"amountX":"0"/);
  assert.match(msg, /"amountY":"100000000"/);
  assert.equal(msg.includes('Invalid arguments'), false);
});

test('retry still anchor 3007 throws wrapped queue-safe message (not bare invalid arguments)', async () => {
  const initial = {
    finalArgsContext: {
      pool: 'Pool111',
      tokenXMint: 'Mint111',
      tokenYMint: 'So111',
      rangeMin: -467,
      rangeMax: -400,
      sdkPath: 'weight_quote_only',
    },
  };

  await assert.rejects(
    executeDlmmInitializePositionWithRetry({
      initialState: initial,
      buildRetryStateFn: async ({ previousState }) => ({
        ...previousState,
        finalArgsContext: { ...previousState.finalArgsContext, attempt: 2 },
      }),
      sdkCallFn: async () => {
        throw new Error('Program failed: custom program error: 0xbbf {"InstructionError":[1,{"Custom":3007}]}');
      },
    }),
    (err) => {
      assert.equal(err?.code, 'INVALID_DLMM_DEPLOY_ARGS');
      const msg = String(err?.message || '');
      assert.match(msg, /initializePositionAndAddLiquidityByWeight/);
      assert.match(msg, /"anchorErrorCode":3007/);
      assert.match(msg, /"anchorErrorHex":"0xbbf"/);
      assert.match(msg, /"retryAttempt":1/);
      assert.equal(msg.includes('context={'), true);
      return true;
    }
  );
});

test('retry on account-owned-wrong-program can switch to fresh position keypair and wraps retry context', async () => {
  const kp1 = Keypair.generate();
  const kp2 = Keypair.generate();
  const seen = [];
  await assert.rejects(
    executeDlmmInitializePositionWithRetry({
      initialState: {
        positionKeypair: kp1,
        finalArgsContext: {
          sdkPath: 'weight_quote_only',
          sdkFlow: 'quote_only_position_first',
          positionPubkey: kp1.publicKey.toString(),
        },
      },
      buildRetryStateFn: async () => ({
        positionKeypair: kp2,
        finalArgsContext: {
          sdkPath: 'weight_quote_only',
          sdkFlow: 'quote_only_position_first',
          positionPubkey: kp2.publicKey.toString(),
        },
      }),
      sdkCallFn: async (state) => {
        seen.push(state?.positionKeypair?.publicKey?.toString());
        const err = new Error('Instruction: AddLiquidityOneSide AccountOwnedByWrongProgram {"InstructionError":[1,{"Custom":3007}]} custom program error: 0xbbf');
        err.dlmmContextExtra = {
          positionPubkey: state?.positionKeypair?.publicKey?.toString(),
          positionOwner: '11111111111111111111111111111111',
          expectedPositionOwner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
          sdkFlow: 'quote_only_position_first',
        };
        throw err;
      },
    }),
    (err) => {
      assert.equal(err?.code, 'INVALID_DLMM_DEPLOY_ARGS');
      const msg = String(err?.message || '');
      assert.match(msg, /AccountOwnedByWrongProgram/);
      assert.match(msg, /quote_only_position_first/);
      assert.match(msg, new RegExp(kp2.publicKey.toString()));
      assert.equal(msg.includes('Invalid arguments'), false);
      return true;
    }
  );
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

test('non-invalid-arguments error is not retried', async () => {
  let sdkCalls = 0;
  await assert.rejects(
    executeDlmmInitializePositionWithRetry({
      initialState: {
        deployArgs: buildDlmmDeployStrategyArgs({
          activeBinId: 1000,
          rangeMin: 980,
          rangeMax: 999,
          amountXBn: new BN('0'),
          amountYBn: new BN('100'),
        }),
      },
      buildRetryStateFn: async () => {
        throw new Error('should-not-be-called');
      },
      sdkCallFn: async () => {
        sdkCalls += 1;
        throw new Error('rpc timeout');
      },
    }),
    /rpc timeout/
  );
  assert.equal(sdkCalls, 1);
});

test('invalid arguments detector marks SDK invalid arguments only', () => {
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('invalid arguments from sdk')), true);
  assert.equal(isDlmmSdkInvalidArgumentsError({ code: 'INVALID_DLMM_DEPLOY_ARGS', message: 'x' }), true);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('Program failed: custom program error: 0xbbf')), true);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('{"InstructionError":[1,{"Custom":3007}]}')), true);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('AccountOwnedByWrongProgram')), true);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('rpc timeout')), false);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('429 rate limit exceeded')), false);
  assert.equal(isDlmmSdkInvalidArgumentsError(new Error('LLM timeout')), false);
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

test('quote-only position-first build keeps marker in ADD_LIQUIDITY_PENDING (not confirmed yet)', async () => {
  const positionKeypair = Keypair.generate();
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100000000'),
  });
  const dist = buildQuoteOnlyWeightDistribution({ rangeMin: 980, rangeMax: 999 });
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const calls = [];

  const connection = {
    getAccountInfo: async () => {
      if (!calls.includes('createEmptyPosition')) return null;
      return { owner: expectedProgramId };
    },
  };
  const dlmmPool = {
    program: { programId: expectedProgramId },
    createEmptyPosition: async () => {
      calls.push('createEmptyPosition');
      return { instructions: [] };
    },
    addLiquidityByWeight: async () => {
      calls.push('addLiquidityByWeight');
      return [{ ok: true }];
    },
  };

  const out = await executeQuoteOnlyPositionFirstFlow({
    dlmmPool,
    connection,
    walletPublicKey: Keypair.generate().publicKey,
    positionKeypair,
    deployArgs,
    xYAmountDistribution: dist,
    finalArgsContext: {
      pool: 'Pool11111111111111111111111111111111111111',
      tokenXMint: 'Mint111111111111111111111111111111111111111',
    },
    sendTxFn: async () => 'sig-init',
    pollTxConfirmFn: async () => {},
  });

  assert.equal(out.quoteOnlyPositionFirst, true);
  const marker = __getQuoteOnlyDeployMarkerForTests(positionKeypair.publicKey.toString());
  assert.equal(marker?.phase, 'ADD_LIQUIDITY_PENDING');
  assert.equal(marker?.liquidityConfirmed, false);

  __setQuoteOnlyDeployMarkerForTests(positionKeypair.publicKey.toString(), null);
});

test('quote-only add-liquidity failure marks partial deploy marker phase', async () => {
  const positionKeypair = Keypair.generate();
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100000000'),
  });
  const dist = buildQuoteOnlyWeightDistribution({ rangeMin: 980, rangeMax: 999 });
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  let initDone = false;

  await assert.rejects(
    executeQuoteOnlyPositionFirstFlow({
      dlmmPool: {
        program: { programId: expectedProgramId },
        createEmptyPosition: async () => {
          initDone = true;
          return { instructions: [] };
        },
        addLiquidityByWeight: async () => {
          throw new Error('add-liquidity failed');
        },
      },
      connection: {
        getAccountInfo: async () => {
          if (!initDone) return null;
          return { owner: expectedProgramId };
        },
      },
      walletPublicKey: Keypair.generate().publicKey,
      positionKeypair,
      deployArgs,
      xYAmountDistribution: dist,
      finalArgsContext: {
        pool: 'Pool11111111111111111111111111111111111111',
        tokenXMint: 'Mint111111111111111111111111111111111111111',
      },
      sendTxFn: async () => 'sig-init',
      pollTxConfirmFn: async () => {},
    })
  );

  const marker = __getQuoteOnlyDeployMarkerForTests(positionKeypair.publicKey.toString());
  assert.equal(marker?.phase, 'ADD_LIQUIDITY_FAILED');
  assert.equal(marker?.source, 'BOT_QUOTE_ONLY_POSITION_FIRST');
  assert.equal(__isBotQuoteOnlyPartialMarkerForTests(marker), true);

  __setQuoteOnlyDeployMarkerForTests(positionKeypair.publicKey.toString(), null);
});

test('partial quote-only cleanup unlocks local state for empty position and avoids manual classification', async () => {
  const positionKeypair = Keypair.generate();
  const positionPubkey = positionKeypair.publicKey.toString();
  const poolAddress = 'Pool11111111111111111111111111111111111111';

  await setPositionLifecycle(positionPubkey, 'deploying', {
    poolAddress,
    deploySol: 0.1,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    tokenYMint: 'So11111111111111111111111111111111111111112',
    rangeMin: 980,
    rangeMax: 999,
  }, { flush: true });
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, {
    poolAddress,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    phase: 'ADD_LIQUIDITY_FAILED',
    source: 'BOT_QUOTE_ONLY_POSITION_FIRST',
    ttlMs: 120000,
  });

  const connection = {};
  const wallet = { publicKey: Keypair.generate().publicKey };
  const dlmmPool = {};

  const cleanup = await __handleQuoteOnlyPartialDeployFailureForTests({
    connection,
    wallet,
    dlmmPool,
    poolAddress,
    positionPubkey,
    error: new Error('add failed'),
    getFreshPositionFn: async () => ({
      activePos: null,
    }),
    verifyClosedFn: async () => true,
  });

  assert.equal(cleanup?.hasLiquidity, false);
  assert.equal(getPositionMeta(positionPubkey), null);
  const marker = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  assert.equal(marker?.phase, 'ADD_LIQUIDITY_FAILED');
  assert.equal(marker?.cleanupStatus, 'POSITION_NOT_FOUND');
  assert.equal(getPositionMeta(positionPubkey), null);
  const status = await getPositionOnChainStatus(positionPubkey);
  assert.equal(status.reason, 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION');
  assert.equal(status.manualWithdrawn, false);

  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('quote-only send fail path keeps marker partial, cleanup unlocks lock, and avoids manual classification', async () => {
  const positionKeypair = Keypair.generate();
  const positionPubkey = positionKeypair.publicKey.toString();
  const poolAddress = 'Pool11111111111111111111111111111111111111';
  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: 1000,
    rangeMin: 980,
    rangeMax: 999,
    amountXBn: new BN('0'),
    amountYBn: new BN('100000000'),
  });
  const dist = buildQuoteOnlyWeightDistribution({ rangeMin: 980, rangeMax: 999 });
  const expectedProgramId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  let initDone = false;

  const built = await executeQuoteOnlyPositionFirstFlow({
    dlmmPool: {
      program: { programId: expectedProgramId },
      createEmptyPosition: async () => {
        initDone = true;
        return { instructions: [] };
      },
      addLiquidityByWeight: async () => [{ mockTx: true }],
    },
    connection: {
      getAccountInfo: async () => {
        if (!initDone) return null;
        return { owner: expectedProgramId };
      },
    },
    walletPublicKey: Keypair.generate().publicKey,
    positionKeypair,
    deployArgs,
    xYAmountDistribution: dist,
    finalArgsContext: {
      pool: poolAddress,
      tokenXMint: 'Mint111111111111111111111111111111111111111',
    },
    sendTxFn: async () => 'sig-init',
    pollTxConfirmFn: async () => {},
  });
  assert.equal(built.quoteOnlyPositionFirst, true);
  const markerBefore = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  assert.equal(markerBefore?.phase, 'ADD_LIQUIDITY_PENDING');
  assert.equal(markerBefore?.liquidityConfirmed, false);

  await setPositionLifecycle(positionPubkey, 'deploying', {
    poolAddress,
    deploySol: 0.1,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    tokenYMint: 'So11111111111111111111111111111111111111112',
    rangeMin: 980,
    rangeMax: 999,
  }, { flush: true });

  const cleanup = await __handleQuoteOnlyPartialDeployFailureForTests({
    connection: {},
    wallet: { publicKey: Keypair.generate().publicKey },
    dlmmPool: {},
    poolAddress,
    positionPubkey,
    error: new Error('send add-liquidity tx failed'),
    getFreshPositionFn: async () => ({ activePos: null }),
    verifyClosedFn: async () => true,
  });

  assert.equal(cleanup?.hasLiquidity, false);
  assert.equal(getPositionMeta(positionPubkey), null);
  const markerAfter = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  assert.equal(markerAfter?.phase, 'ADD_LIQUIDITY_FAILED');
  assert.equal(markerAfter?.liquidityConfirmed, false);
  const status = await getPositionOnChainStatus(positionPubkey);
  assert.equal(status.reason, 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION');
  assert.equal(status.manualWithdrawn, false);

  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('quote-only liquidity marker becomes confirmed only after explicit on-chain liquidity verification', async () => {
  const positionPubkey = Keypair.generate().publicKey.toString();
  const poolAddress = 'Pool11111111111111111111111111111111111111';
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, {
    poolAddress,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    phase: 'ADD_LIQUIDITY_PENDING',
    source: 'BOT_QUOTE_ONLY_POSITION_FIRST',
    ttlMs: 120000,
  });

  const verifyEmpty = await __verifyQuoteOnlyLiquidityOnChainForTests({
    connection: {},
    wallet: { publicKey: Keypair.generate().publicKey },
    poolAddress,
    positionPubkey,
    attempts: 1,
    delayMs: 0,
    getFreshPositionFn: async () => ({
      activePos: {
        positionData: {
          totalXAmount: new BN('0'),
          totalYAmount: new BN('0'),
          feeX: new BN('0'),
          feeY: new BN('0'),
        },
      },
    }),
  });
  assert.equal(verifyEmpty.confirmed, false);
  let marker = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  assert.equal(marker?.phase, 'ADD_LIQUIDITY_PENDING');
  assert.equal(marker?.liquidityConfirmed, false);

  const verifyNonZero = await __verifyQuoteOnlyLiquidityOnChainForTests({
    connection: {},
    wallet: { publicKey: Keypair.generate().publicKey },
    poolAddress,
    positionPubkey,
    attempts: 1,
    delayMs: 0,
    getFreshPositionFn: async () => ({
      activePos: {
        positionData: {
          totalXAmount: new BN('0'),
          totalYAmount: new BN('100'),
          feeX: new BN('0'),
          feeY: new BN('0'),
        },
      },
    }),
  });
  assert.equal(verifyNonZero.confirmed, true);

  __markQuoteOnlyLiquidityConfirmedForTests({
    positionPubkey,
    poolAddress,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
  });
  marker = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  assert.equal(marker?.phase, 'ADD_LIQUIDITY_CONFIRMED');
  assert.equal(marker?.liquidityConfirmed, true);

  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('seed swap payload uses JSON.stringify (no bare stringify call)', () => {
  const src = readFileSync(new URL('../src/sniper/evilPanda.js', import.meta.url), 'utf8');
  assert.equal(src.includes('body: stringify({'), false);
  assert.equal(src.includes('body: JSON.stringify({'), true);
});

test('default seed plan is disabled and keeps full SOL single-side for 0.5 SOL', () => {
  const plan = __deriveSpotBidAskSeedPlanForTests({
    cfg: {},
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    totalLamports: 500_000_000,
  });
  assert.equal(plan.spotBidAskSeedEnabled, false);
  assert.equal(plan.rangeIncludesActiveBin, true);
  assert.equal(plan.shouldSeedTokenX, false);
  assert.equal(plan.seedLamports, 0);

  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    amountXBn: new BN('0'),
    amountYBn: new BN('500000000'),
  });
  assert.equal(deployArgs.amountXBn.toString(), '0');
  assert.equal(deployArgs.amountYBn.toString(), '500000000');
  assert.equal(deployArgs.singleSide, 'QUOTE_ONLY');
  assert.equal(deployArgs.strategyType, Number(StrategyType?.Spot ?? 0));
  assert.equal(selectDlmmSdkPathForDeployArgs(deployArgs), 'weight_quote_only');
});

test('dry-run default seed disabled does not produce seed plan branch signals', () => {
  const plan = __deriveSpotBidAskSeedPlanForTests({
    cfg: { dryRun: true },
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    totalLamports: 500_000_000,
  });
  assert.equal(plan.shouldSeedTokenX, false);
  assert.equal(plan.seedLamports, 0);
});

test('regression guard: default seed disabled does not create mixed 0.45/0.05 split for 0.5 SOL', () => {
  const plan = __deriveSpotBidAskSeedPlanForTests({
    cfg: {},
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    totalLamports: 500_000_000,
  });
  assert.equal(plan.shouldSeedTokenX, false);
  assert.notEqual(plan.seedLamports, 50_000_000);

  const deployArgs = buildDlmmDeployStrategyArgs({
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    amountXBn: new BN('0'),
    amountYBn: new BN('500000000'),
  });
  assert.notEqual(deployArgs.amountYBn.toString(), '450000000');
  assert.equal(deployArgs.singleSide, 'QUOTE_ONLY');
});

test('explicit seed opt-in with swap failure fallback remains full SOL single-side', () => {
  const plan = __deriveSpotBidAskSeedPlanForTests({
    cfg: {
      spotBidAskSeedEnabled: true,
      deployTokenXSeedPct: 10,
    },
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    totalLamports: 500_000_000,
  });
  assert.equal(plan.shouldSeedTokenX, true);
  assert.equal(plan.seedLamports, 50_000_000);

  const fallbackArgs = buildDlmmDeployStrategyArgs({
    activeBinId: -426,
    rangeMin: -475,
    rangeMax: -426,
    amountXBn: new BN('0'),
    amountYBn: new BN('500000000'),
    strategyType: Number(StrategyType?.Spot ?? 0),
  });
  assert.equal(fallbackArgs.amountXBn.toString(), '0');
  assert.equal(fallbackArgs.amountYBn.toString(), '500000000');
  assert.equal(fallbackArgs.singleSide, 'QUOTE_ONLY');
  assert.equal(fallbackArgs.strategyType, Number(StrategyType?.Spot ?? 0));
});

test('tx guard detects initializeBinArray instruction discriminator', () => {
  const tx = {
    instructions: [
      {
        programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
        data: Buffer.from([35, 86, 19, 185, 78, 212, 75, 211, 0]),
      },
    ],
  };
  const out = __inspectTxForBinArrayInitForTests(tx);
  assert.equal(out.hasInitBinArray, true);
  assert.equal(out.hasInitBitmap, false);
});

test('tx guard detects initializeBinArrayBitmapExtension instruction discriminator', () => {
  const tx = {
    instructions: [
      {
        programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
        data: Buffer.from([47, 157, 226, 180, 12, 240, 33, 71, 0]),
      },
    ],
  };
  const out = __inspectTxForBinArrayInitForTests(tx);
  assert.equal(out.hasInitBinArray, false);
  assert.equal(out.hasInitBitmap, true);
});

test('missing bin-array preflight is diagnostic only', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async () => [null, null],
      getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -467, rangeMax: -400 },
    sdkPath: 'strategy',
    txs: [{ instructions: [] }],
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'DIAG_ONLY');
  assert.equal(out.reason, 'TX_CLEAN_PREFLIGHT_ONLY');
  assert.equal(out.hasMissingBinArray, true);
});

test('missing bitmap preflight is diagnostic only', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async () => [1, 1, 1],
      getAccountInfo: async () => null,
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -50000, rangeMax: -49900 },
    sdkPath: 'strategy',
    txs: [{ instructions: [] }],
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'DIAG_ONLY');
  assert.equal(out.reason, 'TX_CLEAN_PREFLIGHT_ONLY');
  assert.equal(out.hasInitBitmap, true);
});

test('generated tx with initializeBinArray vetoes before send', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  await assert.rejects(
    __guardDlmmCostBeforeSendForTests({
      connection: {
        getMultipleAccountsInfo: async () => [1, 1],
        getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
      },
      poolPubkey,
      poolAddress: poolPubkey.toString(),
      dlmmPool: {
        program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
      },
      deployArgs: { rangeMin: -467, rangeMax: -400 },
      sdkPath: 'strategy',
      txs: [{
        instructions: [{
          programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
          data: Buffer.from([35, 86, 19, 185, 78, 212, 75, 211, 9]),
        }],
      }],
      finalArgsContext: { sdkPath: 'strategy' },
    }),
    (err) => {
      assert.equal(err?.code, 'VETO_BIN_ARRAY_RENT_REQUIRED');
      assert.equal(String(err?.message || '').includes('preflightMissingCount'), true);
      return true;
    }
  );
});

test('generated tx with initializeBinArrayBitmapExtension vetoes before send', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  await assert.rejects(
    __guardDlmmCostBeforeSendForTests({
      connection: {
        getMultipleAccountsInfo: async () => [1, 1],
        getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
      },
      poolPubkey,
      poolAddress: poolPubkey.toString(),
      dlmmPool: {
        program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
      },
      deployArgs: { rangeMin: -467, rangeMax: -400 },
      sdkPath: 'strategy',
      txs: [{
        instructions: [{
          programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
          data: Buffer.from([47, 157, 226, 180, 12, 240, 33, 71, 9]),
        }],
      }],
      finalArgsContext: { sdkPath: 'strategy' },
    }),
    (err) => {
      assert.equal(err?.code, 'VETO_BIN_ARRAY_BITMAP_RENT_REQUIRED');
      return true;
    }
  );
});

test('quote-only partial cleanup/unlock is triggered when cost guard vetoes after init', async () => {
  const positionPubkey = Keypair.generate().publicKey.toString();
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, {
    poolAddress: poolPubkey.toString(),
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    phase: 'ADD_LIQUIDITY_FAILED',
    source: 'BOT_QUOTE_ONLY_POSITION_FIRST',
    ttlMs: 120000,
  });
  await setPositionLifecycle(positionPubkey, 'deploying', {
    poolAddress: poolPubkey.toString(),
    deploySol: 0.1,
    tokenXMint: 'Mint111111111111111111111111111111111111111',
    tokenYMint: 'So11111111111111111111111111111111111111112',
    rangeMin: -467,
    rangeMax: -400,
  }, { flush: true });

  await assert.rejects(
    __guardDlmmCostBeforeSendForTests({
      connection: {
        getMultipleAccountsInfo: async () => [1, 1],
        getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
      },
      poolPubkey,
      poolAddress: poolPubkey.toString(),
      dlmmPool: {
        program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
      },
      deployArgs: { rangeMin: -467, rangeMax: -400 },
      sdkPath: 'weight_quote_only',
      txs: [{
        instructions: [{
          programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
          data: Buffer.from([35, 86, 19, 185, 78, 212, 75, 211, 9]),
        }],
      }],
      positionPubkey,
      finalArgsContext: { sdkPath: 'weight_quote_only', positionPubkey },
      cleanupFn: async () => {},
    }),
  );
  await __handleQuoteOnlyPartialDeployFailureForTests({
    connection: {},
    wallet: { publicKey: Keypair.generate().publicKey },
    dlmmPool: {},
    poolAddress: poolPubkey.toString(),
    positionPubkey,
    error: new Error('guard veto'),
    getFreshPositionFn: async () => ({ activePos: null }),
    verifyClosedFn: async () => true,
  });
  assert.equal(getPositionMeta(positionPubkey), null);
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('normal tx without init bin-array/bitmap is allowed', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async () => [1, 1],
      getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -467, rangeMax: -400 },
    sdkPath: 'strategy',
    txs: [{ instructions: [] }],
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'ALLOW');
});

test('clean generated tx is allowed even when preflight says bin-array missing', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async () => [null, null],
      getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -467, rangeMax: -400 },
    sdkPath: 'strategy',
    txs: [{ instructions: [] }],
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'DIAG_ONLY');
  assert.equal(out.reason, 'TX_CLEAN_PREFLIGHT_ONLY');
});

test('high tx count alone does not veto', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const txs = Array.from({ length: 12 }, () => ({ instructions: [] }));
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async () => [1, 1],
      getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -467, rangeMax: -400 },
    sdkPath: 'strategy',
    txs,
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'ALLOW');
  assert.equal(out.instructionCount, 0);
});

test('high bin count alone does not veto when arrays exist and no init instructions', async () => {
  const poolPubkey = new PublicKey('Cbj8TZQdBwEWVgjLc7p2Xqx2D4CpekiPxPTB1qLS3SdT');
  const out = await __guardDlmmCostBeforeSendForTests({
    connection: {
      getMultipleAccountsInfo: async (keys) => keys.map(() => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') })),
      getAccountInfo: async () => ({ owner: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') }),
    },
    poolPubkey,
    poolAddress: poolPubkey.toString(),
    dlmmPool: {
      program: { programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') },
    },
    deployArgs: { rangeMin: -10000, rangeMax: -9900 },
    sdkPath: 'strategy',
    txs: [{ instructions: [] }],
    finalArgsContext: { sdkPath: 'strategy' },
  });
  assert.equal(out.action, 'ALLOW');
});

test('final exit accounting excludes rent refunds from realized trading pnl', () => {
  const out = computeFinalExitAccounting({
    deploySol: 0.5,
    positionValueSol: 0.4498,
    walletNetDeltaSol: 0.5526,
    txFeesSol: 0.0002,
  });

  assert.equal(Number(out.positionValueSol.toFixed(4)), 0.4498);
  assert.equal(Number(out.walletNetDeltaSol.toFixed(4)), 0.5526);
  assert.equal(Number(out.realizedTradingPnlSol.toFixed(4)), -0.0502);
  assert.equal(Number(out.realizedTradingPnlPct.toFixed(2)), -10.04);
  assert.ok(out.rentRefundSol > 0.1);
  assert.equal(out.accountingStatus, 'estimated_rent_refund_from_wallet_delta');
});

test('final exit accounting uses position value as capital-out basis, not wallet delta', () => {
  const out = computeFinalExitAccounting({
    deploySol: 0.5,
    positionValueSol: 0.5,
    walletNetDeltaSol: 0.56,
    txFeesSol: 0.00015,
  });

  assert.equal(out.positionValueSol, 0.5);
  assert.equal(out.realizedTradingPnlSol, 0);
  assert.equal(out.realizedTradingPnlPct, 0);
  assert.notEqual(out.walletNetDeltaSol, out.positionValueSol);
});

test('unexpected wallet->unknown SOL transfer is vetoed before send', () => {
  const wallet = Keypair.generate().publicKey;
  const unknown = Keypair.generate().publicKey;
  const tx = {
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: unknown,
        lamports: 150_000,
      }),
    ],
  };
  assert.throws(
    () => __assertNoUnexpectedSolTransferInTxForTests({
      tx,
      walletPublicKey: wallet,
      txStage: 'unit-test',
    }),
    /VETO_UNEXPECTED_SOL_TRANSFER/
  );
});

test('normal tx without unexpected transfer is allowed by transfer guard', () => {
  const wallet = Keypair.generate().publicKey;
  const tx = {
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: wallet,
        lamports: 150_000,
      }),
    ],
  };
  assert.doesNotThrow(() => __assertNoUnexpectedSolTransferInTxForTests({
    tx,
    walletPublicKey: wallet,
    txStage: 'unit-test',
  }));
});
