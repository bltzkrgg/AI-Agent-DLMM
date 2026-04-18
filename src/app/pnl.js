function round(value, digits) {
  return parseFloat(Number(value || 0).toFixed(digits));
}

export function resolvePnlSnapshot({
  deployedSol = 0,
  currentValueSol = 0,
  feesClaimed = 0,
  providerPnlPct = null,
  directPnlPct = null,
  positionAddress = null,
  poolAddress = null,
  tokenMint = null,
  divergenceThresholdPct = 10,
  onDivergence = null,
}) {
  // Fix #3: Log significant divergence between PnL sources so silent data quality issues surface
  if (Number.isFinite(providerPnlPct) && Number.isFinite(directPnlPct)) {
    const divergence = Math.abs(providerPnlPct - directPnlPct);
    if (divergence > divergenceThresholdPct) {
      console.warn(`[pnl] ⚠️ Source divergence ${divergence.toFixed(1)}%: lp_agent=${providerPnlPct.toFixed(2)}% vs on_chain=${directPnlPct.toFixed(2)}% — using lp_agent`);
      if (typeof onDivergence === 'function') {
        try {
          onDivergence({
            positionAddress,
            poolAddress,
            tokenMint,
            providerPnlPct,
            onChainPnlPct: directPnlPct,
            divergencePct: divergence,
            selectedSource: 'lp_agent',
          });
        } catch {
          // no-op: divergence audit must never break decision path
        }
      }
    }
  }

  const candidatePnlPct = Number.isFinite(providerPnlPct)
    ? providerPnlPct
    : Number.isFinite(directPnlPct)
      ? directPnlPct
      : null;

  if (candidatePnlPct !== null) {
    const pnlPct = round(candidatePnlPct, 2);
    // Include claimed fees so PnL is not understated after auto-harvest
    const adjustedValueSol = currentValueSol + feesClaimed;
    const pnlSol = deployedSol > 0
      ? round((deployedSol * pnlPct) / 100, 6)
      : round(adjustedValueSol - deployedSol, 6);
    return {
      pnlPct,
      pnlSol,
      source: Number.isFinite(providerPnlPct) ? 'lp_agent' : 'position_provider',
    };
  }

  // Fallback: manual estimate — include claimed fees so post-harvest PnL is accurate
  const adjustedValueSol = currentValueSol + feesClaimed;
  const pnlSol = round(adjustedValueSol - deployedSol, 6);
  const pnlPct = deployedSol > 0 && adjustedValueSol > 0
    ? round(((adjustedValueSol - deployedSol) / deployedSol) * 100, 2)
    : 0;

  return {
    pnlPct,
    pnlSol,
    source: 'manual_estimate',
  };
}
