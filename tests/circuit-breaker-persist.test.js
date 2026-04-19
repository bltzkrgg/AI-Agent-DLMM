import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('healerAlpha emits recordCircuitBreakerEvent when SL cluster threshold is met', () => {
  const healerPath = join(repoRoot, 'src/agents/healerAlpha.js');
  const source = readFileSync(healerPath, 'utf-8');

  // Import must include recordCircuitBreakerEvent
  assert.match(source, /import\s*\{[^}]*recordCircuitBreakerEvent[^}]*\}\s*from\s*['"]\.\.\/db\/exitTracking\.js['"]/);

  // Call must be inside the circuit breaker trip block (after setRuntimeState hunter-circuit-breaker)
  assert.match(source, /recordCircuitBreakerEvent\s*\(\s*\{/);

  // Must pass poolAddress, triggeredAt, pausedUntil, slCount
  assert.match(source, /poolAddress\s*:\s*pos\.pool_address/);
  assert.match(source, /triggeredAt\s*:\s*nowCb/);
  assert.match(source, /pausedUntil\s*:\s*nowCb\s*\+\s*cbPauseMs/);
  assert.match(source, /slCount\s*:\s*recentSLEvents\.length/);
});

test('hunter circuit breaker state persists to runtime-state.json across module reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-cb-persist-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const statePath = join(repoRoot, 'src/runtime/state.js');
  const runtimeA = await importFresh(statePath);
  runtimeA.setRuntimeState('hunter-circuit-breaker', {
    pausedUntil: Date.now() + 60000,
    triggeredAt: Date.now(),
    count: 3,
  });
  await runtimeA.flushRuntimeState();

  const raw = readFileSync(process.env.BOT_RUNTIME_STATE_PATH, 'utf-8');
  assert.match(raw, /hunter-circuit-breaker/);

  // Simulate restart by importing fresh module instance.
  const runtimeB = await importFresh(statePath);
  const cb = runtimeB.getRuntimeState('hunter-circuit-breaker', null);
  assert.ok(cb);
  assert.equal(cb.count, 3);
  assert.ok(Number.isFinite(cb.pausedUntil));
});
