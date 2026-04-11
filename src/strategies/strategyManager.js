import { getConfig } from '../config.js';

/**
 * BASELINE_STRATEGIES
 * 
 * Sesuai saran Codex: "Strategi inti jangan bisa berubah sembarang".
 * Ini adalah 'Source of Truth' utama untuk logika entry/exit/deployment.
 */
const BASELINE_STRATEGIES = {
  'Evil Panda': {
    type: 'single_side_y', // SOL only
    allowedBinSteps: [80, 100, 125, 200],
    parameters: {
      entryPriceOffsetMin: 86,
      entryPriceOffsetMax: 94,
      binStep: 100,
      minMcap: 250000,
      minVolume24h: 1000000,
    },
    entry: {
      requireSupertrendBreak: true,
      momentumTriggerM5: 2.0,
      narrativeRequired: true,
      adaptiveMode: true,
      minBuySellRatio: 1.3,
    },
    deploy: {
      label: 'warp_panda_sniper',
      priceRangePct: 10,
    },
    exit: {
      mode: 'evil_panda_confluence',
      emergencyStopLossPct: 40, // Wider SL to allow dip accumulation
      takeProfitPct: 15,
    },
  },
  'Deep Sea Kraken': {
    type: 'single_side_y',
    allowedBinSteps: [100, 200],
    parameters: {
      entryPriceOffsetMin: 0, 
      entryPriceOffsetMax: 80, // Target extreme wicks (-80%)
    },
    entry: {
      momentumTriggerM5: 0.5, // Low trigger for slow recovery capture
      volatilityRequired: 'HIGH',
    },
    deploy: {
      label: 'deep_sea_wick_hunter',
      priceRangePct: 80,
    },
    exit: {
      mode: 'trend_confirmed',
      emergencyStopLossPct: 60,
      takeProfitPct: 25,
    },
  },
  'Wave Enjoyer': {
    type: 'single_side_y',
    allowedBinSteps: [1, 5, 10, 20, 50, 100],
    parameters: {
      binStep: 80,
      minVolume5mUsd: 100000,
    },
    entry: {
      momentumTriggerM5: 1.0,
      proximityToSupport: true,
    },
    deploy: {
      fixedBinsBelow: 24,
      label: 'wave_enjoyment',
    },
    exit: {
      mode: 'wave_exit',
      holdMinMinutes: 10,
      holdMaxMinutes: 120,
    },
  },
  'NPC': {
    type: 'single_side_y',
    allowedBinSteps: [80, 100],
    parameters: {
      binStep: 80,
    },
    entry: {
      afterBreakout: true,
      momentumTriggerM5: 1.5,
    },
    deploy: {
      fixedBinsBelow: 69,
      label: 'npc_consolidation',
    },
    exit: {
      mode: 'standard',
    },
  }
};

/**
 * Deep merge utility for strategy overrides
 */
function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base?.[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Mendapatkan strategi final (Baseline + Overrides dari User Config)
 */
export function getStrategy(name) {
  const base = BASELINE_STRATEGIES[name];
  if (!base) return null;

  const cfg = getConfig();
  const overrides = cfg.strategyOverrides?.[name] || {};

  // Merge hasil
  const final = deepMerge(base, overrides);

  // Tambahkan flag 'name' agar consumer tahu strategi apa ini
  return { ...final, name };
}

export function getAllStrategies() {
  return Object.keys(BASELINE_STRATEGIES).map(name => getStrategy(name));
}

/**
 * Helper untuk parse parameter ke format yang dimengerti tool deployment lama
 */
export function parseStrategyParameters(strategy) {
  return {
    ...strategy.parameters,
    priceRangePercent: strategy.deploy?.priceRangePct || 10,
    strategyType: 0, // Default to Spot for DLMM standard
    tokenXWeight: strategy.type === 'single_side_y' ? 0 : 50,
    tokenYWeight: strategy.type === 'single_side_y' ? 100 : 50,
  };
}
