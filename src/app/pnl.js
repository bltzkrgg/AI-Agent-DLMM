'use strict';

function isFiniteNumericInput(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

export function resolvePnlSnapshot({
  deployedSol = 0,
  currentValueSol = 0,
  providerPnlPct = null,
  directPnlPct = null,
  divergenceThresholdPct = 10,
  positionAddress = null,
  poolAddress = null,
  tokenMint = null,
  onDivergence = null,
} = {}) {
  const manualPct = deployedSol > 0 ? ((currentValueSol - deployedSol) / deployedSol) * 100 : 0;
  const hasProvider = isFiniteNumericInput(providerPnlPct);
  const providerPct = hasProvider ? Number(providerPnlPct) : manualPct;
  const hasDirect = isFiniteNumericInput(directPnlPct);
  const directPct = hasDirect ? Number(directPnlPct) : manualPct;
  const divergencePct = Math.abs(providerPct - directPct);

  let selectedPct = providerPct;
  let source = hasProvider ? 'lp_agent' : 'manual_estimate';

  if (hasProvider && hasDirect && divergencePct > divergenceThresholdPct) {
    selectedPct = directPct;
    source = 'on_chain_fallback';
    onDivergence?.({
      positionAddress,
      poolAddress,
      tokenMint,
      divergencePct,
      selectedSource: source,
    });
  }

  const pnlSol = deployedSol * (selectedPct / 100);
  return {
    pnlPct: Number(selectedPct.toFixed(4)),
    pnlSol: Number(pnlSol.toFixed(4)),
    source,
  };
}
