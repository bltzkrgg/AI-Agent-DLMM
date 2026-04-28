'use strict';

export class CircuitBreaker {
  constructor({
    autoStart = true,
    onTrip = null,
    onRecover = null,
    errorThreshold = 3,
    errorWindow = 60_000,
    latencyThreshold = 5_000,
    recoverySuccessThreshold = 3,
  } = {}) {
    this.state = 'CLOSED';
    this.onTrip = onTrip;
    this.onRecover = onRecover;
    this.errorThreshold = errorThreshold;
    this.errorWindow = errorWindow;
    this.latencyThreshold = latencyThreshold;
    this.recoverySuccessThreshold = recoverySuccessThreshold;
    this.errors = [];
    this.latencies = [];
    this.healthSuccesses = 0;
    this.tripReason = null;
    this.autoStart = autoStart;
  }

  isHealthy() {
    return this.state === 'CLOSED';
  }

  recordError(provider, error) {
    const now = Date.now();
    this.errors.push({ provider, ts: now, msg: String(error?.message || error || 'error') });
    this.errors = this.errors.filter((e) => now - e.ts <= this.errorWindow);
    if (this.state === 'CLOSED' && this.errors.length >= this.errorThreshold) {
      this.trip('ERROR_THRESHOLD');
    }
  }

  recordLatency(provider, ms) {
    const now = Date.now();
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return;
    this.latencies.push({ provider, ts: now, ms: value });
    this.latencies = this.latencies.slice(-200);
    if (this.state !== 'CLOSED') return;
    const values = this.latencies.map((x) => x.ms).sort((a, b) => a - b);
    if (values.length < 5) return;
    const idx = Math.min(values.length - 1, Math.floor(values.length * 0.95));
    const p95 = values[idx];
    if (p95 > this.latencyThreshold) this.trip('LATENCY_P95');
  }

  trip(reason) {
    if (this.state === 'OPEN') return;
    this.state = 'OPEN';
    this.tripReason = { reason, at: Date.now() };
    this.healthSuccesses = 0;
    this.onTrip?.(this.tripReason);
  }

  async performHealthCheck() {
    if (this.state === 'OPEN') {
      this.state = 'HALF_OPEN';
      this.healthSuccesses = 0;
    }
    return this.state;
  }

  isHalfOpen() {
    return this.state === 'HALF_OPEN';
  }

  recordHealthCheckSuccess() {
    if (this.state !== 'HALF_OPEN') return;
    this.healthSuccesses += 1;
    if (this.healthSuccesses >= this.recoverySuccessThreshold) {
      this.state = 'CLOSED';
      this.tripReason = null;
      this.errors = [];
      this.healthSuccesses = 0;
      this.onRecover?.();
    }
  }

  recordHealthCheckFailure() {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.healthSuccesses = 0;
    }
  }

  getState() {
    return {
      state: this.state,
      errorCount: this.errors.length,
      tripReason: this.tripReason,
    };
  }

  getMetrics() {
    const latencies = this.latencies.map((x) => x.ms);
    return {
      state: this.state,
      healthy: this.isHealthy(),
      recentErrors: this.errors.length,
      maxRecentLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    };
  }

  async reset() {
    this.state = 'CLOSED';
    this.errors = [];
    this.latencies = [];
    this.healthSuccesses = 0;
    this.tripReason = null;
  }
}

