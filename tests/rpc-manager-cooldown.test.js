import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcManager } from '../src/providers/rpcProvider.js';

function makeStubProvider(name, fn) {
  return {
    name,
    healthy: true,
    lastError: null,
    errorCount: 0,
    successCount: 0,
    async call(method, params, timeoutMs) {
      return fn(method, params, timeoutMs);
    },
  };
}

test('RpcManager cooldown skips failing provider temporarily', async () => {
  const manager = new RpcManager({ helius: 'dummy-key' });
  manager.providerFailStreakToCooldown = 1;
  manager.providerCooldownMs = 60_000;

  let aCalls = 0;
  let bCalls = 0;

  const providerA = makeStubProvider('ProviderA', async () => {
    aCalls += 1;
    throw new Error('Timeout');
  });
  const providerB = makeStubProvider('ProviderB', async () => {
    bCalls += 1;
    return { ok: true, from: 'B' };
  });

  manager.providers = [providerA, providerB];

  const first = await manager.call('getSlot', [], 1000);
  assert.equal(first.from, 'B');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);

  // ProviderA should now be cooling down and skipped.
  const second = await manager.call('getSlot', [], 1000);
  assert.equal(second.from, 'B');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 2);

  const m = manager.getMetrics();
  const aMetric = m.providers.find(p => p.name === 'ProviderA');
  assert.equal(aMetric.cooldownRemainingMs > 0, true);
  assert.equal(aMetric.failStreak >= 1, true);
});

test('RpcManager returns stale cache if all providers fail after cache expiry', async () => {
  const manager = new RpcManager({ helius: 'dummy-key' });
  manager.cacheExpiry = -1; // force cache path to be stale immediately

  let callCount = 0;
  const providerA = makeStubProvider('ProviderA', async () => {
    callCount += 1;
    if (callCount === 1) return { balance: 123 };
    throw new Error('RPC down');
  });
  manager.providers = [providerA];

  const first = await manager.call('getBalance', ['wallet'], 1000);
  assert.equal(first.balance, 123);

  const second = await manager.call('getBalance', ['wallet'], 1000);
  assert.equal(second.balance, 123); // stale cached fallback
  assert.equal(callCount, 2);
});

