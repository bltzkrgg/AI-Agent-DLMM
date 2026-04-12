'use strict';

import { getConfig } from '../config.js';
import db from '../db/database.js';

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
      binStep: 100,
      minMcap: 250000,
      minVolume24h: 1000000,
      timeframe: '15m', // Master Guard timeframe
    },
    entry: {
      requireSupertrendBreak: true,
      momentumTriggerM5: 2.0,
      narrativeRequired: true,
      adaptiveMode: true,
      minBuySellRatio: 1.3,
      note: 'Refundable bins allow for disciplined re-entry on trend breaks.',
    },
    deploy: {
      label: 'warp_panda_sniper_m15',
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
      momentumTriggerM5: 0.5, 
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
 * Persitence Helpers (CRUD)
 */

export function addStrategy(data) {
  const paramsStr = typeof data.parameters === 'object' ? JSON.stringify(data.parameters) : data.parameters;
  const result = db.prepare(`
    INSERT INTO strategies (name, description, strategy_type, parameters, logic, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.name, data.description, data.strategyType, paramsStr, data.logic || null, data.createdBy || 'admin');
  
  return { id: result.lastInsertRowid, ...data };
}

export function updateStrategy(name, data) {
  const paramsStr = typeof data.parameters === 'object' ? JSON.stringify(data.parameters) : data.parameters;
  return db.prepare(`
    UPDATE strategies 
    SET description = ?, strategy_type = ?, parameters = ?, logic = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `).run(data.description, data.strategyType, paramsStr, data.logic || null, name);
}

export function deleteStrategy(name) {
  // Prevent deleting baseline strategies
  if (BASELINE_STRATEGIES[name]) return false;
  
  const result = db.prepare(`DELETE FROM strategies WHERE name = ?`).run(name);
  return result.changes > 0;
}

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
 * Mendapatkan strategi final (Baseline + DB + Overrides dari User Config)
 */
export function getStrategy(name) {
  // 1. Check Baseline (Factory Presets)
  let base = BASELINE_STRATEGIES[name];

  // 2. Check Database (User Defined)
  if (!base) {
    const row = db.prepare(`SELECT * FROM strategies WHERE name = ? AND is_active = 1`).get(name);
    if (row) {
      base = {
        name: row.name,
        description: row.description,
        type: row.strategy_type === 'spot' ? 'single_side_y' : row.strategy_type,
        parameters: JSON.parse(row.parameters),
        logic: row.logic,
        _db: true
      };
    }
  }

  if (!base) return null;

  // 3. User Config Overrides
  const cfg = getConfig();
  const overrides = cfg.strategyOverrides?.[name] || {};

  const final = deepMerge(base, overrides);
  return { ...final, name };
}

// Alias for backward compatibility with legacy agents (Claude, Handler)
export { getStrategy as getStrategyByName };

export function getAllStrategies() {
  // 1. Baseline
  const baselineList = Object.keys(BASELINE_STRATEGIES).map(name => getStrategy(name));

  // 2. Database
  const dbRows = db.prepare(`SELECT name FROM strategies WHERE is_active = 1`).all();
  const dbList = dbRows
    .filter(row => !BASELINE_STRATEGIES[row.name])
    .map(row => getStrategy(row.name));

  return [...baselineList, ...dbList];
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
