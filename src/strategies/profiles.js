import { getConfig } from '../config.js';

const BASE_STRATEGY_PROFILES = {
  'Evil Panda': {
    allowedBinSteps: [80, 100, 125, 200],
    entry: {
      requireSupertrendBreak: true, // Now strictly using 15m confluence
      momentumTriggerM5: 2.0,      // Higher conviction required
      narrativeRequired: true,
      adaptiveMode: true,
    },
    deploy: {
      label: 'warp_panda_sniper',
    },
    exit: {
      mode: 'evil_panda_confluence',
      useGlobalTakeProfit: false,
      useGlobalTrailing: false,
      emergencyStopLossPct: 8,
    },
  },
  'Wave Enjoyer': {
    allowedBinSteps: [1, 5, 10, 20, 50, 100],
    entry: {
      momentumTriggerM5: 1.0,
      narrativeRequired: false,
    },
    deploy: {
      fixedBinsBelow: 24,
      label: 'wave_enjoyment',
    },
    exit: {
      holdMinMinutes: 10,
      holdMaxMinutes: 120,
      mode: 'wave_exit',
    },
  },
};

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

export function getStrategyProfile(strategyName) {
  const base = BASE_STRATEGY_PROFILES[strategyName] || null;
  if (!base) return null;

  const cfg = getConfig();
  const overrides = cfg.strategyOverrides?.[strategyName] || {};
  return deepMerge(base, overrides);
}

export function getAllStrategyProfiles() {
  return Object.fromEntries(
    Object.keys(BASE_STRATEGY_PROFILES).map((name) => [name, getStrategyProfile(name)]),
  );
}
