/**
 * src/safety/gasGuard.js — Stub (Linear Sniper RPC-First)
 *
 * Gas guard dinonaktifkan di arsitektur RPC-First.
 * Semua fungsi return no-op / pass-through agar solana/jupiter.js
 * dan solana/meteora.js tidak crash saat import.
 */

'use strict';

/** Stub — selalu izinkan, tidak ada gas tracking */
export function checkGasGuard() {
  return { allowed: true, reason: null };
}

export function recordPriorityFee(/* sol */) {
  // no-op — RPC-First tidak track priority fee secara lokal
}

export function recordTxFailure(/* reason */) {
  // no-op
}

export function recordTxSuccess() {
  // no-op
}

export function getGasGuardStatus() {
  return {
    allowed: true,
    spentPriorityFeeSol: 0,
    capSol: Infinity,
    txFailStreak: 0,
    inCooldown: false,
    cooldownRemainingMin: 0,
    lastFailureReason: null,
  };
}

export function resetDailyGasGuard() {
  // no-op
}
