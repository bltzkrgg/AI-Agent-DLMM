import test from 'node:test';
import assert from 'node:assert/strict';

import { getExitDisplayMeta, normalizeExitReason } from '../src/utils/exitReasons.js';

test('exit reason normalization maps raw reasons to stable categories', () => {
  assert.equal(normalizeExitReason('STOP_LOSS'), 'STOP_LOSS');
  assert.equal(normalizeExitReason('pool impact guard forced close'), 'POOL_IMPACT_GUARD');
  assert.equal(normalizeExitReason('OUT_OF_RANGE_30M'), 'OUT_OF_RANGE');
  assert.equal(normalizeExitReason('TRAILING_STOP_LOSS'), 'TRAILING_STOP');
  assert.equal(normalizeExitReason('MANUAL_EXIT'), 'MANUAL_EXIT');
  assert.equal(normalizeExitReason('MANUAL_COMMAND'), 'MANUAL_EXIT');
  assert.equal(normalizeExitReason('VETO_NON_REFUNDABLE_RENT'), 'VETO_NON_REFUNDABLE_RENT');
  assert.equal(normalizeExitReason('PARTIAL_DEPLOY_ROLLBACK'), 'DEPLOY_FAILED');
  assert.equal(normalizeExitReason('no idea'), 'UNKNOWN');
});

test('exit display metadata keeps operator labels consistent across exit families', () => {
  assert.deepEqual(getExitDisplayMeta('TAKE_PROFIT_TRAILING', 'TRAILING_STOP'), {
    title: 'TAKE PROFIT',
    reasonLabel: 'Trailing Profit Trigger',
    normalizedReason: 'TRAILING_STOP',
  });

  assert.deepEqual(getExitDisplayMeta('TAKE_PROFIT_C', 'TAKE_PROFIT'), {
    title: 'TAKE PROFIT',
    reasonLabel: 'Defensive Exit Trigger',
    normalizedReason: 'TAKE_PROFIT',
  });

  assert.deepEqual(getExitDisplayMeta('STOP_LOSS', 'STOP_LOSS'), {
    title: 'STOP LOSS',
    reasonLabel: 'Stop Loss Trigger',
    normalizedReason: 'STOP_LOSS',
  });
});
