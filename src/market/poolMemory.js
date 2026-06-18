'use strict';

import { getRuntimeCollectionItem, updateRuntimeCollectionItem } from '../runtime/state.js';
import { normalizeExitReason } from '../utils/exitReasons.js';

export const POOL_MEMORY_KEY = 'lpPoolDecisionMemory';

const PROFIT_REASONS = /TAKE_PROFIT|TRAILING_STOP/i;
const LOSS_REASONS = /STOP_LOSS|OUT_OF_RANGE|POOL_IMPACT_GUARD|MANUAL_STOP|DEPLOY_FAILED/i;
const MAX_HISTORY = 12;
const LOSS_COOLDOWN_MS = 30 * 60 * 1000;
const RENT_COOLDOWN_FIRST_MS = 30 * 60 * 1000;
const RENT_COOLDOWN_REPEAT_MS = 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function normalizeKey(value = '') {
  return String(value || '').trim();
}

export function getPoolMemoryKey(input = {}) {
  if (typeof input === 'string') return normalizeKey(input);
  return normalizeKey(
    input.poolAddress ||
    input.address ||
    input.pool ||
    input.pubkey ||
    input.tokenXMint ||
    input.tokenMint ||
    input.mint ||
    ''
  );
}

function classifyOutcome({ pnlPct = 0, reason = '' } = {}) {
  const pct = Number(pnlPct);
  const text = normalizeExitReason(reason);
  if (Number.isFinite(pct) && pct > 0) return 'PROFIT';
  if (Number.isFinite(pct) && pct < 0) return 'LOSS';
  if (PROFIT_REASONS.test(text)) return 'PROFIT';
  if (LOSS_REASONS.test(text)) return 'LOSS';
  return 'BREAKEVEN';
}

function compactSnapshot(snapshot = {}) {
  return {
    trend: String(snapshot.taTrend || snapshot.trend || snapshot.recentTrend || 'UNKNOWN').toUpperCase(),
    m5: Number(snapshot.priceChangeM5 ?? snapshot.recentM5 ?? 0) || 0,
    readiness: snapshot.entryReadiness || null,
    breakout: snapshot.breakoutQuality || null,
    timing: snapshot.entryTimingState || null,
  };
}

function buildBaseMemory(existing = {}, now = nowMs()) {
  return {
    lastSeenAt: Number(existing?.lastSeenAt || 0),
    lastDecision: existing?.lastDecision || null,
    lastReason: existing?.lastReason || null,
    cooldownUntil: Number(existing?.cooldownUntil || 0),
    rentCooldownUntil: Number(existing?.rentCooldownUntil || 0),
    rentFailureCount: Number(existing?.rentFailureCount || 0),
    rentLastFailedAt: Number(existing?.rentLastFailedAt || 0),
    rentLastFailedRange: existing?.rentLastFailedRange || null,
    rentLastDetail: existing?.rentLastDetail || null,
    successCount: Number(existing?.successCount || 0),
    failureCount: Number(existing?.failureCount || 0),
    recentTrend: existing?.recentTrend || 'UNKNOWN',
    recentM5: Number(existing?.recentM5 || 0),
    lastPnLPct: Number(existing?.lastPnLPct || 0),
    lastOutcome: existing?.lastOutcome || null,
    priorityScore: Number(existing?.priorityScore || 0),
    history: Array.isArray(existing?.history) ? existing.history.slice(-MAX_HISTORY) : [],
    updatedAt: Number(existing?.updatedAt || now),
  };
}

export function getPoolMemory(input = {}) {
  const key = getPoolMemoryKey(input);
  if (!key) return null;
  return getRuntimeCollectionItem(POOL_MEMORY_KEY, key, null);
}

export function recordPoolDecision({
  pool = {},
  key = '',
  decision = 'WATCH',
  reason = '',
  source = '',
  snapshot = {},
} = {}) {
  const memoryKey = getPoolMemoryKey(key || pool);
  if (!memoryKey) return null;
  const now = nowMs();
  const compact = compactSnapshot(snapshot);

  try {
    return updateRuntimeCollectionItem(POOL_MEMORY_KEY, memoryKey, (existing) => {
      const next = buildBaseMemory(existing, now);
      next.lastSeenAt = now;
      next.lastDecision = decision;
      next.lastReason = reason;
      next.recentTrend = compact.trend;
      next.recentM5 = compact.m5;
      next.lastSnapshot = compact;
      next.lastSource = source || next.lastSource || null;
      next.updatedAt = now;
      return next;
    });
  } catch (e) {
    console.warn(`[poolMemory] record decision skipped: ${e.message}`);
    return null;
  }
}

export function recordPoolDeploy({
  pool = {},
  key = '',
  reason = 'DEPLOY',
  source = 'QUEUE',
  snapshot = {},
} = {}) {
  return recordPoolDecision({
    pool,
    key,
    decision: 'DEPLOY',
    reason,
    source,
    snapshot,
  });
}

export function recordPoolRentFailure({
  pool = {},
  key = '',
  tokenMint = '',
  poolAddress = '',
  symbol = '',
  reason = 'VETO_NON_REFUNDABLE_RENT',
  detail = '',
  rangeMin = null,
  rangeMax = null,
  snapshot = {},
  source = 'DEPLOY_RENT_GUARD',
} = {}) {
  const memoryKey = getPoolMemoryKey(key || poolAddress || pool || tokenMint);
  if (!memoryKey) return null;
  const now = nowMs();
  const compact = compactSnapshot(snapshot);

  try {
    return updateRuntimeCollectionItem(POOL_MEMORY_KEY, memoryKey, (existing) => {
      const next = buildBaseMemory(existing, now);
      const nextRentFailureCount = Math.max(0, Number(next.rentFailureCount || 0)) + 1;

      next.lastSeenAt = now;
      next.lastDecision = 'RENT_BLOCKED';
      next.lastReason = reason;
      next.lastOutcome = 'RENT_BLOCKED';
      next.recentTrend = compact.trend;
      next.recentM5 = compact.m5;
      next.rentFailureCount = nextRentFailureCount;
      next.rentCooldownUntil = 0;
      next.rentLastFailedAt = now;
      next.rentLastFailedRange = rangeMin !== null && rangeMax !== null ? `${rangeMin}-${rangeMax}` : next.rentLastFailedRange || null;
      next.rentLastDetail = detail || next.rentLastDetail || null;
      next.poolAddress = poolAddress || next.poolAddress || null;
      next.tokenMint = tokenMint || next.tokenMint || memoryKey;
      next.symbol = symbol || next.symbol || null;
      next.history = [
        ...next.history,
        {
          at: now,
          outcome: 'RENT_BLOCKED',
          reason,
          detail: detail || null,
          rangeMin,
          rangeMax,
          source,
        },
      ].slice(-MAX_HISTORY);
      next.updatedAt = now;
      return next;
    });
  } catch (e) {
    console.warn(`[poolMemory] record rent failure skipped: ${e.message}`);
    return null;
  }
}

export function recordPoolOutcome({
  pool = {},
  key = '',
  tokenMint = '',
  poolAddress = '',
  symbol = '',
  pnlPct = 0,
  pnlSol = 0,
  reason = 'CLOSE',
  snapshot = {},
} = {}) {
  const memoryKey = getPoolMemoryKey(key || poolAddress || pool || tokenMint);
  if (!memoryKey) return null;
  const now = nowMs();
  const outcome = classifyOutcome({ pnlPct, reason });
  const compact = compactSnapshot(snapshot);

  try {
    return updateRuntimeCollectionItem(POOL_MEMORY_KEY, memoryKey, (existing) => {
      const next = buildBaseMemory(existing, now);
      const isLoss = outcome === 'LOSS';
      const isProfit = outcome === 'PROFIT';
      next.lastSeenAt = now;
      next.lastDecision = 'CLOSE';
      next.lastReason = reason;
      next.lastOutcome = outcome;
      next.lastPnLPct = Number(pnlPct) || 0;
      next.lastPnLSol = Number(pnlSol) || 0;
      next.poolAddress = poolAddress || next.poolAddress || null;
      next.tokenMint = tokenMint || next.tokenMint || memoryKey;
      next.symbol = symbol || next.symbol || null;
      next.rentFailureCount = 0;
      next.rentCooldownUntil = 0;
      next.rentLastFailedAt = 0;
      next.rentLastFailedRange = null;
      next.rentLastDetail = null;
      next.recentTrend = compact.trend;
      next.recentM5 = compact.m5;
      next.successCount = isProfit ? next.successCount + 1 : next.successCount;
      next.failureCount = isLoss ? next.failureCount + 1 : Math.max(0, next.failureCount - 1);
      next.priorityScore = Math.max(-100, Math.min(100, next.priorityScore + (isProfit ? 18 : isLoss ? -30 : 0)));
      next.cooldownUntil = isLoss && next.failureCount >= 2 ? now + LOSS_COOLDOWN_MS : next.cooldownUntil;
      if (isProfit && next.cooldownUntil < now) next.cooldownUntil = 0;
      next.history = [
        ...next.history,
        {
          at: now,
          outcome,
          pnlPct: Number(pnlPct) || 0,
          pnlSol: Number(pnlSol) || 0,
          reason,
        },
      ].slice(-MAX_HISTORY);
      next.updatedAt = now;
      return next;
    });
  } catch (e) {
    console.warn(`[poolMemory] record outcome skipped: ${e.message}`);
    return null;
  }
}

export function getPoolMemorySignal(input = {}, now = nowMs()) {
  const startedAt = nowMs();
  const memory = getPoolMemory(input);
  const lookupMs = Math.max(0, nowMs() - startedAt);
  if (!memory) {
    return {
      memory: null,
      cooldownActive: false,
      cooldownUntil: 0,
      priorityDelta: 0,
      lookupMs,
      reason: 'NO_MEMORY',
    };
  }

  const rentCooldownUntil = Number(memory.rentCooldownUntil || 0);
  const cooldownUntil = Number(memory.cooldownUntil || 0);
  const rentCooldownActive = false;
  const genericCooldownActive = cooldownUntil > now;
  const cooldownActive = genericCooldownActive;
  const priorityScore = Number(memory.priorityScore || 0);
  const successCount = Number(memory.successCount || 0);
  const failureCount = Number(memory.failureCount || 0);
  const priorityDelta = cooldownActive
    ? -120
    : Math.max(-80, Math.min(80, priorityScore + (successCount * 8) - (failureCount * 12)));

  return {
    memory,
    cooldownActive,
    cooldownUntil,
    rentCooldownActive,
    rentCooldownUntil: 0,
    priorityDelta,
    lookupMs,
    reason: genericCooldownActive
        ? `POOL_MEMORY_COOLDOWN_${Math.ceil((cooldownUntil - now) / 60000)}m`
      : Number(memory.rentFailureCount || 0) > 0
        ? `POOL_NON_REFUNDABLE_FEE_HISTORY_${Number(memory.rentFailureCount || 0)}`
      : `POOL_MEMORY_DELTA_${priorityDelta}`,
  };
}

export function evaluatePoolReentryDiscipline({
  pool = {},
  entrySignals = {},
  now = nowMs(),
} = {}) {
  const signal = getPoolMemorySignal(pool, now);
  const memory = signal.memory || null;
  if (!memory) {
    return {
      allowed: true,
      reason: 'NO_MEMORY',
      signal,
    };
  }

  if (signal.cooldownActive) {
    return {
      allowed: false,
      reason: signal.reason || 'POOL_MEMORY_COOLDOWN',
      signal,
    };
  }

  const lastOutcome = String(memory.lastOutcome || '').toUpperCase();
  const lastDecision = String(memory.lastDecision || '').toUpperCase();
  if (lastDecision !== 'CLOSE' || lastOutcome !== 'LOSS') {
    return {
      allowed: true,
      reason: signal.reason || 'NO_RECENT_LOSS',
      signal,
    };
  }

  const trend = String(entrySignals.taTrend || '').toUpperCase();
  const timing = String(entrySignals.entryTimingState || '').toUpperCase();
  const readiness = String(entrySignals.entryReadiness || '').toUpperCase();
  const breakout = String(entrySignals.breakoutQuality || '').toUpperCase();
  const m15 = Number(entrySignals.priceChangeM15);
  const isFreshHealthySetup =
    trend === 'BULLISH' &&
    ['LP_LIVE', 'BREAKOUT', 'ATH_BREAK'].includes(timing) &&
    readiness === 'HIGH' &&
    ['VALID', 'STRONG'].includes(breakout) &&
    Number.isFinite(m15) &&
    m15 > 0;

  return {
    allowed: isFreshHealthySetup,
    reason: isFreshHealthySetup
      ? 'RECENT_LOSS_RESET_BY_FRESH_MOMENTUM'
      : `REENTRY_WAIT_AFTER_LOSS_${memory.lastPnLPct > 0 ? '+' : ''}${Number(memory.lastPnLPct || 0).toFixed(2)}%`,
    signal,
    memory,
  };
}
