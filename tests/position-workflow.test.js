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

test('resolvePositionSnapshot keeps pnl/status consistent across surfaces', async () => {
  const { resolvePositionSnapshot } = await importFresh(join(repoRoot, 'src/app/positionSnapshot.js'));

  const snapshot = resolvePositionSnapshot({
    dbPosition: {
      position_address: 'pos-1',
      deployed_sol: 2,
      status: 'open',
      lifecycle_state: 'open',
    },
    livePosition: {
      currentValueSol: 2.1,
      feeCollectedSol: 0.04,
      inRange: false,
    },
    providerPnlPct: 7.5,
  });

  assert.equal(snapshot.status, 'OutRange');
  assert.equal(snapshot.lifecycleState, 'open');
  assert.equal(snapshot.pnlPct, 7.5);
  assert.equal(snapshot.pnlSol, 0.15);
  assert.equal(snapshot.feeSol, 0.04);
  assert.equal(snapshot.pnlSource, 'lp_agent');
});

test('position runtime state persists peak pnl and oor markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-runtime-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const runtimeModule = await importFresh(join(repoRoot, 'src/app/positionRuntimeState.js'));
  runtimeModule.updatePositionRuntimeState('pos-abc', {
    peakPnlPct: 9.2,
    trailingActive: true,
    oorSince: 123456,
  });

  const runtimeModuleReloaded = await importFresh(join(repoRoot, 'src/app/positionRuntimeState.js'));
  const state = runtimeModuleReloaded.getPositionRuntimeState('pos-abc');
  assert.equal(state.peakPnlPct, 9.2);
  assert.equal(state.trailingActive, true);
  assert.equal(state.oorSince, 123456);
});

test('out-of-range monitor state waits, expires, and clears correctly', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const waiting = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: {},
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 0,
  });

  assert.equal(waiting.shouldExit, false);
  assert.equal(waiting.runtimePatch.oorSince, 0);
  assert.match(waiting.notifyMessage, /OOR Watch/);

  const expired = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 61_000,
  });

  assert.equal(expired.shouldExit, true);
  assert.equal(expired.exitReason, 'OUT_OF_RANGE_1M');
  assert.match(expired.notifyMessage, /OOR Timeout/);

  const recovered = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: true, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 90_000,
  });

  assert.equal(recovered.clearOorMarkers, true);
  assert.deepEqual(recovered.runtimePatch, { oorSince: null, lastOorAlertAt: null });
  assert.match(recovered.notifyMessage, /OOR recovered/);
});

test('out-of-range monitor state can display 5 minutes while config remains 30 minutes', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const waiting = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-2',
    symbol: 'OOR2',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -1.1 },
    runtimeState: {},
    cfg: { outOfRangeWaitMinutes: 30 },
    now: 0,
  });

  assert.equal(waiting.shouldExit, false);
  assert.match(waiting.notifyMessage, /batas <code>5(?:\.0)? menit<\/code>/);

  const expired = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-2',
    symbol: 'OOR2',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -1.1 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 30 },
    now: 30 * 60_000 + 1,
  });

  assert.equal(expired.shouldExit, true);
  assert.equal(expired.exitReason, 'OUT_OF_RANGE_30M');
  assert.match(expired.logMessage, /wait=300000ms/);
  assert.match(expired.logMessage, /config=1800000ms/);
});

test('out-of-range monitor state throttles OOR watch alerts by display wait minutes', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const cfg = { outOfRangeWaitMinutes: 45, oorDisplayWaitMinutes: 5 };

  const first = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: {},
    cfg,
    now: 0,
  });

  assert.equal(first.shouldExit, false);
  assert.match(first.notifyMessage, /OOR Watch/);

  const second = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg,
    now: 60_000,
  });

  assert.equal(second.shouldExit, false);
  assert.equal(second.notifyMessage, null);
  assert.equal(second.logMessage, null);

  const third = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg,
    now: 5 * 60_000 + 1,
  });

  assert.equal(third.shouldExit, false);
  assert.match(third.notifyMessage, /OOR Watch/);
});

test('position lifecycle state is stored alongside close records', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-db-'));
  process.env.BOT_DB_PATH = join(root, 'test.db');

  let dbModule;
  try {
    dbModule = await importFresh(join(repoRoot, 'src/db/database.js'));
  } catch (error) {
    const message = String(error?.message || '');
    if (
      message.includes('Could not locate the bindings file') ||
      message.includes('native binding tidak cocok') ||
      message.includes('NODE_MODULE_VERSION')
    ) {
      t.skip('better-sqlite3 native binding is not available in this test environment');
      return;
    }
    throw error;
  }

  dbModule.savePosition({
    pool_address: 'pool-1',
    position_address: 'position-1',
    token_x: 'mint-x',
    token_y: 'mint-y',
    deployed_sol: 1.5,
  });

  dbModule.updatePositionLifecycle('position-1', 'closing');
  let open = dbModule.getOpenPositions().find((p) => p.position_address === 'position-1');
  assert.equal(open.lifecycle_state, 'closing');

  dbModule.closePositionWithPnl('position-1', {
    pnlUsd: 12.3,
    pnlPct: 8.2,
    feesUsd: 1.1,
    closeReason: 'TAKE_PROFIT',
    lifecycleState: 'closed_pending_swap',
  });

  const closed = dbModule.getClosedPositions().find((p) => p.position_address === 'position-1');
  assert.equal(closed.lifecycle_state, 'closed_pending_swap');
  assert.equal(closed.status, 'closed');
});
