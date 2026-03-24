import { readFileSync, writeFileSync, existsSync } from 'fs';

const CONFIG_PATH = './user-config.json';

const DEFAULT = {
  dryRun: true,
  maxPositions: 3,
  minSolToOpen: 0.2,
  deployAmountSol: 0.1,

  maxPositionSizePct: 20,
  maxDailyLossUsd: 50,

  takeProfitFeePct: 3,
  outOfRangeWaitMinutes: 30,
};

let cache = null;

export function getConfig() {
  if (cache) return cache;

  if (!existsSync(CONFIG_PATH)) return DEFAULT;

  try {
    const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    cache = { ...DEFAULT, ...file };
    return cache;
  } catch {
    return DEFAULT;
  }
}

export function isDryRun() {
  return process.env.DRY_RUN === 'true' || getConfig().dryRun;
}
