export function getAdaptiveRange(volatility) {
  // range dalam %

  if (volatility > 0.03) return 10;   // volatile → wide
  if (volatility < 0.015) return 3;   // stable → tight

  return 5;
}
