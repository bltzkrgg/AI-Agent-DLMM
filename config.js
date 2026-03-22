import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../user-config.json');

const DEFAULTS = {
  dryRun: process.env.DRY_RUN === 'true',

  // Position sizing
  deployAmountSol: 0.5,
  maxPositions: 3,
  minSolToOpen: 0.07,

  // Agent intervals (minutes)
  managementIntervalMin: 10,
  screeningIntervalMin: 30,

  // Models
  managementModel: 'claude-sonnet-4-20250514',
  screeningModel: 'claude-sonnet-4-20250514',
  generalModel: 'claude-sonnet-4-20250514',

  // Screening thresholds
  minFeeActiveTvlRatio: 0.05,
  minTvl: 10000,
  maxTvl: 150000,
  minOrganic: 65,
  minHolders: 500,
  timeframe: '5m',
  category: 'trending',

  // Position management
  takeProfitFeePct: 5,
  outOfRangeWaitMinutes: 30,
  minFeeClaimUsd: 1.0,
};

function loadUserConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function getConfig() {
  const user = loadUserConfig();
  return { ...DEFAULTS, ...user };
}

export function updateConfig(updates) {
  const current = loadUserConfig();
  const merged = { ...current, ...updates };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log('✅ Config updated:', Object.keys(updates).join(', '));
  return merged;
}

export function getThresholds() {
  const cfg = getConfig();
  return {
    minFeeActiveTvlRatio: cfg.minFeeActiveTvlRatio,
    minTvl: cfg.minTvl,
    maxTvl: cfg.maxTvl,
    minOrganic: cfg.minOrganic,
    minHolders: cfg.minHolders,
    takeProfitFeePct: cfg.takeProfitFeePct,
    outOfRangeWaitMinutes: cfg.outOfRangeWaitMinutes,
    minFeeClaimUsd: cfg.minFeeClaimUsd,
  };
}

export function isDryRun() {
  // env var takes priority, then user-config.json, then default true
  if (process.env.DRY_RUN === 'false') return false;
  if (process.env.DRY_RUN === 'true') return true;
  return getConfig().dryRun !== false;
}
