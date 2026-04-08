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

test('position lifecycle state is stored alongside close records', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-db-'));
  process.env.BOT_DB_PATH = join(root, 'test.db');

  let dbModule;
  try {
    dbModule = await importFresh(join(repoRoot, 'src/db/database.js'));
  } catch (error) {
    if (String(error?.message || '').includes('Could not locate the bindings file')) {
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
