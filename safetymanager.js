export function checkStopLoss(pos) {
  const pnl = pos.pnlPct;

  if (pnl === undefined) return { triggered: false };

  if (pnl < -5) {
    return {
      triggered: true,
      reason: `Stop loss hit (${pnl}%)`,
    };
  }

  return { triggered: false };
}
