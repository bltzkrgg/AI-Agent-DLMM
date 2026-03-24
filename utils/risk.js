export function getDynamicTPSL(volatility) {
  // volatility typical: 0.01 – 0.05

  let tp = 3;
  let sl = -5;

  if (volatility > 0.03) {
    tp = 5;
    sl = -7;
  } else if (volatility < 0.015) {
    tp = 2;
    sl = -3;
  }

  return { tp, sl };
}
