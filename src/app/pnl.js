function round(value, digits) {
  return parseFloat(Number(value || 0).toFixed(digits));
}

export function resolvePnlSnapshot({
  deployedSol = 0,
  currentValueSol = 0,
  providerPnlPct = null,
  directPnlPct = null,
}) {
  const candidatePnlPct = Number.isFinite(providerPnlPct)
    ? providerPnlPct
    : Number.isFinite(directPnlPct)
      ? directPnlPct
      : null;

  if (candidatePnlPct !== null) {
    const pnlPct = round(candidatePnlPct, 2);
    const pnlSol = deployedSol > 0
      ? round((deployedSol * pnlPct) / 100, 6)
      : round(currentValueSol - deployedSol, 6);
    return {
      pnlPct,
      pnlSol,
      source: Number.isFinite(providerPnlPct) ? 'lp_agent' : 'position_provider',
    };
  }

  const pnlSol = round(currentValueSol - deployedSol, 6);
  const pnlPct = deployedSol > 0 && currentValueSol > 0
    ? round(((currentValueSol - deployedSol) / deployedSol) * 100, 2)
    : 0;

  return {
    pnlPct,
    pnlSol,
    source: 'manual_estimate',
  };
}
