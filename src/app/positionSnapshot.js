'use strict';

import { resolvePnlSnapshot } from './pnl.js';

export function resolvePositionSnapshot({
  dbPosition = {},
  livePosition = {},
  providerPnlPct = null,
} = {}) {
  const deployedSol = Number(dbPosition.deployed_sol || 0);
  const currentValueSol = Number(livePosition.currentValueSol || deployedSol);
  const pnl = resolvePnlSnapshot({ deployedSol, currentValueSol, providerPnlPct });

  return {
    positionAddress: dbPosition.position_address || null,
    status: livePosition.inRange === false ? 'OutRange' : 'InRange',
    lifecycleState: dbPosition.lifecycle_state || 'open',
    pnlPct: pnl.pnlPct,
    pnlSol: pnl.pnlSol,
    feeSol: Number(livePosition.feeCollectedSol || 0),
    pnlSource: pnl.source,
  };
}

