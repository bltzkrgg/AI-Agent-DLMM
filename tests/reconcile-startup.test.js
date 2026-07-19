import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const evilPandaPath = resolve(process.cwd(), 'src/sniper/evilPanda.js');
const indexPath = resolve(process.cwd(), 'src/index.js');

test('evilPanda exposes startup reconciliation worker and runtime-state key', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const ACTIVE_POSITIONS_STATE_KEY = 'evilPandaActivePositions'/);
  assert.match(src, /export async function reconcileStartupPositions\(\)/);
  assert.match(src, /getRuntimeState\(ACTIVE_POSITIONS_STATE_KEY, \[\]\)/);
  assert.match(src, /persistActivePositionsState\(\)/);
});

test('startup reconcile validates saved positions against on-chain state', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /getPositionsByUserAndLbPair\(wallet\.publicKey\)/);
  assert.match(src, /const exists = userPositions\.some/);
  assert.match(src, /restored\+\+/);
  assert.match(src, /dropped\+\+/);
});

test('index boot sequence calls reconcileStartupPositions and reports summary', () => {
  const src = readFileSync(indexPath, 'utf8');
  assert.match(src, /reconcileStartupPositions/);
  assert.match(src, /updateConfig\(\{ dryRun: false \}\)/);
  assert.match(src, /const reconcile = await reconcileStartupPositions\(\)/);
  assert.match(src, /Reconcile: <code>\$\{reconcile\.restored\}\/\$\{reconcile\.scanned\}<\/code>/);
  assert.match(src, /const paperInactiveCount = getPaperPositions\(\)\.length/);
  assert.match(src, /Dry Run: <code>OFF<\/code> \| Paper Inactive: <code>\$\{paperInactiveCount\}<\/code>/);
  assert.doesNotMatch(src, /spawnMonitorForRestoredPaperPositions/);
  assert.match(src, /async function restoreAutoScreeningOnStartup/);
  const restoreStart = src.indexOf('async function restoreAutoScreeningOnStartup');
  assert.notEqual(restoreStart, -1);
  const restoreEnd = src.indexOf('// ── Graceful Shutdown', restoreStart);
  const restoreBlock = src.slice(restoreStart, restoreEnd);
  assert.match(restoreBlock, /AUTOSCREEN_STARTUP_DISABLED/);
  assert.match(restoreBlock, /manual_command_required/);
  assert.doesNotMatch(restoreBlock, /startAutoScreeningRuntime/);
  assert.doesNotMatch(restoreBlock, /runSilentScan/);
  assert.doesNotMatch(restoreBlock, /runScreeningLoop/);
  assert.match(src, /await restoreAutoScreeningOnStartup\(\{/);
});
