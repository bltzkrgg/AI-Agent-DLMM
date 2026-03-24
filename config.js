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

  // Safety
  stopLossPct: 5,               // Close posisi kalau rugi > 5%
  maxDailyDrawdownPct: 10,      // Freeze semua kalau rugi > 10% dalam sehari
  requireConfirmation: true,    // Minta konfirmasi Telegram sebelum deploy

  // Proactive exit — close kalau profit & chart bearish
  proactiveExitEnabled: true,
  proactiveExitMinProfitPct: 1.0,       // Minimal profit sebelum proactive exit aktif
  proactiveExitBearishConfidence: 0.7,  // Confidence threshold untuk auto-close
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
