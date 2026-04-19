import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

function setupIsolatedEnv(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.BOT_DB_PATH = join(root, 'test.db');
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');
  process.env.BOT_MEMORY_PATH = join(root, 'memory.json');
  writeFileSync(process.env.BOT_MEMORY_PATH, JSON.stringify({
    instincts: [],
    closedTrades: [],
    marketEvents: [],
  }, null, 2));
  return root;
}

test('E2E lifecycle orchestration: entry -> active -> close -> reconciled', async () => {
  setupIsolatedEnv('dlmm-e2e-life-');

  const db = await importFresh(join(repoRoot, 'src/db/database.js'));
  const exitTracking = await importFresh(join(repoRoot, 'src/db/exitTracking.js'));
  const strategyLib = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));

  const regime = strategyLib.classifyMarketRegime({
    ta: { supertrend: { trend: 'BULLISH' } },
    ohlcv: { priceChangeH1: 3.8, priceChangeM5: 0.9, atrPct: 3.4, range24hPct: 11.2, historyAgeMinutes: 35 },
    pool: { tvl: 180000, volume24h: 320000, feeTvlRatio: 0.018 },
    sentiment: { buyPressurePct: 63 },
  });
  assert.notEqual(regime.regime, 'BEAR_DEFENSE');

  db.savePosition({
    pool_address: 'PoolE2E11111111111111111111111111111111111',
    position_address: 'PosE2E111111111111111111111111111111111111',
    token_x: 'TokenX1111111111111111111111111111111111111',
    token_y: 'So11111111111111111111111111111111111111112',
    token_mint: 'TokenX1111111111111111111111111111111111111',
    deployed_sol: 0.25,
    strategy_used: 'Evil Panda',
    lifecycle_state: 'open',
  });

  const open = db.getOpenPositions().find((p) => p.position_address === 'PosE2E111111111111111111111111111111111111');
  assert.ok(open);
  assert.equal(open.status, 'open');
  assert.equal(open.lifecycle_state, 'open');

  await db.updatePositionLifecycle(open.position_address, 'closing');
  await db.closePositionWithPnl(open.position_address, {
    pnlUsd: 2.15,
    pnlPct: 6.2,
    feesUsd: 0.9,
    pnlSol: 0.013,
    feesSol: 0.004,
    closeReason: 'TAKE_PROFIT',
    lifecycleState: 'closed_pending_swap',
  });

  exitTracking.recordExitEvent({
    positionAddress: open.position_address,
    poolAddress: open.pool_address,
    tokenMint: open.token_mint,
    entryTime: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    entryPrice: 0.00001,
    exitTime: new Date().toISOString(),
    exitPrice: 0.000012,
    holdMinutes: 45,
    pnlPct: 6.2,
    pnlUsd: 2.15,
    feesClaimedUsd: 0.9,
    totalReturnUsd: 3.05,
    exitTrigger: 'TAKE_PROFIT',
    exitZone: 'GREEN_ZONE',
    exitRetracement: 1.1,
    exitRetracementCap: 1.5,
    feeRatioAtExit: 0.012,
    feeVelocityIncreasing: true,
    lperPatienceActive: false,
    profitOrLoss: 'PROFIT',
    exitReason: 'TP reached',
    closeReasonCode: 'TAKE_PROFIT',
  });

  const closedPending = db.getClosedPositions().find((p) => p.position_address === open.position_address);
  assert.ok(closedPending);
  assert.equal(closedPending.status, 'closed');
  assert.equal(closedPending.lifecycle_state, 'closed_pending_swap');
  assert.ok(exitTracking.getExitEventCount() >= 1);

  await db.updatePositionLifecycle(open.position_address, 'closed_reconciled');
  const closedReconciled = db.getClosedPositions().find((p) => p.position_address === open.position_address);
  assert.equal(closedReconciled.lifecycle_state, 'closed_reconciled');
});

test('E2E lifecycle: swap-skip path stays manual_review (not reconciled)', async () => {
  setupIsolatedEnv('dlmm-e2e-manual-review-');
  const db = await importFresh(join(repoRoot, 'src/db/database.js'));

  db.savePosition({
    pool_address: 'PoolE2E22222222222222222222222222222222222',
    position_address: 'PosE2E222222222222222222222222222222222222',
    token_x: 'TokenX2222222222222222222222222222222222222',
    token_y: 'So11111111111111111111111111111111111111112',
    deployed_sol: 0.3,
    strategy_used: 'Evil Panda',
    lifecycle_state: 'open',
  });

  await db.updatePositionLifecycle('PosE2E222222222222222222222222222222222222', 'closing');
  await db.closePositionWithPnl('PosE2E222222222222222222222222222222222222', {
    pnlUsd: -1.2,
    pnlPct: -3.7,
    feesUsd: 0.2,
    pnlSol: -0.007,
    feesSol: 0.001,
    closeReason: 'STOP_LOSS',
    lifecycleState: 'manual_review',
  });

  const pos = db.getClosedPositions().find((p) => p.position_address === 'PosE2E222222222222222222222222222222222222');
  assert.ok(pos);
  assert.equal(pos.lifecycle_state, 'manual_review');
  assert.notEqual(pos.lifecycle_state, 'closed_reconciled');
});

test('E2E orchestration guard: CIRCUIT_BREAKER_ACTIVE blocks hunter run', async () => {
  setupIsolatedEnv('dlmm-e2e-cb-');
  const state = await importFresh(join(repoRoot, 'src/runtime/state.js'));
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const db = await importFresh(join(repoRoot, 'src/db/database.js'));

  state.setRuntimeState('hunter-circuit-breaker', {
    pausedUntil: Date.now() + 10 * 60 * 1000,
    count: 3,
  });
  await state.flushRuntimeState();

  const before = db.getOpenPositions().length;
  const notes = [];
  await hunter.runHunterAlpha(async (msg) => {
    notes.push(String(msg));
    return { message_id: 1 };
  });
  const after = db.getOpenPositions().length;

  assert.equal(before, after, 'hunter should not create new positions while circuit breaker is active');
  assert.ok(notes.some((n) => /Circuit Breaker Active/i.test(n)));
});
