'use strict';

const DEFAULTS = {
  poolImpactGuardEnabled: false,
  poolImpactPriceDropWarnPct: 2.5,
  poolImpactPriceDropPreExitPct: 4,
  poolImpactPriceDropForceExitPct: 6,
  poolImpactConsecutiveDropTicks: 3,
  poolImpactLowerRangeBufferPct: 15,
};

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctDrop(from, to) {
  const start = finiteNumber(from);
  const end = finiteNumber(to);
  if (start === null || end === null || start <= 0) return 0;
  return Math.max(0, ((start - end) / start) * 100);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function countConsecutiveDownTicks(recentSamples = []) {
  if (!Array.isArray(recentSamples) || recentSamples.length < 2) return 0;
  let count = 0;
  for (let i = recentSamples.length - 1; i > 0; i--) {
    const current = finiteNumber(recentSamples[i]?.activeBin);
    const previous = finiteNumber(recentSamples[i - 1]?.activeBin);
    if (current === null || previous === null || current >= previous) break;
    count++;
  }
  return count;
}

export function evaluatePoolImpactGuard({
  entryActiveBin,
  currentActiveBin,
  previousActiveBin,
  entryPrice,
  currentPrice,
  previousPrice,
  lowerBin,
  upperBin,
  recentSamples = [],
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (cfg.poolImpactGuardEnabled === false) {
    return buildDecision('PASS', 0, ['disabled'], buildMetrics());
  }

  const entryBin = finiteNumber(entryActiveBin);
  const currentBin = finiteNumber(currentActiveBin);
  const prevBin = finiteNumber(previousActiveBin);
  const lower = finiteNumber(lowerBin);
  const upper = finiteNumber(upperBin);
  const entryPx = finiteNumber(entryPrice);
  const currentPx = finiteNumber(currentPrice);
  const prevPx = finiteNumber(previousPrice);

  if (currentBin === null || currentPx === null) {
    return buildDecision('PASS', 0, ['missing_pool_impact_data'], buildMetrics());
  }

  const rangeWidth = lower !== null && upper !== null ? Math.max(1, upper - lower) : null;
  const distanceToLowerPct = lower !== null && rangeWidth !== null
    ? clamp(((currentBin - lower) / rangeWidth) * 100, 0, 100)
    : 100;
  const isOutOfRange = lower !== null && upper !== null
    ? currentBin < lower || currentBin > upper
    : false;

  const metrics = buildMetrics({
    activeBinDeltaFromEntry: entryBin !== null ? currentBin - entryBin : 0,
    activeBinDeltaFromPrevious: prevBin !== null ? currentBin - prevBin : 0,
    priceDropPctFromEntry: pctDrop(entryPx, currentPx),
    priceDropPctFromPrevious: pctDrop(prevPx, currentPx),
    distanceToLowerPct,
    consecutiveDownTicks: countConsecutiveDownTicks(recentSamples),
    isOutOfRange,
  });

  const reasons = [];
  let score = 0;
  let action = 'PASS';
  const lowerRangeBufferPct = Number(cfg.poolImpactLowerRangeBufferPct);
  const consecutiveDropThreshold = Number(cfg.poolImpactConsecutiveDropTicks);
  const recentDropConfirmPct = Number(cfg.poolImpactPriceDropWarnPct);
  const recentPriceDropConfirmed = metrics.priceDropPctFromPrevious >= recentDropConfirmPct;
  const nearLowerRangeConfirmed = lower !== null &&
    currentBin > lower &&
    metrics.distanceToLowerPct <= lowerRangeBufferPct;
  const hasRecentImpactConfirmation =
    recentPriceDropConfirmed ||
    metrics.activeBinDeltaFromPrevious < 0 ||
    nearLowerRangeConfirmed ||
    metrics.consecutiveDownTicks >= consecutiveDropThreshold;
  const hasLowerBoundImpactConfirmation =
    recentPriceDropConfirmed ||
    metrics.activeBinDeltaFromPrevious < 0 ||
    metrics.consecutiveDownTicks >= consecutiveDropThreshold;

  if (lower !== null && currentBin < lower) {
    reasons.push('below_lower_range');
    score += 100;
    return buildDecision('FORCE_EXIT', score, reasons, metrics);
  }

  if (lower !== null && currentBin === lower && hasLowerBoundImpactConfirmation) {
    reasons.push('lower_bound_confirmed_impact');
    score += 90;
    return buildDecision('FORCE_EXIT', score, reasons, metrics);
  }

  if (
    metrics.priceDropPctFromEntry >= Number(cfg.poolImpactPriceDropForceExitPct) &&
    hasRecentImpactConfirmation
  ) {
    reasons.push('price_drop_force');
    score += 90;
    return buildDecision('FORCE_EXIT', score, reasons, metrics);
  }

  if (
    metrics.consecutiveDownTicks >= consecutiveDropThreshold &&
    metrics.distanceToLowerPct <= lowerRangeBufferPct
  ) {
    reasons.push('consecutive_down_near_lower_range');
    score += 85;
    return buildDecision('FORCE_EXIT', score, reasons, metrics);
  }

  if (metrics.priceDropPctFromEntry >= Number(cfg.poolImpactPriceDropPreExitPct)) {
    reasons.push('price_drop_pre_exit');
    score += 60;
    action = 'PRE_EXIT';
  }

  if (
    metrics.activeBinDeltaFromPrevious < 0 &&
    metrics.distanceToLowerPct <= lowerRangeBufferPct
  ) {
    reasons.push('down_tick_near_lower_range');
    score += 45;
    action = action === 'PASS' ? 'PRE_EXIT' : action;
  }

  if (action === 'PASS' && metrics.priceDropPctFromEntry >= Number(cfg.poolImpactPriceDropWarnPct)) {
    reasons.push('price_drop_warn');
    score += 25;
    action = 'WARN';
  }

  if (action === 'PASS' && metrics.activeBinDeltaFromPrevious < 0) {
    reasons.push('active_bin_down_tick');
    score += 10;
    action = 'WARN';
  }

  return buildDecision(action, score, reasons.length ? reasons : ['pool_stable'], metrics);
}

function buildMetrics(overrides = {}) {
  return {
    activeBinDeltaFromEntry: 0,
    activeBinDeltaFromPrevious: 0,
    priceDropPctFromEntry: 0,
    priceDropPctFromPrevious: 0,
    distanceToLowerPct: 100,
    consecutiveDownTicks: 0,
    isOutOfRange: false,
    ...overrides,
  };
}

function buildDecision(action, score, reasons, metrics) {
  return {
    action,
    score,
    reasons,
    metrics,
  };
}
