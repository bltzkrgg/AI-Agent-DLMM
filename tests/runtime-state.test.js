import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('runtime state supports collection updates and deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-runtime-state-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const mod = await importFresh(join(repoRoot, 'src/runtime/state.js'));
  mod.setRuntimeState('a', 1);
  assert.equal(mod.getRuntimeState('a'), 1);

  mod.updateRuntimeCollectionItem('positions', 'p1', () => ({ peak: 10 }));
  assert.deepEqual(mod.getRuntimeCollectionItem('positions', 'p1'), { peak: 10 });

  mod.deleteRuntimeCollectionItem('positions', 'p1');
  assert.equal(mod.getRuntimeCollectionItem('positions', 'p1'), null);
});

test('runtime state can persist seen pool alert maps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-runtime-state-alerts-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const mod = await importFresh(join(repoRoot, 'src/runtime/state.js'));
  mod.setRuntimeState('seenPoolAlerts', {
    poolA: { seenAt: 111, name: 'AAA' },
    poolB: { seenAt: 222, name: 'BBB' },
  });

  const saved = mod.getRuntimeState('seenPoolAlerts', {});
  assert.deepEqual(saved, {
    poolA: { seenAt: 111, name: 'AAA' },
    poolB: { seenAt: 222, name: 'BBB' },
  });
});
