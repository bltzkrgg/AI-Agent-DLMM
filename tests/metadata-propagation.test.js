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
  assert.match(hunterSrc, /queueMeta = \{[\s\S]*entryCanonicalSnapshot: buildCanonicalEntrySnapshot\(/);
});

test('watch promotion preserves the same LP metadata fields for deploy queue', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');

  assert.match(hunterSrc, /entryTimingState:\s*'LP_LIVE'/);
  assert.match(hunterSrc, /breakoutQuality:\s*'VALID'/);
  assert.match(hunterSrc, /queueTrustedWatch:\s*true/);
  assert.match(hunterSrc, /taTrend:\s*pool\._entrySignals\?\.taTrend \?\? row\.taTrend \?\? pool\._watchTaTrend/);
  assert.match(hunterSrc, /priceChangeM5:\s*pool\._entrySignals\?\.priceChangeM5 \?\? row\.priceChangeM5 \?\? row\.snapshotM5Change \?\? pool\._watchSnapshotM5Change/);
  assert.match(hunterSrc, /snapshotAt:\s*Number\.isFinite\(Number\(row\.snapshotAt\)\) \? Number\(row\.snapshotAt\) : now/);
  assert.match(hunterSrc, /entryCanonicalSnapshot:\s*buildCanonicalEntrySnapshot\(/);
});

test('watch and deploy queue carry frozen entry intent fields through the LP path', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(hunterSrc, /_entryActiveBin:\s*entryIntent\.entryActiveBin/);
  assert.match(hunterSrc, /hasFrozenEntryIntent:\s*entryIntent\.hasFrozenEntryIntent/);
  assert.match(hunterSrc, /entryActiveBin:\s*toFiniteNumber\(row\.entryActiveBin \?\? pool\._entryActiveBin/);
  assert.match(queueSrc, /frozenEntryIntent:\s*\{/);
  assert.match(queueSrc, /entryCanonicalSnapshot:\s*meta\?\.entryCanonicalSnapshot/);
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

test('position runtime state avoids zero placeholder fallback for entry anchor fields', () => {
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(pandaSrc, /entryActiveBin:\s*safeNum\(activeBin\.binId,\s*null\)/);
  assert.match(pandaSrc, /entryPrice:\s*safeNum\(activeBin\.pricePerToken,\s*null\)/);
  assert.match(pandaSrc, /entryAnchorSource:\s*finalDeployState\?\..*anchorSource \|\| anchorMetadata\.anchorSource/);
  assert.match(pandaSrc, /entryAnchorBin:\s*finalDeployState\?\..*anchorActiveBinId .* anchorMetadata\.anchorActiveBinId/);
  assert.match(pandaSrc, /entryAnchorPrice:\s*finalDeployState\?\..*anchorPrice .* anchorMetadata\.anchorPrice/);
  assert.match(pandaSrc, /rangeAdjustReason:\s*finalDeployState\?\..*rangeAdjustReason \|\| null/);
});

test('deploy callers propagate final Supertrend stamps into position metadata and restore them on startup', () => {
  const hunterSrc = readSource('src/agents/hunterAlpha.js');
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(hunterSrc, /finalTrendStamp:\s*\{[\s\S]*direction:\s*finalSt\.direction \|\| 'UNKNOWN'/);
  assert.match(queueSrc, /finalTrendStamp:\s*\{[\s\S]*direction:\s*finalSt\.direction \|\| 'UNKNOWN'/);
  assert.match(hunterSrc, /entryCanonicalSnapshot:\s*buildCanonicalEntrySnapshot\(\{/);
  assert.match(pandaSrc, /const entryCanonicalSnapshot = \(deployOptions && typeof deployOptions\.entryCanonicalSnapshot === 'object'\)/);
  assert.match(pandaSrc, /entryCanonicalSnapshot,/);
  assert.match(pandaSrc, /entryFinalSupertrend15m:\s*finalTrendDirection/);
  assert.match(pandaSrc, /entryFinalSupertrendSource:\s*finalTrendSource/);
  assert.match(pandaSrc, /entryFinalSupertrendReason:\s*finalTrendReason/);
  assert.match(pandaSrc, /entryFinalSupertrendAt:\s*finalTrendAt/);
  assert.match(pandaSrc, /entryFinalSupertrend15m:\s*normalizeTrackedTrendDirection\(row\.entryFinalSupertrend15m\)/);
  assert.match(pandaSrc, /entryFinalSupertrendAt:\s*Number\.isFinite\(Number\(row\.entryFinalSupertrendAt\)\)/);
  assert.match(pandaSrc, /entryCanonicalSnapshot:\s*row\?\.entryCanonicalSnapshot && typeof row\.entryCanonicalSnapshot === 'object'/);
});

test('queue and monitor consumers prefer canonical entry snapshot over scattered legacy fields', () => {
  const queueSrc = readSource('src/utils/pendingDeployQueue.js');
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(queueSrc, /function readCanonicalEntryMeta\(meta = \{\}, fallback = \{\}\)/);
  assert.match(queueSrc, /const canonicalMeta = readCanonicalEntryMeta\(meta, \{ snapshotAt: entry\.enqueuedAt \}\)/);
  assert.match(queueSrc, /const intentBin = Number\.isFinite\(Number\(canonicalMeta\.entryActiveBin\)\)/);
  assert.match(queueSrc, /const intentPrice = Number\.isFinite\(Number\(canonicalMeta\.entryPrice\)\)/);
  assert.match(pandaSrc, /function readCanonicalEntryContext\(reg = \{\}\)/);
  assert.match(pandaSrc, /const canonicalEntry = readCanonicalEntryContext\(reg\)/);
  assert.match(pandaSrc, /const entryActiveBin = canonicalEntry\.entryActiveBin/);
  assert.match(pandaSrc, /const entryPrice = canonicalEntry\.entryPrice/);
});

test('DLMM deploy logs carry anchor provenance and range adjustment observability', () => {
  const pandaSrc = readSource('src/sniper/evilPanda.js');

  assert.match(pandaSrc, /anchorSource:\s*shouldUseFrozenIntent \? 'frozen' : 'live_fallback'/);
  assert.match(pandaSrc, /anchorDriftBins:\s*Number\.isFinite\(frozenIntentDecision\?\.driftBins\)/);
  assert.match(pandaSrc, /anchorDriftPct:\s*Number\.isFinite\(frozenIntentDecision\?\.driftPct\)/);
  assert.match(pandaSrc, /anchor=\$\{debug\.anchorSource \|\| 'unknown'\}/);
  assert.match(pandaSrc, /rangeAdjust=\$\{debug\.rangeAdjustReason \|\| 'none'\}/);
  assert.match(pandaSrc, /anchor=\$\{finalArgsContext\.anchorSource \|\| 'unknown'\}/);
  assert.match(pandaSrc, /rangeAdjust=\$\{finalArgsContext\.rangeAdjustReason \|\| 'none'\}/);
});
