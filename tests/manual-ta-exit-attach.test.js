import test from 'node:test';
import assert from 'node:assert/strict';

import { __findManualTaExitAttachmentTargetForTests } from '../src/agents/hunterAlpha.js';

test('manual TA exit attaches to matching active position by mint, pool, or pubkey', () => {
  const activePositions = [
    { pubkey: 'pos-1', poolAddress: 'pool-1', mint: 'mint-1' },
    { pubkey: 'pos-2', poolAddress: 'pool-2', mint: 'mint-2' },
  ];

  assert.equal(__findManualTaExitAttachmentTargetForTests(activePositions, { tokenMint: 'mint-2' })?.pubkey, 'pos-2');
  assert.equal(__findManualTaExitAttachmentTargetForTests(activePositions, { poolAddress: 'pool-1' })?.pubkey, 'pos-1');
  assert.equal(__findManualTaExitAttachmentTargetForTests(activePositions, { positionPubkey: 'pos-2' })?.poolAddress, 'pool-2');
  assert.equal(__findManualTaExitAttachmentTargetForTests(activePositions, { tokenMint: 'missing' }), null);
});
