import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../user-config.json');

const DEFAULTS = {
  // Position sizing
  deployAmountSol: 0.1,
  maxPositions: 10,
  minSolToOpen: 0.07,
  gasReserve: 0.02, // SOL yang disisakan untuk tx fees + account rent

  // Agent intervals (minutes)
  managementIntervalMin: 10,
  screeningIntervalMin: 30,

  // Models — default ke gpt-4o-mini, bisa override di .env via AI_MODEL
  // activeModel: diset via /model command — highest priority, override semua
  managementModel: 'openai/gpt-4o-mini',
  screeningModel: 'openai/gpt-4o-mini',
  generalModel: 'openai/gpt-4o-mini',
  activeModel: null,

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
  stopLossPct: 5,
  maxDailyDrawdownPct: 10,
  requireConfirmation: false,

  // Proactive exit
  proactiveExitEnabled: true,
  proactiveExitMinProfitPct: 1.0,
  proactiveExitBearishConfidence: 0.7,

  // Darwinian Signal Weighting — dari 263 closed positions
  // Higher weight = stronger predictor of profitable positions
  signalWeights: {
    mcap: 2.5,              // Maxed out — strong predictor
    feeActiveTvlRatio: 2.3, // Strong predictor
    volume: 0.36,           // Near floor — useless predictor
    holderCount: 0.3,       // Floor — useless predictor
  },

  // Evil Panda — coin selection thresholds
  minMcap: 250000,           // Min market cap / FDV ($)
  minVolume24h: 1000000,     // Min 24h volume ($) untuk Evil Panda

  // Security thresholds — RugCheck primary, GMGN fallback
  gmgnMaxPhishing: 30,       // Max phishing/danger proxy % (<30%)
  gmgnMaxBundling: 60,       // Max bundling % (<60%)
  gmgnMaxInsiders: 10,       // Max insider % (<10%)
  gmgnMaxTop10Holdings: 30,  // Max top-10 holdings % (<30%)
};

// Bounds for AI-driven config updates — prevent AI from setting dangerous values
const CONFIG_BOUNDS = {
  deployAmountSol:            { min: 0.01,  max: 50 },
  maxPositions:               { min: 1,     max: 20 },
  minSolToOpen:               { min: 0.01,  max: 1 },
  gasReserve:                 { min: 0.01,  max: 0.5 },
  managementIntervalMin:      { min: 1,     max: 1440 },
  screeningIntervalMin:       { min: 5,     max: 1440 },
  minFeeActiveTvlRatio:       { min: 0.001, max: 1 },
  minTvl:                     { min: 100,   max: 10000000 },
  maxTvl:                     { min: 1000,  max: 100000000 },
  minOrganic:                 { min: 0,     max: 100 },
  minHolders:                 { min: 0,     max: 1000000 },
  takeProfitFeePct:           { min: 0.1,   max: 100 },
  outOfRangeWaitMinutes:      { min: 1,     max: 1440 },
  minFeeClaimUsd:             { min: 0.01,  max: 1000 },
  stopLossPct:                { min: 0.1,   max: 50 },
  maxDailyDrawdownPct:        { min: 0.5,   max: 50 },
  proactiveExitMinProfitPct:  { min: 0.1,   max: 100 },
  proactiveExitBearishConfidence: { min: 0.5, max: 1.0 },
  minMcap:              { min: 0,   max: 100000000 },
  minVolume24h:         { min: 0,   max: 1000000000 },
  gmgnMaxPhishing:      { min: 0,   max: 100 },
  gmgnMaxBundling:      { min: 0,   max: 100 },
  gmgnMaxInsiders:      { min: 0,   max: 100 },
  gmgnMaxTop10Holdings: { min: 0,   max: 100 },
};

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadUserConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return safeParseJSON(readFileSync(CONFIG_PATH, 'utf-8'));
}

export function getConfig() {
  const user = loadUserConfig();
  return { ...DEFAULTS, ...user };
}

export function updateConfig(updates) {
  // Validate each field against bounds before saving
  const validated = {};
  const rejected = [];

  for (const [key, value] of Object.entries(updates)) {
    const bounds = CONFIG_BOUNDS[key];
    if (bounds && typeof value === 'number') {
      if (value < bounds.min || value > bounds.max) {
        rejected.push(`${key}: ${value} (allowed: ${bounds.min}-${bounds.max})`);
        continue;
      }
    }
    validated[key] = value;
  }

  if (rejected.length > 0) {
    console.warn('⚠️ Config updates rejected (out of bounds):', rejected.join(', '));
  }

  if (Object.keys(validated).length === 0) return getConfig();

  const current = loadUserConfig();
  const merged = { ...current, ...validated };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log('✅ Config updated:', Object.keys(validated).join(', '));
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
  return false; // Always live — dry run mode removed
}
