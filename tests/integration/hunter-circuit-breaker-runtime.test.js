import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('runtime: runHunterAlpha exits early when CIRCUIT_BREAKER_ACTIVE is set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-hunter-cb-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const stateMod = await importFresh(join(repoRoot, 'src/runtime/state.js'));
  const hunterMod = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  stateMod.setRuntimeState('hunter-circuit-breaker', {
    pausedUntil: Date.now() + 5 * 60 * 1000,
    count: 3,
  });
  await stateMod.flushRuntimeState();

  const msgs = [];
  await hunterMod.runHunterAlpha(async (m) => {
    msgs.push(String(m));
    return { message_id: 1 };
  });

  assert.ok(msgs.length > 0, 'hunter should emit paused notification');
  assert.ok(
    msgs.some((m) => /Circuit Breaker Active/i.test(m)),
    'notification should mention active circuit breaker'
  );
});
