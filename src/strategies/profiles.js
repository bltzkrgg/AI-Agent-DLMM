import { getConfig } from '../config.js';
import { BASE_STRATEGY_PROFILES } from './profileDefaults.js';
import { getAdaptiveStrategyOverride } from './adaptive.js';

function deepMerge(base, ...overrides) {
  let output = { ...base };
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override || {})) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        output?.[key] &&
        typeof output[key] === 'object' &&
        !Array.isArray(output[key])
      ) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    }
  }
  return output;
}

export function getStrategyProfile(strategyName) {
  const base = BASE_STRATEGY_PROFILES[strategyName] || null;
  if (!base) return null;

  const cfg = getConfig();
  const adaptive = getAdaptiveStrategyOverride(strategyName);
  const overrides = cfg.strategyOverrides?.[strategyName] || {};
  return deepMerge(base, adaptive, overrides);
}

export function getAllStrategyProfiles() {
  return Object.fromEntries(
    Object.keys(BASE_STRATEGY_PROFILES).map((name) => [name, getStrategyProfile(name)]),
  );
}
