import { resolvePnlSnapshot } from './pnl.js';

export function resolvePositionSnapshot({
  dbPosition,
  livePosition = null,
  providerPnlPct = null,
  directPnlPct = null,
  manualClose = false,
  rpcError = false,
}) {
  const deployedSol = dbPosition?.deployed_sol || 0;
  const currentValueSol = livePosition?.currentValueSol ?? 0;

  const pnl = resolvePnlSnapshot({
    deployedSol,
    currentValueSol,
    providerPnlPct,
    directPnlPct: Number.isFinite(directPnlPct)
      ? directPnlPct
      : (Number.isFinite(livePosition?.pnlPct) ? livePosition.pnlPct : null),
  });

  let status = 'NoData';
  if (manualClose) status = 'Manual';
  else if (rpcError) status = 'RpcError';
  else if (livePosition) status = livePosition.inRange ? 'InRange' : 'OutRange';

  return {
    positionAddress: dbPosition?.position_address ?? livePosition?.address ?? null,
    lifecycleState: dbPosition?.lifecycle_state || (dbPosition?.status === 'closed' ? 'closed_reconciled' : 'open'),
    status,
    manualClose,
    rpcError,
    inRange: livePosition?.inRange ?? null,
    currentValueSol,
    feeSol: livePosition?.feeCollectedSol ?? 0,
    pnlPct: pnl.pnlPct,
    pnlSol: pnl.pnlSol,
    pnlSource: pnl.source,
    priceUnit: livePosition?.priceUnit || null,
    displayCurrentPrice: livePosition?.displayCurrentPrice ?? null,
    displayLowerPrice: livePosition?.displayLowerPrice ?? null,
    displayUpperPrice: livePosition?.displayUpperPrice ?? null,
    lowerBinId: livePosition?.lowerBinId ?? null,
    upperBinId: livePosition?.upperBinId ?? null,
    activeBinId: livePosition?.activeBinId ?? null,
  };
}
