import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

async function loadPoolMemory() {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-pool-memory-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');
  return importFresh(join(repoRoot, 'src/market/poolMemory.js'));
}

test('pool memory records close outcomes and boosts profitable pools', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintProfit111111111111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    poolAddress: 'PoolProfit111111111111111111111111111111111',
    symbol: 'PROFIT',
    pnlPct: 0.48,
    pnlSol: 0.0005,
    reason: 'TAKE_PROFIT_TRAILING',
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastOutcome, 'PROFIT');
  assert.equal(row.successCount, 1);
  assert.equal(row.failureCount, 0);

  const signal = memory.getPoolMemorySignal(key);
  assert.equal(signal.cooldownActive, false);
  assert.equal(signal.priorityDelta > 0, true);
});

test('pool memory applies cooldown after repeated losses', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintLoss11111111111111111111111111111111111';

  memory.recordPoolOutcome({ key, tokenMint: key, pnlPct: -4, reason: 'STOP_LOSS' });
  memory.recordPoolOutcome({ key, tokenMint: key, pnlPct: -3, reason: 'STOP_LOSS' });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastOutcome, 'LOSS');
  assert.equal(row.failureCount, 2);
  assert.equal(row.cooldownUntil > Date.now(), true);

  const signal = memory.getPoolMemorySignal(key);
  assert.equal(signal.cooldownActive, true);
  assert.equal(signal.priorityDelta < 0, true);
});

test('pool memory records non-refundable fee history only on the affected pool and clears on success', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintRent11111111111111111111111111111111111';

  memory.recordPoolRentFailure({
    key,
    tokenMint: key,
    poolAddress: 'PoolRent11111111111111111111111111111111111',
    symbol: 'RENT',
    rangeMin: -626,
    rangeMax: -567,
    detail: 'BIN_ARRAY_RENT_REQUIRED: 1 uninitialized bin array',
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.rentFailureCount, 1);
  assert.equal(row.rentCooldownUntil, 0);

  const signal = memory.getPoolMemorySignal(key);
  assert.equal(signal.cooldownActive, false);
  assert.match(signal.reason, /POOL_NON_REFUNDABLE_FEE_HISTORY_/);
  assert.equal(signal.priorityDelta, 0);

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: 1.2,
    reason: 'TAKE_PROFIT',
  });

  const after = memory.getPoolMemory(key);
  assert.equal(after.rentFailureCount, 0);
  assert.equal(after.rentCooldownUntil, 0);
});

test('pool memory keeps non-refundable fee history isolated by pool address even when mint matches', async () => {
  const memory = await loadPoolMemory();
  const mint = 'MintShared1111111111111111111111111111111111';
  const poolA = 'PoolSharedA111111111111111111111111111111111';
  const poolB = 'PoolSharedB111111111111111111111111111111111';

  memory.recordPoolRentFailure({
    tokenMint: mint,
    poolAddress: poolA,
    symbol: 'SHARED',
    rangeMin: -10,
    rangeMax: 10,
    detail: 'BIN_ARRAY_RENT_REQUIRED: 1 uninitialized bin array',
  });

  const signalA = memory.getPoolMemorySignal({ tokenMint: mint, poolAddress: poolA });
  const signalB = memory.getPoolMemorySignal({ tokenMint: mint, poolAddress: poolB });

  assert.equal(signalA.cooldownActive, false);
  assert.match(signalA.reason, /POOL_NON_REFUNDABLE_FEE_HISTORY_/);
  assert.equal(signalA.priorityDelta, 0);
  assert.equal(signalB.cooldownActive, false);
  assert.equal(signalB.reason, 'NO_MEMORY');
});

test('pool memory records WATCH and DEPLOY decisions without outcome churn', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintWatch1111111111111111111111111111111111';

  memory.recordPoolDecision({
    key,
    decision: 'WATCH',
    reason: 'TA PASS',
    source: 'TEST',
    snapshot: {
      taTrend: 'BULLISH',
      priceChangeM5: 1.2,
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      entryTimingState: 'LP_LIVE',
    },
  });
  memory.recordPoolDeploy({
    key,
    reason: 'QUEUE_DEPLOY',
    source: 'TEST_QUEUE',
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastDecision, 'DEPLOY');
  assert.equal(row.lastOutcome, null);
  assert.equal(row.recentTrend, 'UNKNOWN');
  assert.equal(row.successCount, 0);
});

test('pool memory signal includes lightweight lookup observability', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintObs111111111111111111111111111111111111';

  const emptySignal = memory.getPoolMemorySignal(key);
  assert.equal(emptySignal.reason, 'NO_MEMORY');
  assert.equal(Number.isFinite(emptySignal.lookupMs), true);

  memory.recordPoolOutcome({ key, tokenMint: key, pnlPct: 1.1, reason: 'TAKE_PROFIT' });
  const signal = memory.getPoolMemorySignal(key);
  assert.equal(signal.memory.lastOutcome, 'PROFIT');
  assert.equal(Number.isFinite(signal.lookupMs), true);
});

test('reentry discipline blocks weak same-mint reentry after recent loss', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintReentryLoss11111111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: -2.4,
    reason: 'STOP_LOSS',
  });

  const decision = memory.evaluatePoolReentryDiscipline({
    pool: { tokenMint: key },
    entrySignals: {
      taTrend: 'BULLISH',
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      priceChangeM15: 0,
    },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /REENTRY_WAIT_AFTER_LOSS_/);
});

test('reentry discipline allows same-mint reentry after loss once fresh momentum is back', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintReentryReset1111111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: -1.8,
    reason: 'OUT_OF_RANGE',
  });

  const decision = memory.evaluatePoolReentryDiscipline({
    pool: { tokenMint: key },
    entrySignals: {
      taTrend: 'BULLISH',
      entryTimingState: 'BREAKOUT',
      entryReadiness: 'HIGH',
      breakoutQuality: 'STRONG',
      priceChangeM15: 2.6,
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'POOL_MEMORY_DELTA_0');
});

test('out-of-range close does not poison pool-memory as a loss', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintOORReset111111111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: 0,
    reason: 'OUT_OF_RANGE_30M',
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastDecision, 'CLOSE');
  assert.equal(row.lastOutcome, 'BREAKEVEN');

  const decision = memory.evaluatePoolReentryDiscipline({
    pool: { tokenMint: key },
    entrySignals: {
      taTrend: 'BULLISH',
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      priceChangeM15: 0,
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'POOL_MEMORY_DELTA_0');
});

test('out-of-range high close stays neutral and is ignored by reentry memory', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintOORHigh1111111111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: -2.5,
    reason: 'OUT_OF_RANGE_HIGH',
    snapshot: { rawReason: 'OOR HIGH' },
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastOutcome, 'BREAKEVEN');
  assert.equal(row.lastReentryIgnored, true);
  assert.equal(row.lastReentryIgnoredReason, 'OUT_OF_RANGE_HIGH');
  assert.equal(row.failureCount, 0);
  assert.equal(row.successCount, 0);

  const decision = memory.evaluatePoolReentryDiscipline({
    pool: { tokenMint: key },
    entrySignals: {
      taTrend: 'BULLISH',
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      priceChangeM15: 0.8,
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'OUT_OF_RANGE_HIGH');
});

test('manual close unknown does not register as profit or loss', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintManualUnknown1111111111111111111111111';

  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: 0,
    reason: 'MANUAL_WITHDRAW_DETECTED',
  });

  const row = memory.getPoolMemory(key);
  assert.equal(row.lastOutcome, 'BREAKEVEN');
  assert.equal(row.successCount, 0);
  assert.equal(row.failureCount, 0);
});

test('legacy out-of-range loss memory does not block reentry', async () => {
  const memory = await loadPoolMemory();
  const key = 'MintLegacyOOR11111111111111111111111111111';

  memory.recordPoolDecision({
    key,
    decision: 'CLOSE',
    reason: 'OUT_OF_RANGE_30M',
    source: 'LEGACY_TEST',
  });
  memory.recordPoolOutcome({
    key,
    tokenMint: key,
    pnlPct: -1.2,
    reason: 'STOP_LOSS',
  });

  const existing = memory.getPoolMemory(key);
  existing.lastReason = 'OUT_OF_RANGE_30M';
  existing.lastOutcome = 'LOSS';
  existing.lastDecision = 'CLOSE';

  const decision = memory.evaluatePoolReentryDiscipline({
    pool: { tokenMint: key },
    entrySignals: {
      taTrend: 'BULLISH',
      entryTimingState: 'LP_LIVE',
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      priceChangeM15: 1.1,
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'NO_RECENT_LOSS');
});

test('pool memory module does not import network or LLM dependencies', () => {
  const src = readFileSync(join(repoRoot, 'src/market/poolMemory.js'), 'utf8');
  assert.doesNotMatch(src, /createMessage|getMarketSnapshot|fetchWithTimeout|fetch\(/);
});
