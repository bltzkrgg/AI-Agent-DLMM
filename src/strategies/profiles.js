import { getConfig } from '../config.js';

const BASE_STRATEGY_PROFILES = {
  'Evil Panda': {
    allowedBinSteps: [80, 100, 125],
    entry: {
      requireSupertrendBreak: true,
      narrativeRequired: true,
    },
    deploy: {
      fixedBinsBelow: 69,
      label: 'deep_single_side_ep',
      lowerRangeGuidePct: 90,
    },
    exit: {
      mode: 'evil_panda_confluence',
      useGlobalTakeProfit: false,
      useGlobalTrailing: false,
      emergencyStopLossPct: 8,
    },
  },
  'Wave Enjoyer': {
    entry: {
      supportDistancePctMax: 8,
      minVolume5mUsd: 100000,
      narrativeRequired: true,
    },
    deploy: {
      fixedBinsBelow: 24,
      label: 'wave_retracement',
    },
    exit: {
      mode: 'retracement_scalp',
      takeProfitPct: 2.5,
      trailingTriggerPct: 1.5,
      trailingDropPct: 0.75,
      holdMinMinutes: 10,
      holdMaxMinutes: 20,
      emergencyStopLossPct: 4,
    },
  },
  NPC: {
    entry: {
      requireAthOrVolumeSpike: true,
      minVolume5mUsd: 50000,
      narrativeRequired: true,
    },
    deploy: {
      fixedBinsBelow: 69,
      label: 'npc_default_70_bin',
    },
    exit: {
      mode: 'post_spike_consolidation',
      takeProfitPct: 4,
      trailingTriggerPct: 2.5,
      trailingDropPct: 1.0,
      holdMinMinutes: 30,
      holdMaxMinutes: 360,
      emergencyStopLossPct: 5,
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
