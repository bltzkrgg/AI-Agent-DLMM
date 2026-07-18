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

test('paper positions persist in isolation and close to the paper ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-paper-positions-'));
  const statePath = join(root, 'runtime-state.json');
  const ledgerPath = join(root, 'paper-position-ledger.jsonl');
  process.env.BOT_RUNTIME_STATE_PATH = statePath;
  process.env.PAPER_POSITION_LEDGER_PATH = ledgerPath;

  const paper = await importFresh(join(repoRoot, 'src/paper/paperPositions.js'));
  const runtimeState = await import(join(repoRoot, 'src/runtime/state.js'));

  paper.resetPaperPositionsForTests();
  runtimeState.setRuntimeState('evilPandaActivePositions', [{ pubkey: 'real-position' }]);
  runtimeState.setRuntimeState('position_runtime_state', {
    'real-position': { peakPnlPct: 4.2 },
  });

  const created = paper.createPaperPosition({
    poolAddress: 'PoolPaper111',
    tokenMint: 'TokenPaper111',
    symbol: 'PAPER',
    deploySol: 1,
    entryActiveBin: 100,
    entryPrice: 0.25,
    rangeMin: 90,
    rangeMax: 110,
    entryMetadata: { source: 'dry-run-core' },
  });

  assert.match(created.id, /^paper:PoolPaper111:\d+:[a-z0-9]+$/);
  assert.equal(created.executionMode, 'paper');
  assert.equal(created.lifecycle, 'open');
  assert.equal(created.currentValueSol, 1);
  assert.equal(created.hwmPct, 0);
  assert.equal(created.mfePct, 0);
  assert.equal(created.maePct, 0);
  assert.equal(created.activeBinId, 100);
  assert.equal(created.activePrice, 0.25);
  assert.equal(created.rangeWidthBins, 21);
  assert.equal(created.inRangePct, null);
  assert.equal(created.oorState, null);
  assert.deepEqual(created.entryMetadata, { source: 'dry-run-core' });
  assert.equal(paper.getPaperPositionCount(), 1);
  assert.equal(paper.hasPaperPoolPosition('PoolPaper111'), true);
  assert.equal(paper.listPaperPositions()[0].id, created.id);

  const updated = paper.updatePaperPosition(created.id, {
    currentValueSol: 1.08,
    pnlSol: 0.08,
    pnlPct: 8,
    activeBinId: 108,
    activePrice: 0.27,
    inRange: false,
    rangeChecks: 3,
    inRangeChecks: 2,
    outOfRangeChecks: 1,
    inRangePct: 66.6667,
    oorSince: 1_700_000_000_000,
    oorMs: 15_000,
    outOfRangeMs: 15_000,
    outOfRangeSide: 'HIGH',
    outOfRangeBins: 2,
  });

  assert.equal(updated.currentValueSol, 1.08);
  assert.equal(updated.hwmPct, 8);
  assert.equal(updated.mfePct, 8);
  assert.equal(updated.maePct, 0);
  assert.equal(updated.outOfRangeSide, 'HIGH');

  await runtimeState.flushRuntimeState();
  const persistedOpenState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(
    persistedOpenState.evilPandaActivePositions,
    [{ pubkey: 'real-position' }]
  );
  assert.deepEqual(
    persistedOpenState.position_runtime_state,
    { 'real-position': { peakPnlPct: 4.2 } }
  );
  assert.equal(persistedOpenState.paper_open_positions[created.id].pnlPct, 8);

  const closed = paper.closePaperPosition(created.id, {
    reason: 'TAKE_PROFIT',
    currentValueSol: 1.1,
    pnlSol: 0.1,
    pnlPct: 10,
    pnlTotalSol: 0.1,
    pnlTotalPct: 10,
  });

  assert.equal(closed.executionMode, 'paper');
  assert.equal(closed.lifecycle, 'closed');
  assert.equal(closed.closeReason, 'TAKE_PROFIT');
  assert.equal(paper.getPaperPosition(created.id), null);
  assert.equal(paper.getPaperPositionCount(), 0);
  assert.equal(paper.hasPaperPoolPosition('PoolPaper111'), false);

  await runtimeState.flushRuntimeState();
  const persistedClosedState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(
    persistedClosedState.evilPandaActivePositions,
    [{ pubkey: 'real-position' }]
  );
  assert.deepEqual(
    persistedClosedState.position_runtime_state,
    { 'real-position': { peakPnlPct: 4.2 } }
  );
  assert.deepEqual(persistedClosedState.paper_open_positions, {});

  const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].id, created.id);
  assert.equal(ledgerRows[0].executionMode, 'paper');
  assert.equal(ledgerRows[0].lifecycle, 'closed');
  assert.equal(ledgerRows[0].pnlTotalPct, 10);

  paper.createPaperPosition({ id: 'paper:explicit:1:test', poolAddress: 'PoolExplicit' });
  paper.resetPaperPositionsForTests();
  await runtimeState.flushRuntimeState();
  const resetState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal('paper_open_positions' in resetState, false);
  assert.deepEqual(resetState.evilPandaActivePositions, [{ pubkey: 'real-position' }]);
});
