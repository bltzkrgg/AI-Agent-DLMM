/**
 * Integration test: position lifecycle
 *
 * Verifies the full DB state-transition path for each exit trigger,
 * plus source-level assertions that hunter correctly gates on
 * CIRCUIT_BREAKER_ACTIVE and REGIME_BEAR_DEFENSE.
 *
 * Constraint: no real RPC — DB operations only + source assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

// ─── Helper: fresh DB in temp dir ────────────────────────────────
async function freshDb(t) {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-lifecycle-'));
  process.env.BOT_DB_PATH = join(root, 'test.db');
  let db;
  try {
    db = await importFresh(join(repoRoot, 'src/db/database.js'));
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('Could not locate the bindings file') ||
      msg.includes('native binding tidak cocok') ||
      msg.includes('NODE_MODULE_VERSION')
    ) {
      t.skip('better-sqlite3 native binding unavailable in this test environment');
      return null;
    }
    throw err;
  }
  return db;
}

// ─── DB lifecycle: deploy → STOP_LOSS → closed ───────────────────
test('lifecycle: position closes with STOP_LOSS and status becomes closed', async (t) => {
  const db = await freshDb(t);
  if (!db) return;

  db.savePosition({
    pool_address: 'pool-SL',
    position_address: 'pos-SL-1',
    token_x: 'mint-x',
    token_y: 'mint-y',
    deployed_sol: 0.5,
  });

  let open = db.getOpenPositions().find(p => p.position_address === 'pos-SL-1');
  assert.ok(open, 'position should be open after deploy');
  assert.equal(open.status, 'open');

  await db.updatePositionLifecycle('pos-SL-1', 'closing');
  await db.closePositionWithPnl('pos-SL-1', {
    pnlUsd:   -2.1,
    pnlPct:   -6.5,
    feesUsd:  0.3,
    pnlSol:   -0.014,
    feesSol:  0.002,
    closeReason: 'STOP_LOSS',
    lifecycleState: 'closed_pending_swap',
  });

  const closed = db.getClosedPositions().find(p => p.position_address === 'pos-SL-1');
  assert.ok(closed, 'position should appear in closed list');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'STOP_LOSS');
  assert.ok(closed.pnl_pct < 0, 'PnL should be negative for a stop-loss');
});

// ─── DB lifecycle: deploy → MAX_HOLD_EXIT → closed ───────────────
test('lifecycle: position closes with MAX_HOLD_EXIT and status becomes closed', async (t) => {
  const db = await freshDb(t);
  if (!db) return;

  db.savePosition({
    pool_address: 'pool-MH',
    position_address: 'pos-MH-1',
    token_x: 'mint-x',
    token_y: 'mint-y',
    deployed_sol: 0.5,
  });

  await db.updatePositionLifecycle('pos-MH-1', 'closing');
  await db.closePositionWithPnl('pos-MH-1', {
    pnlUsd:   0.8,
    pnlPct:   1.2,
    feesUsd:  1.1,
    pnlSol:   0.005,
    feesSol:  0.007,
    closeReason: 'MAX_HOLD_EXIT',
    lifecycleState: 'closed_pending_swap',
  });

  const closed = db.getClosedPositions().find(p => p.position_address === 'pos-MH-1');
  assert.ok(closed, 'position should appear in closed list');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'MAX_HOLD_EXIT');
});

// ─── DB lifecycle: deploy → TAKE_PROFIT → closed ─────────────────
test('lifecycle: position closes with TAKE_PROFIT and status becomes closed', async (t) => {
  const db = await freshDb(t);
  if (!db) return;

  db.savePosition({
    pool_address: 'pool-TP',
    position_address: 'pos-TP-1',
    token_x: 'mint-x',
    token_y: 'mint-y',
    deployed_sol: 0.5,
  });

  await db.closePositionWithPnl('pos-TP-1', {
    pnlUsd:   5.0,
    pnlPct:   8.2,
    feesUsd:  1.5,
    pnlSol:   0.033,
    feesSol:  0.01,
    closeReason: 'TAKE_PROFIT',
    lifecycleState: 'closed_reconciled',
  });

  const closed = db.getClosedPositions().find(p => p.position_address === 'pos-TP-1');
  assert.ok(closed);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'TAKE_PROFIT');
  assert.ok(closed.pnl_pct > 0, 'PnL should be positive for take-profit');
});

// ─── Source: CIRCUIT_BREAKER_ACTIVE blocks hunter entry ──────────
test('CIRCUIT_BREAKER_ACTIVE: hunter returns early when pausedUntil > now', () => {
  const src = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf-8');

  // Must read circuit breaker from runtime state
  assert.match(src, /getRuntimeState\(['"]hunter-circuit-breaker['"]/);

  // Must compare pausedUntil against current time and return early
  assert.match(src, /cb\?\.pausedUntil.*Date\.now\(\)|Date\.now\(\).*cb\?\.pausedUntil/);
  assert.match(src, /pausedUntil.*Date\.now\(\).*return|return[\s\S]{0,20}pausedUntil/);
});

// ─── Source: REGIME_BEAR_DEFENSE blocks hunter entry ─────────────
test('REGIME_BEAR_DEFENSE: hunter returns blocked JSON when regime is BEAR_DEFENSE', () => {
  const src = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf-8');

  // classifyMarketRegime must be called
  assert.match(src, /classifyMarketRegime\(/);

  // Must check for BEAR_DEFENSE and return a blocked response
  assert.match(src, /regime.*BEAR_DEFENSE|BEAR_DEFENSE.*regime/);
  assert.match(src, /policy:\s*['"]REGIME_BEAR_DEFENSE['"]/);
  assert.match(src, /blocked:\s*true/);
});

// ─── Source: MAX_HOLD_EXIT trigger code present in healer ────────
test('MAX_HOLD_EXIT: healer computes maxHoldTriggered and emits correct trigger code', () => {
  const src = readFileSync(join(repoRoot, 'src/agents/healerAlpha.js'), 'utf-8');

  assert.match(src, /const maxHoldTriggered\s*=\s*positionAgeMin\s*>=\s*maxHoldMinutes/);
  assert.match(src, /if \(maxHoldTriggered\)\s*\{\s*decision\s*=\s*'CLOSE'/);
  assert.match(src, /maxHoldTriggered\s*\?\s*'MAX_HOLD_EXIT'/);
});
