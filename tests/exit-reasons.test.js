import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeExitReason } from '../src/utils/exitReasons.js';

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
