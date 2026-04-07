import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePnlSnapshot } from '../src/app/pnl.js';

test('resolvePnlSnapshot prefers provider pnl percentage over manual estimate', () => {
  const result = resolvePnlSnapshot({
    deployedSol: 1,
    currentValueSol: 1.5,
    providerPnlPct: 12.34,
  });

  assert.equal(result.pnlPct, 12.34);
  assert.equal(result.pnlSol, 0.1234);
  assert.equal(result.source, 'lp_agent');
});

test('resolvePnlSnapshot falls back to manual estimate when provider pnl is absent', () => {
  const result = resolvePnlSnapshot({
    deployedSol: 2,
    currentValueSol: 2.5,
  });

  assert.equal(result.pnlPct, 25);
  assert.equal(result.pnlSol, 0.5);
  assert.equal(result.source, 'manual_estimate');
});
