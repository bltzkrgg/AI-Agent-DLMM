import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('volume trend classifier keeps a simple 3-state soft signal', async () => {
  const mod = await importFresh(join(repoRoot, 'src/market/poolMemory.js'));

  const up = mod.classifyVolumeTrend(120, 100);
  assert.equal(up.state, 'ACCELERATING');
  assert.equal(up.priorityDelta > 0, true);

  const flat = mod.classifyVolumeTrend(104, 100);
  assert.equal(flat.state, 'STABLE');
  assert.equal(flat.priorityDelta, 0);

  const down = mod.classifyVolumeTrend(80, 100);
  assert.equal(down.state, 'DECELERATING');
  assert.equal(down.priorityDelta < 0, true);
});

test('pool memory updates previous/current volume snapshots and exposes volume trend in signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-volume-trend-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const mod = await importFresh(join(repoRoot, 'src/market/poolMemory.js'));
  const key = 'MintVolume111111111111111111111111111111111';

  mod.recordPoolDecision({
    key,
    decision: 'WATCH',
    snapshot: { taTrend: 'BULLISH', priceChangeM5: 1.1, volume24h: 100000 },
  });
  mod.recordPoolDecision({
    key,
    decision: 'WATCH',
    snapshot: { taTrend: 'BULLISH', priceChangeM5: 1.2, volume24h: 118000 },
  });

  const memory = mod.getPoolMemory(key);
  assert.equal(memory.previousVolume24h, 100000);
  assert.equal(memory.recentVolume24h, 118000);

  const signal = mod.getPoolMemorySignal(key);
  assert.equal(signal.volumeTrend.state, 'ACCELERATING');
});

test('hunter volume trend sort delta stays a ranking bias, not a deploy gate', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const source = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf8');

  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'ACCELERATING' } }), 1);
  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'DECELERATING' } }), -1);
  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'STABLE' } }), 0);

  assert.doesNotMatch(source, /volumeTrendEnabled/);
  assert.doesNotMatch(source, /VOLUME_TREND.*REJECT|REJECT.*VOLUME_TREND/);
});
