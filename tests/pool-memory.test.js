import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
