'use strict';

const _events = [];

export function recordExitEvent(event = {}) {
  _events.push({ ...event, ts: new Date().toISOString() });
}

export function getExitEventCount() {
  return _events.length;
}

export function recordCircuitBreakerEvent(event = {}) {
  _events.push({ type: 'circuit-breaker', ...event, ts: new Date().toISOString() });
  return { ok: true, ...event };
}
