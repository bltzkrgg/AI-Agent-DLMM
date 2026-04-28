'use strict';

import { recordCircuitBreakerEvent } from '../db/exitTracking.js';
import { getConfig } from '../config.js';

export function evaluatePositionForMaxHold(pos = {}) {
  const positionAgeMin = Math.floor((Date.now() - new Date(pos.created_at)) / 60000);
  const maxHoldMinutes = (getConfig().maxHoldHours || 2) * 60;
  const maxHoldTriggered = positionAgeMin >= maxHoldMinutes;
  let decision = 'HOLD';
  if (maxHoldTriggered) {
    decision = 'CLOSE';
  }
  const triggerCode = maxHoldTriggered ? 'MAX_HOLD_EXIT' : 'NONE';
  return { decision, triggerCode, closeReason: triggerCode, exitTrigger: triggerCode };
}

// AEGIS PRIORITY EXIT — emergency flow should delegate close to zap_out executor.
export async function aegisPriorityExit(executeTool) {
  return executeTool('zap_out');
}

export function maybeTripCircuitBreaker(pos = {}, recentSLEvents = [], cbPauseMs = 0) {
  const nowCb = Date.now();
  if (recentSLEvents.length >= 3) {
    recordCircuitBreakerEvent({
      poolAddress: pos.pool_address,
      triggeredAt: nowCb,
      pausedUntil: nowCb + cbPauseMs,
      slCount: recentSLEvents.length,
    });
    return true;
  }
  return false;
}
