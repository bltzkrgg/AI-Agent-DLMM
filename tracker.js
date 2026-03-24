export function recordTrade(trade) {
  const data = load();

  data.push({
    ...trade,
    timestamp: Date.now(),
  });

  save(data);
}

export function getPerformance() {
  const data = load();

  if (!data.length) return null;

  const pnlArr = data.map(t => t.pnl || 0);

  const avgPnl =
    pnlArr.reduce((a, b) => a + b, 0) / pnlArr.length;

  const winRate =
    pnlArr.filter(p => p > 0).length / pnlArr.length;

  return {
    avgPnl,
    winRate,
    trades: data.length,
  };
}
