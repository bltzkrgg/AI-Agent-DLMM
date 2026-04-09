import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || join(__dirname, '../user-config.json');

const DEFAULTS = {
  // Position sizing
  deployAmountSol: 0.1,
  maxPositions: 10,
  minSolToOpen: 0.07,
  gasReserve: 0.02, // SOL yang disisakan untuk tx fees + account rent

  // Agent intervals (minutes)
  managementIntervalMin: 15,
  screeningIntervalMin: 15,
  positionUpdateIntervalMin: 5,  // Interval notif status posisi (PnL, fees, range)

  // Auto-screening
  autoScreeningEnabled: false,  // Aktifkan auto-screening Hunter via cron
  approvalTimeoutMin: 15,       // Menit sebelum kandidat dianggap stale

  // Dry run — tidak eksekusi TX apapun, semua else normal
  dryRun: false,

  // Models — default ke meta-llama/llama-3.3-70b-instruct:free (proven available), bisa override di .env via AI_MODEL
  // activeModel: diset via /model command — highest priority, override semua
  managementModel: 'meta-llama/llama-3.3-70b-instruct:free',
  screeningModel: 'meta-llama/llama-3.3-70b-instruct:free',
  generalModel: 'meta-llama/llama-3.3-70b-instruct:free',
  activeModel: null,

  // Screening thresholds
  minFeeActiveTvlRatio: 0.05,
  minTvl: 10000,
  maxTvl: 150000,
  minOrganic: 55,
  minHolders: 500,
  minBinStep: 1,             // Min bin step pool yang akan dipertimbangkan
  minTokenFeesSol: 0,        // Min total fees SOL untuk pool (0 = disabled)
  timeframe: '5m',
  category: 'trending',

  // Position management
  takeProfitFeePct: 5,
  trailingTriggerPct: 3.0,   // Aktifkan trailing TP saat PnL >= X%
  trailingDropPct: 1.5,      // Close kalau PnL turun X% dari peak
  outOfRangeWaitMinutes: 30,
  outOfRangeBinsToClose: 10, // Tutup posisi jika OOR lebih dari N bins
  minFeeClaimUsd: 1.0,

  // OOR-specific pool cooldown
  oorCooldownTriggerCount: 3, // Setelah N kali OOR close, aktifkan cooldown
  oorCooldownHours: 12,       // Durasi cooldown OOR (jam)

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
  darwinWindowDays: 60,    // Sliding window hari untuk recalibration
  darwinRecalcEvery: 5,    // Recalibrate setiap N posisi ditutup
  signalWeights: {
    mcap: 2.5,              // Maxed out — strong predictor
    feeActiveTvlRatio: 2.3, // Strong predictor
    volume: 0.36,           // Near floor — useless predictor
    holderCount: 0.3,       // Floor — useless predictor
  },

  // Coin selection thresholds (USD, via GeckoTerminal + DexScreener)
  minMcap: 250000,           // Min market cap ($) — null data → skip
  maxMcap: 0,                // Max market cap ($, 0 = disabled)
  minVolume24h: 1000000,     // Min 24h volume ($) untuk Evil Panda

  // ATH drawdown filter
  athFilterPct: -75,         // Reject jika harga > X% di bawah 30-day high
  athLookbackDays: 30,       // Lookback window untuk approx ATH (1D candles)

  // Strategy-specific tuning. Core identity stays in code; these are safe overrides.
  strategyOverrides: {
    'Evil Panda': {},
    'Wave Enjoyer': {},
    'NPC': {},
  },

  // Meridian Integration & Evolution
  autonomousEvolutionEnabled: true,
  lastEvolutionTradeCount: 0,
  evolveIntervalTrades: 5,        // Recalibrate after every N closed trades
  useSocialSignals: true,          // Enable Meridian Discord/KOL signals
  socialSignalWeight: 1.5,        // Multiplier for Darwinian Score if social signal exists
  minSmartMoneyOverlap:      1,        // Minimum overlapping "SmartWallets" to boost confidence
  useSmartWalletRanges:      true,     // Mirror Top LPer ranges in Healer

  // Adaptive Post-Mortem
  autoPostMortemEnabled:     true,     // Enable LLM-based analysis of closed trades
};

const KNOWN_CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

// Bounds for AI-driven config updates — prevent AI from setting dangerous values
const CONFIG_BOUNDS = {
  deployAmountSol:            { min: 0.01,  max: 50 },
  maxPositions:               { min: 1,     max: 20 },
  minSolToOpen:               { min: 0.01,  max: 1 },
  gasReserve:                 { min: 0.01,  max: 0.5 },
  managementIntervalMin:       { min: 1,     max: 1440 },
  screeningIntervalMin:        { min: 5,     max: 1440 },
  positionUpdateIntervalMin:   { min: 1,     max: 1440 },
  approvalTimeoutMin:         { min: 5,     max: 60 },
  minFeeActiveTvlRatio:       { min: 0.001, max: 1 },
  minTvl:                     { min: 100,   max: 10000000 },
  maxTvl:                     { min: 1000,  max: 100000000 },
  minOrganic:                 { min: 0,     max: 100 },
  minHolders:                 { min: 0,     max: 1000000 },
  minBinStep:                 { min: 1,     max: 400 },
  minTokenFeesSol:            { min: 0,     max: 10000 },
  takeProfitFeePct:           { min: 0.1,   max: 100 },
  trailingTriggerPct:         { min: 0.5,   max: 50 },
  trailingDropPct:            { min: 0.1,   max: 20 },
  outOfRangeWaitMinutes:      { min: 1,     max: 1440 },
  outOfRangeBinsToClose:      { min: 1,     max: 200 },
  oorCooldownTriggerCount:    { min: 1,     max: 20 },
  oorCooldownHours:           { min: 1,     max: 168 },
  minFeeClaimUsd:             { min: 0.01,  max: 1000 },
  stopLossPct:                { min: 0.1,   max: 50 },
  maxDailyDrawdownPct:        { min: 0.5,   max: 50 },
  proactiveExitMinProfitPct:  { min: 0.1,   max: 100 },
  proactiveExitBearishConfidence: { min: 0.5, max: 1.0 },
  darwinWindowDays:           { min: 7,     max: 365 },
  darwinRecalcEvery:          { min: 1,     max: 50 },
  minMcap:                    { min: 0,     max: 100000000 },
  maxMcap:                    { min: 0,     max: 10000000000 },
  minVolume24h:               { min: 0,     max: 1000000000 },
  athFilterPct:               { min: -99,   max: -10 },
  athLookbackDays:            { min: 7,     max: 365 },
  evolveIntervalTrades:      { min: 1,     max: 100 },
  socialSignalWeight:        { min: 1.0,   max: 5.0 },
  minSmartMoneyOverlap:      { min: 0,     max: 10 },
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
  const merged = {
    ...DEFAULTS,
    ...user,
    signalWeights: {
      ...DEFAULTS.signalWeights,
      ...(user.signalWeights || {}),
    },
  };

  // Automated Lenient numeric parsing for manual edits (anti-NaN guard)
  for (const key of Object.keys(merged)) {
    if (typeof DEFAULTS[key] === 'number' && typeof merged[key] === 'string') {
      // Extract numbers (including signs and decimals), ignore everything else
      const raw = merged[key].replace(/[^-0-9.]/g, '');
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) {
        merged[key] = parsed;
      } else {
        merged[key] = DEFAULTS[key]; // fallback to default if no numbers found
      }
    }
  }

  return merged;
}

export function isConfigKeySupported(key) {
  return KNOWN_CONFIG_KEYS.has(key);
}

export function updateConfig(updates) {
  // Validate each field against bounds before saving
  const validated = {};
  const rejected = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!isConfigKeySupported(key)) {
      rejected.push(`${key}: unsupported key`);
      continue;
    }

    const bounds = CONFIG_BOUNDS[key];
    if (key === 'signalWeights') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejected.push(`${key}: must be an object`);
        continue;
      }
      validated[key] = {
        ...getConfig().signalWeights,
        ...value,
      };
      continue;
    }

    if (key === 'strategyOverrides') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejected.push(`${key}: must be an object`);
        continue;
      }
      validated[key] = {
        ...getConfig().strategyOverrides,
        ...value,
      };
      continue;
    }

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
  if (validated.signalWeights) {
    merged.signalWeights = {
      ...DEFAULTS.signalWeights,
      ...(current.signalWeights || {}),
      ...validated.signalWeights,
    };
  }
  if (validated.strategyOverrides) {
    merged.strategyOverrides = {
      ...DEFAULTS.strategyOverrides,
      ...(current.strategyOverrides || {}),
      ...validated.strategyOverrides,
    };
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log('✅ Config updated:', Object.keys(validated).join(', '));
  return getConfig();
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
  return getConfig().dryRun === true;
}
