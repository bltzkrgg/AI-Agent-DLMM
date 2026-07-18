import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePositionExitPolicy } from '../src/utils/positionExitPolicy.js';

const base = {
  deployedAt: '2026-07-18T00:00:00.000Z',
  nowMs: Date.parse('2026-07-18T01:00:00.000Z'),
  stopLossPct: 10,
  maxHoldHours: 72,
  takeProfitPct: 5,
  trailingTriggerPct: 3,
  trailingDropPct: 1,
};

test('position exit policy prioritizes hard stop loss', () => {
  const result = evaluatePositionExitPolicy({ ...base, pnlPct: -10.5, hwmPct: 4 });
  assert.equal(result.action, 'STOP_LOSS');
});

test('position exit policy triggers direct take profit', () => {
  const result = evaluatePositionExitPolicy({ ...base, pnlPct: 5.1, hwmPct: 4.8 });
  assert.equal(result.action, 'TAKE_PROFIT');
  assert.equal(result.scenario, 'TRAILING_STOP_PCT');
});

test('position exit policy trails from the high-water mark', () => {
  const result = evaluatePositionExitPolicy({
    ...base,
    takeProfitPct: 10,
    pnlPct: 4,
    hwmPct: 5.2,
  });
  assert.equal(result.action, 'TAKE_PROFIT');
  assert.equal(result.scenario, 'TRAILING');
  assert.equal(result.nextHwmPct, 5.2);
});

test('position exit policy updates HWM while holding', () => {
  const result = evaluatePositionExitPolicy({ ...base, takeProfitPct: 10, pnlPct: 2.5, hwmPct: 1 });
  assert.equal(result.action, 'HOLD');
  assert.equal(result.nextHwmPct, 2.5);
});
