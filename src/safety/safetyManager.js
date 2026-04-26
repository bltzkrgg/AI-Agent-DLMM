/**
 * src/safety/safetyManager.js — Stub (Linear Sniper RPC-First)
 *
 * Safety manager dinonaktifkan. Semua gate return PASS agar
 * hunterAlpha.js dan app/executionPolicy.js tidak crash.
 *
 * Di arsitektur Linear Sniper, safety logic dilakukan langsung
 * via on-chain state check (RPC) bukan via local state machine.
 */

'use strict';

export function checkStopLoss(/* position, cfg */) {
  return { triggered: false, reason: null };
}

export function checkMaxDrawdown(/* cfg */) {
  return { exceeded: false, reason: null };
}

export function recordPnlUsd(/* pnlUsd, feesUsd */) {
  // no-op — PnL tracking via database.js in-memory
}

export function getSafetyStatus() {
  return {
    circuitOpen: false,
    dailyLossExceeded: false,
    drawdownExceeded: false,
    reason: null,
  };
}

export async function requestConfirmation(/* prompt, timeoutMs */) {
  // RPC-First: tidak ada manual confirmation gate — selalu proceed
  return true;
}

export function validateStrategyForMarket(/* strategy, market */) {
  return { valid: true, reason: null };
}

export function resetDailyLoss() {
  // no-op
}
