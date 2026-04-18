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

test('resolvePnlSnapshot emits divergence audit payload when lp_agent and on-chain diverge > threshold', () => {
  const events = [];
  const result = resolvePnlSnapshot({
    deployedSol: 1,
    currentValueSol: 0.9,
    providerPnlPct: 12,
    directPnlPct: -3,
    positionAddress: 'pos_test_1',
    poolAddress: 'pool_test_1',
    tokenMint: 'mint_test_1',
    onDivergence: (e) => events.push(e),
  });

  assert.equal(result.source, 'lp_agent');
  assert.equal(events.length, 1);
  assert.equal(events[0].positionAddress, 'pos_test_1');
  assert.equal(events[0].poolAddress, 'pool_test_1');
  assert.equal(events[0].tokenMint, 'mint_test_1');
  assert.equal(events[0].selectedSource, 'lp_agent');
  assert.equal(Number(events[0].divergencePct.toFixed(2)), 15);
});
