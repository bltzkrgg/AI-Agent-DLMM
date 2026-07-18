'use strict';

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function evaluatePositionExitPolicy({
  pnlPct = 0,
  hwmPct = 0,
  deployedAt = null,
  nowMs = Date.now(),
  stopLossPct = 0,
  maxHoldHours = 0,
  takeProfitPct = 0,
  trailingTriggerPct = 0,
  trailingDropPct = 0,
} = {}) {
  const currentPnlPct = finiteNumber(pnlPct, 0);
  const nextHwmPct = Math.max(finiteNumber(hwmPct, 0), currentPnlPct);
  const openedAtMs = deployedAt ? new Date(deployedAt).getTime() : NaN;
  const ageMs = Number.isFinite(openedAtMs) ? Math.max(0, nowMs - openedAtMs) : 0;
  const safeStopLossPct = Math.max(0, finiteNumber(stopLossPct, 0));
  const safeMaxHoldHours = Math.max(0, finiteNumber(maxHoldHours, 0));
  const safeTakeProfitPct = Math.max(0, finiteNumber(takeProfitPct, 0));
  const safeTrailingTriggerPct = Math.max(0, finiteNumber(trailingTriggerPct, 0));
  const safeTrailingDropPct = Math.max(0, finiteNumber(trailingDropPct, 0));

  if (safeStopLossPct > 0 && currentPnlPct <= -safeStopLossPct) {
    return {
      action: 'STOP_LOSS',
      nextHwmPct,
      ageMs,
      reason: `Hard SL: PnL=${currentPnlPct.toFixed(2)}% <= -${safeStopLossPct.toFixed(2)}%`,
    };
  }

  const maxHoldMs = safeMaxHoldHours * 60 * 60 * 1000;
  if (maxHoldMs > 0 && ageMs >= maxHoldMs) {
    return {
      action: 'MAX_HOLD',
      nextHwmPct,
      ageMs,
      reason: `Max hold: age=${(ageMs / 3_600_000).toFixed(2)}h >= ${safeMaxHoldHours.toFixed(2)}h`,
    };
  }

  if (safeTakeProfitPct > 0 && currentPnlPct >= safeTakeProfitPct) {
    return {
      action: 'TAKE_PROFIT',
      scenario: 'TRAILING_STOP_PCT',
      nextHwmPct,
      ageMs,
      reason: `Primary TP target hit: PnL=${currentPnlPct.toFixed(2)}% >= ${safeTakeProfitPct.toFixed(2)}%`,
    };
  }

  const trailingArmed = safeTrailingTriggerPct > 0 && nextHwmPct >= safeTrailingTriggerPct;
  const trailingDrawdownPct = nextHwmPct - currentPnlPct;
  if (trailingArmed && safeTrailingDropPct > 0 && trailingDrawdownPct >= safeTrailingDropPct) {
    return {
      action: 'TAKE_PROFIT',
      scenario: 'TRAILING',
      nextHwmPct,
      ageMs,
      trailingArmed,
      trailingDrawdownPct,
      reason:
        `Fallback trailing TP: HWM=${nextHwmPct.toFixed(2)}% retraced ` +
        `${trailingDrawdownPct.toFixed(2)}% >= ${safeTrailingDropPct.toFixed(2)}%`,
    };
  }

  return {
    action: 'HOLD',
    nextHwmPct,
    ageMs,
    trailingArmed,
    trailingDrawdownPct,
    reason: 'Position exit thresholds not triggered',
  };
}
