export function calculateVolatility(closes) {
  if (!closes || closes.length < 10) return 0;

  const returns = [];

  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;

  const variance =
    returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) /
    returns.length;

  return Math.sqrt(variance);
}
