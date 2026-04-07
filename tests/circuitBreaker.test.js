import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/safety/circuitBreaker.js';

test('CircuitBreaker: initial state is CLOSED', () => {
  const cb = new CircuitBreaker({ autoStart: false });
  assert.equal(cb.state, 'CLOSED');
  assert.equal(cb.isHealthy(), true);
});

test('CircuitBreaker: transitions to OPEN after 3 errors within window', async () => {
  let tripCalled = false;
  const cb = new CircuitBreaker({
    autoStart: false,
    onTrip: () => { tripCalled = true; },
    errorThreshold: 3,
  });

  cb.recordError('provider1', new Error('Error 1'));
  cb.recordError('provider1', new Error('Error 2'));
  assert.equal(cb.state, 'CLOSED', 'Still CLOSED after 2 errors');
  assert.equal(tripCalled, false);

  cb.recordError('provider1', new Error('Error 3'));
  assert.equal(cb.state, 'OPEN', 'Should be OPEN after 3 errors');
  assert.equal(cb.isHealthy(), false);
  assert.equal(tripCalled, true, 'onTrip callback should be called');
});

test('CircuitBreaker: errors outside window do not accumulate', async () => {
  const cb = new CircuitBreaker({
    autoStart: false,
    errorThreshold: 3,
    errorWindow: 100,
  });

  cb.recordError('provider1', new Error('Error 1'));
  cb.recordError('provider1', new Error('Error 2'));
  assert.equal(cb.state, 'CLOSED');

  // Wait for window to expire
  await new Promise(r => setTimeout(r, 150));

  cb.recordError('provider1', new Error('Error 3'));
  assert.equal(cb.state, 'CLOSED', 'Should still be CLOSED — window expired');
});

test('CircuitBreaker: high latency (p95 > threshold) triggers OPEN', () => {
  let tripCalled = false;
  const cb = new CircuitBreaker({
    autoStart: false,
    onTrip: () => { tripCalled = true; },
    latencyThreshold: 5000,
  });

  // Record latencies that push p95 above threshold
  cb.recordLatency('api', 3000);
  cb.recordLatency('api', 4000);
  cb.recordLatency('api', 5000);
  cb.recordLatency('api', 6000);
  cb.recordLatency('api', 7000);
  cb.recordLatency('api', 8000);
  cb.recordLatency('api', 9000);
  cb.recordLatency('api', 10000);
  cb.recordLatency('api', 10000);
  cb.recordLatency('api', 10000);

  assert.equal(cb.state, 'OPEN', 'Should open due to high p95 latency');
  assert.equal(tripCalled, true);
});

test('CircuitBreaker: OPEN → HALF_OPEN on performHealthCheck', async () => {
  const cb = new CircuitBreaker({ autoStart: false });

  // Force to OPEN state
  cb.recordError('provider1', new Error('E1'));
  cb.recordError('provider1', new Error('E2'));
  cb.recordError('provider1', new Error('E3'));
  assert.equal(cb.state, 'OPEN');

  // Perform health check
  await cb.performHealthCheck();
  assert.equal(cb.state, 'HALF_OPEN', 'Should transition to HALF_OPEN');
});

test('CircuitBreaker: HALF_OPEN → CLOSED on 3 consecutive health check successes', async () => {
  let recoverCalled = false;
  const cb = new CircuitBreaker({
    autoStart: false,
    onRecover: () => { recoverCalled = true; },
    recoverySuccessThreshold: 3,
  });

  // Force to HALF_OPEN
  cb.recordError('provider1', new Error('E1'));
  cb.recordError('provider1', new Error('E2'));
  cb.recordError('provider1', new Error('E3'));
  await cb.performHealthCheck();
  assert.equal(cb.state, 'HALF_OPEN');

  // Record 3 health check successes
  cb.recordHealthCheckSuccess();
  assert.equal(cb.state, 'HALF_OPEN', 'Still HALF_OPEN after 1 success');

  cb.recordHealthCheckSuccess();
  assert.equal(cb.state, 'HALF_OPEN', 'Still HALF_OPEN after 2 successes');

  cb.recordHealthCheckSuccess();
  assert.equal(cb.state, 'CLOSED', 'Should transition to CLOSED after 3 successes');
  assert.equal(cb.isHealthy(), true);
  assert.equal(recoverCalled, true, 'onRecover callback should be called');
});

test('CircuitBreaker: HALF_OPEN → OPEN on health check failure', async () => {
  const cb = new CircuitBreaker({ autoStart: false });

  // Force to HALF_OPEN
  cb.recordError('provider1', new Error('E1'));
  cb.recordError('provider1', new Error('E2'));
  cb.recordError('provider1', new Error('E3'));
  await cb.performHealthCheck();
  assert.equal(cb.state, 'HALF_OPEN');

  // Record failure
  cb.recordHealthCheckFailure();
  assert.equal(cb.state, 'OPEN', 'Should return to OPEN after health check failure');
});

test('CircuitBreaker: does not double-trip (idempotent)', () => {
  let tripCount = 0;
  const cb = new CircuitBreaker({
    autoStart: false,
    onTrip: () => { tripCount++; },
    errorThreshold: 2,
  });

  cb.recordError('provider1', new Error('E1'));
  cb.recordError('provider1', new Error('E2'));
  assert.equal(cb.state, 'OPEN');
  assert.equal(tripCount, 1);

  // Try to trip again (should not trigger another onTrip)
  cb.recordError('provider1', new Error('E3'));
  assert.equal(cb.state, 'OPEN');
  assert.equal(tripCount, 1, 'onTrip should only be called once');
});

test('CircuitBreaker: getState returns correct metrics', () => {
  const cb = new CircuitBreaker({ autoStart: false });

  cb.recordError('api', new Error('Test error'));
  cb.recordLatency('api', 1000);
  cb.recordLatency('api', 2000);

  const state = cb.getState();
  assert.equal(state.state, 'CLOSED');
  assert.equal(state.errorCount >= 1, true);
  assert.equal(typeof state.tripReason, 'object'); // initially null
});

test('CircuitBreaker: getMetrics returns summary', () => {
  const cb = new CircuitBreaker({ autoStart: false });

  cb.recordError('api1', new Error('Error 1'));
  cb.recordLatency('api1', 1500);
  cb.recordLatency('api2', 2500);

  const metrics = cb.getMetrics();
  assert.equal(metrics.state, 'CLOSED');
  assert.equal(metrics.healthy, true);
  assert.equal(typeof metrics.recentErrors, 'number');
  assert.equal(typeof metrics.maxRecentLatencyMs, 'number');
});

test('CircuitBreaker: reset clears state', async () => {
  const cb = new CircuitBreaker({ autoStart: false });

  // Accumulate errors
  cb.recordError('provider1', new Error('E1'));
  cb.recordError('provider1', new Error('E2'));
  cb.recordError('provider1', new Error('E3'));
  assert.equal(cb.state, 'OPEN');

  // Reset
  await cb.reset();
  assert.equal(cb.state, 'CLOSED');
  assert.equal(cb.isHealthy(), true);
});
