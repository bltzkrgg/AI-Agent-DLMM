import { getPerformance } from './tracker.js';
import { getConfig } from './config.js';

export function evolveStrategy() {
  const perf = getPerformance();
  if (!perf) return;

  const cfg = getConfig();

  console.log('🧠 Evolving...', perf);

  // 🔻 Kalau jelek → lebih konservatif
  if (perf.winRate < 0.4) {
    cfg.deployAmountSol *= 0.8;
    cfg.maxPositionSizePct *= 0.8;
  }

  // 🔺 Kalau bagus → scale up
  if (perf.winRate > 0.6) {
    cfg.deployAmountSol *= 1.1;
  }

  return cfg;
}
