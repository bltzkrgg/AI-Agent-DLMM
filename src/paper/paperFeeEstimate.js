const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function estimatePaperFeeAccrual({
  previousFeeSol = 0,
  previousAvailable = false,
  capitalSol = 0,
  fees24h = null,
  tvl = null,
  elapsedMs = 0,
  inRange = false,
} = {}) {
  const priorFeeSol = Math.max(0, finiteNumber(previousFeeSol, 0));
  const safeCapitalSol = Math.max(0, finiteNumber(capitalSol, 0));
  const safeFees24h = finiteNumber(fees24h, null);
  const safeTvl = finiteNumber(tvl, null);
  const safeElapsedMs = Math.max(0, finiteNumber(elapsedMs, 0));
  const hasPoolYield = (
    safeFees24h !== null &&
    safeFees24h >= 0 &&
    safeTvl !== null &&
    safeTvl > 0
  );

  if (!hasPoolYield) {
    return {
      available: previousAvailable === true,
      feeSol: priorFeeSol,
      incrementSol: 0,
      dailyFeeTvlRatio: null,
      source: previousAvailable === true
        ? 'paper_pool_fee_tvl_estimate_v1'
        : 'paper_estimate_unavailable',
    };
  }

  const dailyFeeTvlRatio = safeFees24h / safeTvl;
  const incrementSol = inRange
    ? safeCapitalSol * dailyFeeTvlRatio * (safeElapsedMs / DAY_MS)
    : 0;

  return {
    available: true,
    feeSol: priorFeeSol + incrementSol,
    incrementSol,
    dailyFeeTvlRatio,
    source: 'paper_pool_fee_tvl_estimate_v1',
  };
}
