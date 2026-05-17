import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

function makeIsolatedEnv(prefix = 'dlmm-pattern-learning-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  process.env.BOT_POOL_PATTERN_LEARNING_PATH = join(dataDir, 'pool-pattern-learning.jsonl');
  return { root, logPath: process.env.BOT_POOL_PATTERN_LEARNING_PATH };
}

function baseFeatures(overrides = {}) {
  return {
    tokenMint: 'MintPattern111111111111111111111111111111111',
    poolAddress: 'PoolPattern111111111111111111111111111111111',
    symbol: 'PATTERN',
    binStep: 100,
    tvl: 250000,
    volume24h: 500000,
    volumeTvlRatio: 2,
    mcap: 1200000,
    holderCount: 650,
    supertrend15m: 'BULLISH',
    feeActiveTvlRatio: 0.002,
    rangeWidthBins: 48,
    entryActiveBin: 123,
    entryReason: 'LP_LIVE',
    ...overrides,
  };
}

test('pool pattern learning builds fingerprint safely and evaluates disabled mode as zero', async () => {
  makeIsolatedEnv();
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));

  assert.equal(typeof mod.applyPoolPatternLearningToScore, 'function');
  assert.equal(typeof mod.applyPoolPatternLearningToCandidates, 'function');

  const full = mod.buildPoolPatternFingerprint(baseFeatures());
  assert.match(full.fingerprint, /^BIN_100\|/);
  assert.equal(full.buckets.trendBucket, 'BULLISH');

  const sparse = mod.buildPoolPatternFingerprint({});
  assert.match(sparse.fingerprint, /UNKNOWN/);

  const disabled = mod.evaluatePoolPatternLearning(baseFeatures(), {
    poolPatternLearningEnabled: false,
    poolPatternLearningShadowMode: true,
    poolPatternLearningMinSamples: 2,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.delta, 0);
  assert.equal(disabled.appliedDelta, 0);
});

test('pool pattern learning score wrapper keeps disabled shadow and active modes bounded', async () => {
  makeIsolatedEnv('dlmm-pattern-learning-wrapper-');
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const candidate = baseFeatures();

  const disabled = mod.applyPoolPatternLearningToScore({
    baseScore: 74,
    candidate,
    config: {
      poolPatternLearningEnabled: false,
      poolPatternLearningShadowMode: true,
      poolPatternLearningMinSamples: 2,
      poolPatternLearningMaxScoreDelta: 8,
      poolPatternLearningLookbackDays: 14,
    },
  });
  assert.equal(disabled.mode, 'disabled');
  assert.equal(disabled.score, 74);
  assert.equal(disabled.shadowScore, 74);

  const cfgShadow = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: true,
    poolPatternLearningMinSamples: 2,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosWrap1',
    features: candidate,
    outcome: { feePnlPct: 1.2, feePnlSol: 0.001, totalPnlPct: 4, pnlSol: 0.02, exitReason: 'TAKE_PROFIT' },
    cfg: cfgShadow,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosWrap2',
    features: candidate,
    outcome: { feePnlPct: 0.8, feePnlSol: 0.0008, totalPnlPct: 2, pnlSol: 0.01, exitReason: 'TAKE_PROFIT' },
    cfg: cfgShadow,
  });
  const shadow = mod.applyPoolPatternLearningToScore({
    baseScore: 74,
    candidate,
    config: cfgShadow,
  });
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.score, 74);
  assert.ok(shadow.shadowScore >= 74);
  assert.equal(shadow.appliedDelta, 0);

  const cfgActive = { ...cfgShadow, poolPatternLearningShadowMode: false, poolPatternLearningMaxScoreDelta: 1 };
  const active = mod.applyPoolPatternLearningToScore({
    baseScore: 74,
    candidate,
    config: cfgActive,
  });
  assert.equal(active.mode, 'active');
  assert.ok(active.score >= 74);
  assert.ok(active.score <= 75);
  assert.equal(active.score, 74 + active.appliedDelta);

  const sparse = mod.applyPoolPatternLearningToScore({
    baseScore: 74,
    candidate: { tokenMint: 'MintSparse', poolAddress: '', symbol: '' },
    config: cfgActive,
  });
  assert.doesNotThrow(() => sparse);
  assert.equal(Number.isFinite(sparse.score), true);
});

test('candidate ordering wrapper preserves disabled/shadow and reorders only in active mode', async () => {
  makeIsolatedEnv('dlmm-pattern-learning-order-');
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const positive = baseFeatures({ symbol: 'POS', tokenMint: 'MintPos111', binStep: 100, supertrend15m: 'BULLISH' });
  const negative = baseFeatures({ symbol: 'NEG', tokenMint: 'MintNeg111', binStep: 125, supertrend15m: 'BEARISH' });
  const sparse = { symbol: 'SPARSE', tokenMint: 'MintSparseOrder111', poolAddress: '' };

  const disabled = mod.applyPoolPatternLearningToCandidates(
    [
      { item: negative, baseScore: 50, candidate: { features: negative, symbol: negative.symbol, tokenMint: negative.tokenMint } },
      { item: positive, baseScore: 50, candidate: { features: positive, symbol: positive.symbol, tokenMint: positive.tokenMint } },
    ],
    {
      poolPatternLearningEnabled: false,
      poolPatternLearningShadowMode: true,
      poolPatternLearningMinSamples: 2,
      poolPatternLearningMaxScoreDelta: 8,
      poolPatternLearningLookbackDays: 14,
    }
  );
  assert.equal(disabled.mode, 'disabled');
  assert.equal(disabled.candidates[0].symbol, 'NEG');
  assert.equal(disabled.candidates[1].symbol, 'POS');

  const cfgShadow = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: true,
    poolPatternLearningMinSamples: 2,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosOrder1',
    features: positive,
    outcome: { feePnlPct: 1.5, totalPnlPct: 6, pnlSol: 0.02, exitReason: 'TAKE_PROFIT' },
    cfg: cfgShadow,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosOrder2',
    features: positive,
    outcome: { feePnlPct: 1.1, totalPnlPct: 4, pnlSol: 0.01, exitReason: 'TAKE_PROFIT' },
    cfg: cfgShadow,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'NegOrder1',
    features: negative,
    outcome: { feePnlPct: 0.2, totalPnlPct: -14, pnlSol: -0.03, exitReason: 'STOP_LOSS' },
    cfg: cfgShadow,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'NegOrder2',
    features: negative,
    outcome: { feePnlPct: 0.1, totalPnlPct: -10, pnlSol: -0.02, exitReason: 'POOL_IMPACT_GUARD' },
    cfg: cfgShadow,
  });

  const shadow = mod.applyPoolPatternLearningToCandidates(
    [
      { item: negative, baseScore: 50, candidate: { features: negative, symbol: negative.symbol, tokenMint: negative.tokenMint } },
      { item: positive, baseScore: 50, candidate: { features: positive, symbol: positive.symbol, tokenMint: positive.tokenMint } },
    ],
    cfgShadow
  );
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.candidates[0].symbol, 'NEG');
  assert.equal(shadow.candidates[1].symbol, 'POS');
  assert.equal(shadow.diagnostics.length, 2);

  const active = mod.applyPoolPatternLearningToCandidates(
    [
      { item: negative, baseScore: 50, candidate: { features: negative, symbol: negative.symbol, tokenMint: negative.tokenMint } },
      { item: positive, baseScore: 50, candidate: { features: positive, symbol: positive.symbol, tokenMint: positive.tokenMint } },
      { item: sparse, baseScore: 50, candidate: sparse },
    ],
    { ...cfgShadow, poolPatternLearningShadowMode: false, poolPatternLearningMaxScoreDelta: 1 }
  );
  assert.equal(active.mode, 'active');
  assert.equal(active.candidates.length, 3);
  assert.equal(active.candidates[0].symbol, 'POS');
  assert.equal(active.candidates.some((c) => c.symbol === 'NEG'), true);
  assert.equal(active.candidates.some((c) => c.symbol === 'SPARSE'), true);

  const belowMin = mod.applyPoolPatternLearningToCandidates(
    [
      { item: negative, baseScore: 50, candidate: { features: negative, symbol: negative.symbol, tokenMint: negative.tokenMint } },
      { item: positive, baseScore: 49, candidate: { features: positive, symbol: positive.symbol, tokenMint: positive.tokenMint } },
    ],
    { ...cfgShadow, poolPatternLearningShadowMode: false, poolPatternLearningMinSamples: 99 }
  );
  assert.equal(belowMin.candidates[0].symbol, 'NEG');
  assert.equal(belowMin.candidates[1].symbol, 'POS');
});

test('entry and outcome logging do not throw with sparse optional fields', async () => {
  const { logPath } = makeIsolatedEnv('dlmm-pattern-learning-sparse-');
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const cfg = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: true,
    poolPatternLearningMinSamples: 1,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };

  assert.doesNotThrow(() => mod.recordPoolPatternEntry({
    positionPubkey: 'PosSparse',
    features: {
      tokenMint: 'MintSparse111111111111111111111111111111111',
      poolAddress: '',
      symbol: '',
      binStep: null,
      tvl: null,
      volume24h: null,
      volumeTvlRatio: null,
      mcap: null,
      holderCount: null,
      supertrend15m: 'UNKNOWN',
      feeActiveTvlRatio: null,
      rangeWidthBins: null,
      entryActiveBin: null,
      entryReason: '',
    },
    cfg,
  }));

  assert.doesNotThrow(() => mod.recordPoolPatternOutcome({
    positionPubkey: 'PosSparse',
    features: {
      tokenMint: 'MintSparse111111111111111111111111111111111',
      poolAddress: '',
      symbol: '',
      binStep: null,
      tvl: null,
      volume24h: null,
      volumeTvlRatio: null,
      mcap: null,
      holderCount: null,
      supertrend15m: 'UNKNOWN',
      feeActiveTvlRatio: null,
      rangeWidthBins: null,
      entryActiveBin: null,
      entryReason: '',
    },
    outcome: {
      feePnlPct: 0,
      feePnlSol: 0,
      totalPnlPct: -1.5,
      pnlSol: -0.01,
      exitReason: 'MANUAL_STOP',
      holdDurationMs: 0,
    },
    cfg,
  }));

  const raw = readFileSync(logPath, 'utf8');
  assert.match(raw, /"type":"ENTRY"/);
  assert.match(raw, /"type":"OUTCOME"/);
});

test('shadow mode computes delta but does not apply score changes', async () => {
  makeIsolatedEnv();
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const features = baseFeatures();
  const cfg = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: true,
    poolPatternLearningMinSamples: 2,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };

  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosShadow1',
    features,
    outcome: { feePnlPct: 1, feePnlSol: 0.001, totalPnlPct: 4, pnlSol: 0.01, exitReason: 'TAKE_PROFIT' },
    cfg,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosShadow2',
    features,
    outcome: { feePnlPct: 0.6, feePnlSol: 0.0007, totalPnlPct: 2, pnlSol: 0.005, exitReason: 'TAKE_PROFIT' },
    cfg,
  });

  const decision = mod.evaluatePoolPatternLearning(features, cfg);
  assert.equal(decision.enabled, true);
  assert.equal(decision.shadowMode, true);
  assert.equal(decision.sampleCount, 2);
  assert.ok(decision.delta > 0);
  assert.equal(decision.appliedDelta, 0);
  assert.equal(mod.applyPoolPatternLearningDelta(74, decision), 74);
});

test('active mode applies bounded delta and enforces min sample threshold', async () => {
  makeIsolatedEnv();
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const features = baseFeatures();

  const cfgMinNotMet = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: false,
    poolPatternLearningMinSamples: 3,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosMin1',
    features,
    outcome: { feePnlPct: 1, totalPnlPct: 5, pnlSol: 0.01, exitReason: 'TAKE_PROFIT' },
    cfg: cfgMinNotMet,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosMin2',
    features,
    outcome: { feePnlPct: 1, totalPnlPct: 4, pnlSol: 0.01, exitReason: 'TAKE_PROFIT' },
    cfg: cfgMinNotMet,
  });
  const belowMin = mod.evaluatePoolPatternLearning(features, cfgMinNotMet);
  assert.equal(belowMin.sampleCount, 2);
  assert.equal(belowMin.appliedDelta, 0);

  const cfgActive = { ...cfgMinNotMet, poolPatternLearningMinSamples: 2, poolPatternLearningMaxScoreDelta: 1 };
  const activeDecision = mod.evaluatePoolPatternLearning(features, cfgActive);
  assert.ok(activeDecision.delta > 0);
  assert.ok(activeDecision.appliedDelta > 0);
  assert.ok(activeDecision.appliedDelta <= 1);
  assert.equal(mod.applyPoolPatternLearningDelta(70, activeDecision), 70 + activeDecision.appliedDelta);
});

test('negative exit patterns reduce score; fee-positive but deeply negative total is not treated as win', async () => {
  makeIsolatedEnv();
  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const features = baseFeatures();
  const cfg = {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: false,
    poolPatternLearningMinSamples: 2,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  };

  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosNeg1',
    features,
    outcome: { feePnlPct: 0.8, feePnlSol: 0.001, totalPnlPct: -18, pnlSol: -0.1, exitReason: 'STOP_LOSS' },
    cfg,
  });
  mod.recordPoolPatternOutcome({
    positionPubkey: 'PosNeg2',
    features,
    outcome: { feePnlPct: 0.5, feePnlSol: 0.0005, totalPnlPct: -12, pnlSol: -0.07, exitReason: 'POOL_IMPACT_GUARD' },
    cfg,
  });

  const negDecision = mod.evaluatePoolPatternLearning(features, cfg);
  assert.equal(negDecision.sampleCount, 2);
  assert.ok(negDecision.delta < 0);
  assert.ok(negDecision.appliedDelta < 0);
});

test('lookback window ignores stale outcomes outside configured days', async () => {
  const { logPath } = makeIsolatedEnv();
  const staleEvent = {
    type: 'OUTCOME',
    at: Date.now() - (30 * 24 * 60 * 60 * 1000),
    positionPubkey: 'PosOld1',
    tokenMint: 'MintPattern111111111111111111111111111111111',
    poolAddress: 'PoolPattern111111111111111111111111111111111',
    symbol: 'PATTERN',
    fingerprint: 'BIN_100|TVL_250K_1M|VT_2_5|MCAP_1M_10M|HOLD_500_2K|FEE_TVL_0_1_0_3PCT|BULLISH|RANGE_48_68',
    feePnlPct: 2,
    feePnlSol: 0.002,
    totalPnlPct: 8,
    pnlSol: 0.05,
    exitReason: 'TAKE_PROFIT',
  };
  writeFileSync(logPath, `${JSON.stringify(staleEvent)}\n`, 'utf8');

  const mod = await importFresh(join(repoRoot, 'src/learn/poolPatternLearning.js'));
  const decision = mod.evaluatePoolPatternLearning(baseFeatures(), {
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: false,
    poolPatternLearningMinSamples: 1,
    poolPatternLearningMaxScoreDelta: 8,
    poolPatternLearningLookbackDays: 14,
  });
  assert.equal(decision.sampleCount, 0);
  assert.equal(decision.appliedDelta, 0);
});
