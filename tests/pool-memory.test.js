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

test('pool memory applies rent cooldown only to the affected pool and clears on success', async () => {
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
  assert.match(signal.reason, /POOL_RENT_BLOCKED_/);

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

test('pool memory keeps rent cooldown isolated by pool address even when mint matches', async () => {
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
  assert.match(signalA.reason, /POOL_RENT_BLOCKED_/);
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

test('pool memory module does not import network or LLM dependencies', () => {
  const src = readFileSync(join(repoRoot, 'src/market/poolMemory.js'), 'utf8');
  assert.doesNotMatch(src, /createMessage|getMarketSnapshot|fetchWithTimeout|fetch\(/);
});
