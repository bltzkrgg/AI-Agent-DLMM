import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(relPath) {
  return readFileSync(join(__dirname, '..', relPath), 'utf-8');
}

test('manual CA and watch queue propagate LP snapshot metadata into queue payloads', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');

  assert.match(hunterSrc, /queueMeta = \{[\s\S]*taTrend: entrySignals\.taTrend/);
  assert.match(hunterSrc, /queueMeta = \{[\s\S]*priceChangeM5: entrySignals\.priceChangeM5/);
  assert.match(hunterSrc, /queueMeta = \{[\s\S]*entryTimingState: entrySignals\.entryTimingState/);
  assert.match(hunterSrc, /queueMeta = \{[\s\S]*snapshotPrice: pool\._watchSnapshotPrice/);
  assert.match(hunterSrc, /queueMeta = \{[\s\S]*watchWindowSec/);
});

test('watch promotion preserves the same LP metadata fields for deploy queue', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');

  assert.match(hunterSrc, /entryTimingState:\s*'LP_LIVE'/);
  assert.match(hunterSrc, /breakoutQuality:\s*'VALID'/);
  assert.match(hunterSrc, /queueTrustedWatch:\s*true/);
  assert.match(hunterSrc, /taTrend: pool\._entrySignals\?\.taTrend \?\? row\.taTrend/);
  assert.match(hunterSrc, /priceChangeM5: pool\._entrySignals\?\.priceChangeM5 \?\? row\.priceChangeM5/);
  assert.match(hunterSrc, /snapshotAt: row\.snapshotAt \|\| now/);
});

test('queue helper emits cache and fallback observability logs', () => {
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');

  assert.match(queueSrc, /Snapshot cache hit/);
  assert.match(queueSrc, /Snapshot cache miss/);
  assert.match(queueSrc, /Snapshot inflight reuse/);
  assert.match(queueSrc, /Ignored unreliable live snapshot/);
});
