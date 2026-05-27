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

test('watch and deploy queue carry frozen entry intent fields through the LP path', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(hunterSrc, /_entryActiveBin:\s*entryIntent\.entryActiveBin/);
  assert.match(hunterSrc, /hasFrozenEntryIntent:\s*entryIntent\.hasFrozenEntryIntent/);
  assert.match(hunterSrc, /entryActiveBin:\s*toFiniteNumber\(row\.entryActiveBin \?\? pool\._entryActiveBin/);
  assert.match(queueSrc, /frozenEntryIntent:\s*\{/);
  assert.match(queueSrc, /enabled:\s*frozenEnabled/);
  assert.match(pandaSrc, /ENTRY_INTENT_FROZEN/);
  assert.match(pandaSrc, /skipActiveBinRefresh:\s*frozenIntentEnabled/);
});

test('queue helper emits cache and fallback observability logs', () => {
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');

  assert.match(queueSrc, /Snapshot cache hit/);
  assert.match(queueSrc, /Snapshot cache miss/);
  assert.match(queueSrc, /Snapshot inflight reuse/);
  assert.match(queueSrc, /Ignored unreliable live snapshot/);
});

test('pool memory observability stays on local hot path only', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');
  const memorySrc = readSource('src/market/poolMemory.js');

  assert.match(hunterSrc, /formatMemorySignal/);
  assert.match(hunterSrc, /memory=.*delta=.*lookup=/);
  assert.match(queueSrc, /Memory advisory/);
  assert.doesNotMatch(queueSrc, /Memory hold/);
  assert.doesNotMatch(memorySrc, /createMessage|getMarketSnapshot|fetchWithTimeout|fetch\(/);
});
