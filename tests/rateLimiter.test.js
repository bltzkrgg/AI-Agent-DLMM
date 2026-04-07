import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/utils/rateLimiter.js';

test('RateLimiter: first acquire does not delay', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });
  const start = Date.now();
  await limiter.acquire('test.com');
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 100, `First acquire should be instant, took ${elapsed}ms`);
});

test('RateLimiter: second acquire delays based on RPM', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  // 60 RPM = 1000ms between calls
  await limiter.acquire('test.com');
  const start = Date.now();
  await limiter.acquire('test.com');
  const elapsed = Date.now() - start;

  // Should delay ~1000ms, allow ±100ms margin
  assert.ok(elapsed >= 900, `Delay too short: ${elapsed}ms`);
  assert.ok(elapsed <= 1100, `Delay too long: ${elapsed}ms`);
});

test('RateLimiter: domain-specific limits override default', async () => {
  const limiter = new RateLimiter({
    defaultRpm: 60,
    domainLimits: {
      'slow.com': 10, // 10 RPM = 6000ms between calls
    },
  });

  await limiter.acquire('slow.com');
  const start = Date.now();
  await limiter.acquire('slow.com');
  const elapsed = Date.now() - start;

  // Should delay ~6000ms
  assert.ok(elapsed >= 5900, `Delay too short for slow.com: ${elapsed}ms`);
  assert.ok(elapsed <= 6100, `Delay too long for slow.com: ${elapsed}ms`);
});

test('RateLimiter: different domains do not block each other', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  await limiter.acquire('domain-a.com');
  const startA = Date.now();
  await limiter.acquire('domain-a.com');
  const elapsedA = Date.now() - startA;

  // domain-b should not be delayed by domain-a
  const startB = Date.now();
  await limiter.acquire('domain-b.com');
  const elapsedB = Date.now() - startB;

  assert.ok(elapsedA >= 900, `domain-a delay wrong: ${elapsedA}ms`);
  assert.ok(elapsedB < 100, `domain-b should not be delayed: ${elapsedB}ms`);
});

test('RateLimiter: getRpm returns correct limit', () => {
  const limiter = new RateLimiter({
    defaultRpm: 60,
    domainLimits: {
      'api.gecko.com': 30,
      'api.coin.com': 10,
    },
  });

  assert.equal(limiter.getRpm('api.gecko.com'), 30);
  assert.equal(limiter.getRpm('api.coin.com'), 10);
  assert.equal(limiter.getRpm('api.unknown.com'), 60);
});

test('RateLimiter: getState returns bucket info', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  // Before acquire, should be null
  assert.equal(limiter.getState('test.com'), null);

  // After acquire, should return bucket
  await limiter.acquire('test.com');
  const state = limiter.getState('test.com');
  assert.ok(state !== null);
  assert.ok(typeof state.lastCallMs === 'number');
  assert.ok(state.lastCallMs > 0);
});

test('RateLimiter: reset clears specific domain', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  await limiter.acquire('domain-a.com');
  await limiter.acquire('domain-b.com');

  assert.ok(limiter.getState('domain-a.com') !== null);
  assert.ok(limiter.getState('domain-b.com') !== null);

  // Reset specific domain
  limiter.reset('domain-a.com');
  assert.equal(limiter.getState('domain-a.com'), null);
  assert.ok(limiter.getState('domain-b.com') !== null, 'Other domain should persist');
});

test('RateLimiter: reset with no args clears all domains', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  await limiter.acquire('domain-a.com');
  await limiter.acquire('domain-b.com');
  await limiter.acquire('domain-c.com');

  assert.ok(limiter.getState('domain-a.com') !== null);
  assert.ok(limiter.getState('domain-b.com') !== null);
  assert.ok(limiter.getState('domain-c.com') !== null);

  // Reset all
  limiter.reset();
  assert.equal(limiter.getState('domain-a.com'), null);
  assert.equal(limiter.getState('domain-b.com'), null);
  assert.equal(limiter.getState('domain-c.com'), null);
});

test('RateLimiter: tight spacing (sequential requests) still respects RPM', async () => {
  const limiter = new RateLimiter({ defaultRpm: 120 }); // 120 RPM = 500ms between calls

  await limiter.acquire('test.com');

  // First sequential call
  const start1 = Date.now();
  await limiter.acquire('test.com');
  const elapsed1 = Date.now() - start1;

  // Second sequential call
  const start2 = Date.now();
  await limiter.acquire('test.com');
  const elapsed2 = Date.now() - start2;

  // Each should respect ~500ms interval
  assert.ok(elapsed1 >= 400, `First delay too short: ${elapsed1}ms`);
  assert.ok(elapsed1 <= 600, `First delay too long: ${elapsed1}ms`);

  assert.ok(elapsed2 >= 400, `Second delay too short: ${elapsed2}ms`);
  assert.ok(elapsed2 <= 600, `Second delay too long: ${elapsed2}ms`);
});

test('RateLimiter: buckets with very high RPM (120) work correctly', async () => {
  const limiter = new RateLimiter({ defaultRpm: 120 }); // 500ms between calls

  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    await limiter.acquire('fast.com');
    times.push(Date.now() - start);
  }

  // First should be instant
  assert.ok(times[0] < 100, `First call should be instant: ${times[0]}ms`);

  // Second should delay ~500ms
  assert.ok(times[1] >= 400 && times[1] <= 600, `Second delay ${times[1]}ms out of range`);

  // Third should delay again (total ~1000ms from start)
  const totalElapsed = times[0] + times[1] + times[2];
  assert.ok(totalElapsed >= 900 && totalElapsed <= 1100, `Total time ${totalElapsed}ms out of range`);
});

test('RateLimiter: concurrent acquires on different domains proceed in parallel', async () => {
  const limiter = new RateLimiter({ defaultRpm: 60 });

  const start = Date.now();

  // Fire all at once
  const results = await Promise.all([
    (async () => {
      await limiter.acquire('domain-a.com');
      return Date.now() - start;
    })(),
    (async () => {
      await limiter.acquire('domain-b.com');
      return Date.now() - start;
    })(),
    (async () => {
      await limiter.acquire('domain-c.com');
      return Date.now() - start;
    })(),
  ]);

  // All should complete nearly simultaneously (first acquire has no delay)
  const maxElapsed = Math.max(...results);
  assert.ok(maxElapsed < 200, `Parallel acquires took too long: ${maxElapsed}ms`);
});
