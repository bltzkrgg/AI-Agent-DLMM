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

  // Fix #4: divergence now forces on_chain_fallback so result source must change
  assert.equal(result.source, 'on_chain_fallback');
  assert.equal(events.length, 1);
  assert.equal(events[0].positionAddress, 'pos_test_1');
  assert.equal(events[0].poolAddress, 'pool_test_1');
  assert.equal(events[0].tokenMint, 'mint_test_1');
  assert.equal(events[0].selectedSource, 'on_chain_fallback');
  assert.equal(Number(events[0].divergencePct.toFixed(2)), 15);
});

test('resolvePnlSnapshot uses directPnlPct value when divergence exceeds threshold', () => {
  const result = resolvePnlSnapshot({
    deployedSol: 1,
    currentValueSol: 0.9,
    providerPnlPct: 12,   // stale/wrong
    directPnlPct: -3,     // on-chain truth, divergence = 15% > default 10%
  });

  // Must use on-chain value, not provider value
  assert.equal(result.pnlPct, -3);
  assert.equal(result.source, 'on_chain_fallback');
});

test('resolvePnlSnapshot uses providerPnlPct when divergence is within threshold', () => {
  const result = resolvePnlSnapshot({
    deployedSol: 1,
    currentValueSol: 1.05,
    providerPnlPct: 5,
    directPnlPct: 5.5,    // divergence = 0.5% — well within threshold
  });

  assert.equal(result.pnlPct, 5);
  assert.equal(result.source, 'lp_agent');
});
