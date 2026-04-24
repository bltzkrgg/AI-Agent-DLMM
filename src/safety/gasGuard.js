import { getConfig } from '../config.js';
import { getRuntimeState, setRuntimeState } from '../runtime/state.js';
import { safeNum } from '../utils/safeJson.js';

const GAS_GUARD_KEY = 'tx-gas-guard';

function getTodayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getDefaultState() {
  return {
    date: getTodayStr(),
    spentPriorityFeeSol: 0,
    txFailStreak: 0,
    cooldownUntil: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    lastFailureReason: null,
  };
}

function loadState() {
  const base = { ...getDefaultState(), ...(getRuntimeState(GAS_GUARD_KEY, {}) || {}) };
  const today = getTodayStr();
  if (base.date !== today) {
    base.date = today;
    base.spentPriorityFeeSol = 0;
    base.txFailStreak = 0;
    base.cooldownUntil = 0;
    base.lastFailureAt = 0;
    base.lastFailureReason = null;
  }
  base.spentPriorityFeeSol = Math.max(0, safeNum(base.spentPriorityFeeSol));
  base.txFailStreak = Math.max(0, Math.floor(safeNum(base.txFailStreak)));
  base.cooldownUntil = Math.max(0, safeNum(base.cooldownUntil));
  return base;
}

function saveState(state) {
  setRuntimeState(GAS_GUARD_KEY, state);
}

export function estimatePriorityFeeSol({
  microLamports = 0,
  computeUnits = 0,
  priorityFeeLamports = 0,
  jitoTipLamports = 0,
} = {}) {
  const baseLamports = Math.max(0, Math.floor(safeNum(priorityFeeLamports)));
  const tipLamports = Math.max(0, Math.floor(safeNum(jitoTipLamports)));
  const micro = Math.max(0, safeNum(microLamports));
  const units = Math.max(0, safeNum(computeUnits));
  const computeLamports = Math.ceil((micro * units) / 1_000_000);
  const totalLamports = baseLamports + tipLamports + computeLamports;
  return totalLamports / 1e9;
}

export function checkAndConsumePriorityFeeBudget({ estimatedSol = 0, context = 'tx' } = {}) {
  const cfg = getConfig();
  const state = loadState();
  const now = Date.now();
  const cap = Math.max(0, safeNum(cfg.maxDailyPriorityFeeSol ?? 0.2));

  if (state.cooldownUntil > now) {
    const waitMin = Math.ceil((state.cooldownUntil - now) / 60000);
    return {
      allowed: false,
      reason: `TX_FAIL_COOLDOWN_ACTIVE_${waitMin}m`,
      state,
    };
  }

  const spend = Math.max(0, safeNum(estimatedSol));
  if (spend > 0 && state.spentPriorityFeeSol + spend > cap) {
    return {
      allowed: false,
      reason: `DAILY_PRIORITY_FEE_CAP_EXCEEDED (${(state.spentPriorityFeeSol + spend).toFixed(4)} > ${cap.toFixed(4)} SOL)`,
      state,
    };
  }

  if (spend > 0) {
    state.spentPriorityFeeSol += spend;
    saveState(state);
    console.log(`[gas-guard] reserved ${spend.toFixed(6)} SOL for ${context} | used=${state.spentPriorityFeeSol.toFixed(6)} SOL`);
  }

  return { allowed: true, reason: null, state };
}

export function recordTxFailure({ context = 'tx', error = null } = {}) {
  const cfg = getConfig();
  const state = loadState();
  const now = Date.now();
  const maxStreak = Math.max(1, Math.floor(safeNum(cfg.maxTxFailStreak ?? 8)));
  const cooldownMin = Math.max(1, Math.floor(safeNum(cfg.txFailCooldownMinutes ?? 20)));

  state.txFailStreak = Math.max(0, state.txFailStreak) + 1;
  state.lastFailureAt = now;
  state.lastFailureReason = String(error?.message || error || 'unknown_error').slice(0, 220);
  if (state.txFailStreak >= maxStreak) {
    state.cooldownUntil = now + (cooldownMin * 60 * 1000);
    console.warn(`[gas-guard] cooldown triggered by ${context}: failStreak=${state.txFailStreak}, cooldown=${cooldownMin}m`);
  }
  saveState(state);
}

export function recordTxSuccess({ context = 'tx' } = {}) {
  const state = loadState();
  state.txFailStreak = 0;
  state.cooldownUntil = 0;
  state.lastFailureReason = null;
  state.lastSuccessAt = Date.now();
  saveState(state);
  console.log(`[gas-guard] success ${context}, fail streak reset`);
}

export function getGasGuardStatus() {
  const cfg = getConfig();
  const state = loadState();
  const cap = Math.max(0, safeNum(cfg.maxDailyPriorityFeeSol ?? 0.2));
  const now = Date.now();
  const cooldownRemainingMs = Math.max(0, state.cooldownUntil - now);
  return {
    ...state,
    capSol: cap,
    remainingSol: Math.max(0, cap - state.spentPriorityFeeSol),
    inCooldown: cooldownRemainingMs > 0,
    cooldownRemainingMin: cooldownRemainingMs > 0 ? Math.ceil(cooldownRemainingMs / 60000) : 0,
  };
}
