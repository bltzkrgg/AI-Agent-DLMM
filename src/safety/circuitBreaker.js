/**
 * Circuit Breaker — Safety mechanism to pause trading on system degradation
 *
 * States:
 *   CLOSED (healthy) → normal operation
 *   OPEN (degraded) → trading paused, alerts sent
 *   HALF_OPEN (recovering) → test health before resuming
 *
 * Triggers:
 *   - Error rate spike (3+ errors in 5 min window)
 *   - API latency high (p95 > 5s sustained)
 *   - Provider health failure (all providers down)
 */

const logger = console;

export class CircuitBreaker {
  constructor(config = {}) {
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.errorThreshold = config.errorThreshold || 3;  // errors in window
    this.errorWindow = config.errorWindow || 5 * 60 * 1000; // 5 min
    this.latencyThreshold = config.latencyThreshold || 5000; // ms
    this.latencyWindow = config.latencyWindow || 5 * 60 * 1000; // 5 min
    this.healthCheckInterval = config.healthCheckInterval || 30000; // 30s
    this.recoverySuccessThreshold = config.recoverySuccessThreshold || 3; // consecutive successes

    this.errorBucket = []; // [{provider, time, err}]
    this.latencyBucket = []; // [{provider, time, ms}]
    this.tripTime = null;
    this.tripReason = null;
    this.recoverySuccessCount = 0;
    this.halfOpenSince = null;
    this.halfOpenTimeoutMs = config.halfOpenTimeoutMs || 10 * 60 * 1000; // 10 min auto-reset

    // Callbacks for bot notifications
    this.onTrip = config.onTrip || (() => {});
    this.onRecover = config.onRecover || (() => {});
    this.onHealthCheck = config.onHealthCheck || (() => {});

    // Start periodic health checks
    if (config.autoStart !== false) {
      this.startHealthChecks();
    }
  }

  // ──── Error recording ────────────────────────────────────────────

  recordError(provider, err) {
    this.errorBucket.push({
      provider,
      time: Date.now(),
      message: err.message,
    });

    // Cleanup old errors
    const cutoff = Date.now() - this.errorWindow;
    this.errorBucket = this.errorBucket.filter(e => e.time > cutoff);

    logger.warn(`⚠️ CB error: ${provider} — ${err.message} (${this.errorBucket.length}/${this.errorThreshold})`);

    // Check if threshold exceeded
    if (this.errorBucket.length >= this.errorThreshold) {
      this.trip(`High error rate: ${this.errorBucket.length} errors in ${this.errorWindow / 1000}s`);
    }
  }

  // ──── Latency recording ──────────────────────────────────────────

  recordLatency(provider, ms) {
    this.latencyBucket.push({
      provider,
      time: Date.now(),
      ms,
    });

    // Cleanup old latencies
    const cutoff = Date.now() - this.latencyWindow;
    this.latencyBucket = this.latencyBucket.filter(l => l.time > cutoff);

    // Calculate p95 latency
    const latencies = this.latencyBucket.map(l => l.ms).sort((a, b) => a - b);
    if (latencies.length > 0) {
      const p95idx = Math.floor(latencies.length * 0.95);
      const p95 = latencies[Math.min(p95idx, latencies.length - 1)];

      if (p95 > this.latencyThreshold && this.state === 'CLOSED') {
        this.trip(`High latency: p95=${p95.toFixed(0)}ms > ${this.latencyThreshold}ms`);
      }
    }
  }

  // ──── State management ───────────────────────────────────────────

  trip(reason) {
    if (this.state !== 'CLOSED') return; // Already open or half-open

    this.state = 'OPEN';
    this.tripTime = Date.now();
    this.tripReason = reason;
    this.recoverySuccessCount = 0;

    logger.error(`🚨 CIRCUIT BREAKER TRIPPED: ${reason}`);
    this.onTrip({
      reason,
      tripTime: this.tripTime,
      errorBucket: this.errorBucket,
      latencyBucket: this.latencyBucket,
    });
  }

  async reset() {
    if (this.state === 'CLOSED') return;

    this.state = 'CLOSED';
    this.errorBucket = [];
    this.latencyBucket = [];
    this.recoverySuccessCount = 0;

    logger.info(`✅ CIRCUIT BREAKER RESET: System recovered`);
    this.onRecover({
      recoveryTime: Date.now(),
      timeOpenMs: Date.now() - this.tripTime,
    });
  }

  // ──── Health checks ──────────────────────────────────────────────

  startHealthChecks() {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, this.healthCheckInterval);
  }

  async performHealthCheck() {
    if (this.state === 'CLOSED') {
      // Periodic status check even when healthy
      const metrics = this.getMetrics();
      this.onHealthCheck({ state: 'CLOSED', metrics });
      return;
    }

    if (this.state === 'OPEN') {
      logger.log('CB: Attempting recovery (HALF_OPEN)...');
      this.state = 'HALF_OPEN';
      this.halfOpenSince = Date.now();
      return;
    }

    if (this.state === 'HALF_OPEN') {
      // Auto-recover if HALF_OPEN for longer than timeout with no new failures recorded
      const halfOpenAge = Date.now() - (this.halfOpenSince || Date.now());
      if (halfOpenAge >= this.halfOpenTimeoutMs) {
        logger.log(`CB: HALF_OPEN timeout reached (${Math.round(halfOpenAge / 1000)}s) — auto-resetting`);
        await this.reset();
      }
    }
  }

  recordHealthCheckSuccess() {
    if (this.state !== 'HALF_OPEN') return;

    this.recoverySuccessCount++;
    logger.log(`CB: Recovery progress (${this.recoverySuccessCount}/${this.recoverySuccessThreshold})`);

    if (this.recoverySuccessCount >= this.recoverySuccessThreshold) {
      this.reset();
    }
  }

  recordHealthCheckFailure() {
    if (this.state === 'HALF_OPEN') {
      logger.warn('CB: Health check failed, remaining OPEN');
      this.state = 'OPEN';
      this.recoverySuccessCount = 0;
      this.halfOpenSince = null;
    }
  }

  // ──── Public API ─────────────────────────────────────────────────

  isHealthy() {
    return this.state === 'CLOSED';
  }

  isOpen() {
    return this.state === 'OPEN';
  }

  isHalfOpen() {
    return this.state === 'HALF_OPEN';
  }

  getState() {
    return {
      state: this.state,
      tripTime: this.tripTime,
      tripReason: this.tripReason,
      timeOpenMs: this.state !== 'CLOSED' ? Date.now() - this.tripTime : 0,
      errorCount: this.errorBucket.length,
      latencyCount: this.latencyBucket.length,
      recoveryProgress: this.recoverySuccessCount,
    };
  }

  getMetrics() {
    return {
      state: this.state,
      healthy: this.isHealthy(),
      uptime: this.tripTime ? Date.now() - this.tripTime : null,
      tripReason: this.tripReason,
      recentErrors: this.errorBucket.length,
      recentLatencies: this.latencyBucket.length,
      maxRecentLatencyMs: this.latencyBucket.length > 0
        ? Math.max(...this.latencyBucket.map(l => l.ms))
        : 0,
    };
  }

  // ──── Cleanup ────────────────────────────────────────────────────

  destroy() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }
}

export default CircuitBreaker;
