import { getConfig } from '../config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Source of truth strategy library lives at repo root.
const STRATEGIES_JSON_PATH = join(__dirname, '../../strategy-library.json');

function getDbOrThrow() {
  const db = globalThis.db;
  if (!db) {
    throw new Error('Database belum terinisialisasi.');
  }
  return db;
}

function getDbIfReady() {
  return globalThis.db || null;
}

/**
 * BASELINE_STRATEGIES
 * 
 * Sesuai saran Codex: "Strategi inti jangan bisa berubah sembarang".
 * Ini adalah 'Source of Truth' utama untuk logika entry/exit/deployment.
 */
const BASELINE_STRATEGIES = {
  'Evil Panda': {
    id: 'evil_panda',
    type: 'single_side_y',        // SOL only
    allowedBinSteps: [100, 125],
    parameters: {
      binStep: 100,
      minMcap: 250000,
      timeframe: '15m',           // 15-minute Master Guard
    },
    entry: {
      requireSupertrendBullish: true,
      timeframe: '15m',
      confirmationOnClose: true,
    },
    deploy: {
      label: 'evil_panda_master_v61',
      entryPriceOffsetMin: 0,     // Starts at current price
      entryPriceOffsetMax: 94,    // Extends to -94% drop (~94 bins)
      slippagePct: 0.5,
    },
    exit: {
      mode: 'evil_panda_confluence',
      // takeProfitPct, emergencyStopLossPct, maxHoldHours dibaca dari config
      // supaya user bisa ubah via user-config.json tanpa sentuh kode strategi
    },
  },
  'Deep Fishing': {
    id: 'deep_fishing',
    type: 'single_side_y',
    allowedBinSteps: [80, 100, 125],
    parameters: {
      binStep: 100,
      minMcap: 250000,
      minVolume24h: 20000,
      timeframe: '15m',
    },
    entry: {
      requireSupertrendBullish: true,
      timeframe: '15m',
      confirmationOnClose: true,
    },
    deploy: {
      label: 'deep_fishing_v1',
      entryPriceOffsetMin: 86,
      entryPriceOffsetMax: 94,
      slippagePct: 0.5,
    },
    exit: {
      mode: 'evil_panda_confluence',
    },
  },
};

const DEFAULT_CUSTOM_STRATEGY_TEMPLATE = {
  type: 'spot',
  parameters: {
    priceRangePercent: 10,
    binStep: 10,
  },
  deploy: {
    fixedBinsBelow: 24,
    label: 'Custom',
  },
  exit: {
    holdMinMinutes: 10,
    holdMaxMinutes: 20,
  },
};

/**
 * Persitence Helpers (CRUD)
 */

export function addStrategy(data) {
  const paramsStr = typeof data.parameters === 'object' ? JSON.stringify(data.parameters) : data.parameters;
  const _db = getDbOrThrow();
  const result = _db.prepare(`
    INSERT INTO strategies (name, description, strategy_type, parameters, logic, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.name, data.description, data.strategyType, paramsStr, data.logic || null, data.createdBy || 'admin');

  return { id: result.lastInsertRowid, ...data };
}

export function updateStrategy(name, data) {
  const paramsStr = typeof data.parameters === 'object' ? JSON.stringify(data.parameters) : data.parameters;
  const _db = getDbOrThrow();
  return _db.prepare(`
    UPDATE strategies 
    SET description = ?, strategy_type = ?, parameters = ?, logic = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `).run(data.description, data.strategyType, paramsStr, data.logic || null, name);
}

export function deleteStrategy(name) {
  // Prevent deleting baseline strategies
  if (BASELINE_STRATEGIES[name]) return false;

  const _db = getDbOrThrow();
  const result = _db.prepare(`DELETE FROM strategies WHERE name = ?`).run(name);
  return result.changes > 0;
}

/**
 * Slugify name for consistent lookup
 */
function slugify(text) {
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '_');
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
/**
 * Helper untuk normalisasi nama (Fuzzy Match)
 */
function cleanName(name) {
  if (!name) return 'evil_panda';
  return name.toLowerCase().replace(/_/g, ' ').replace(/\(adaptive\)/g, '').trim().replace(/\s+/g, '_');
}

/**
 * Mendapatkan strategi final (Baseline + DB + Overrides dari User Config)
 */
export function getStrategy(name) {
  if (!name) return BASELINE_STRATEGIES['Evil Panda'];

  // --- Normalisasi Nama (Fuzzy Match) ---
  const clean = cleanName(name);
  let hasBaseline = false;

  // 1. Load from Baseline (Factory Presets)
  let base = BASELINE_STRATEGIES[name];
  if (base) hasBaseline = true;
  if (!base) {
    const baselineKey = Object.keys(BASELINE_STRATEGIES).find(k =>
      slugify(k) === clean ||
      k.toLowerCase() === name.toLowerCase().replace(/_/g, ' ')
    );
    if (baselineKey) {
      base = BASELINE_STRATEGIES[baselineKey];
      hasBaseline = true;
    }
  }

  // 2. Load from JSON Library (External "Big Book" of strategies)
  try {
    if (fs.existsSync(STRATEGIES_JSON_PATH)) {
      const data = fs.readFileSync(STRATEGIES_JSON_PATH, 'utf8');
      const library = JSON.parse(data);
      const jsonMatch = library.strategies?.find(s =>
        slugify(s.name) === clean ||
        s.id === clean
      );
      if (jsonMatch) {
        // Overlay JSON on top of baseline (if exists) or use as base
        base = base ? deepMerge(base, jsonMatch) : jsonMatch;
      }
    }
  } catch (e) {
    console.error(`[strategyManager] Gagal muat strategi dari JSON:`, e.message);
  }

  // 3. Load from Database (Persistent Overrides)
  if (!hasBaseline) {
    const dbClean = base?.id || clean;
    const _db = getDbIfReady();
    if (_db) {
      const row = _db.prepare(`SELECT * FROM strategies WHERE (LOWER(name) = ? OR id = ?) AND is_active = 1`).get(dbClean.replace(/_/g, ' '), dbClean);
      if (row) {
        const dbParams = JSON.parse(row.parameters || '{}');
        const dbBase = {
          name: row.name,
          description: row.description,
          type: row.strategy_type === 'spot' ? 'single_side_y' : row.strategy_type,
          parameters: dbParams,
          logic: row.logic,
          _db: true
        };
        base = base ? deepMerge(base, dbBase) : dbBase;
      }
    }
  }

  // 3. User Config Overrides
  const cfg = getConfig();
  const overrides = cfg.strategyOverrides?.[name] || {};
  if (!base && Object.keys(overrides).length > 0) {
    base = { ...DEFAULT_CUSTOM_STRATEGY_TEMPLATE };
  }

  if (!base) return null;

  const final = deepMerge(base, overrides);

  // Sanitize numeric exit fields — reject non-finite values to prevent silent bad config
  if (final.exit && typeof final.exit === 'object') {
    const numericExitFields = ['emergencyStopLossPct', 'takeProfitPct', 'maxHoldHours', 'trailingTriggerPct', 'trailingDropPct'];
    for (const field of numericExitFields) {
      if (field in final.exit) {
        const v = parseFloat(final.exit[field]);
        if (!Number.isFinite(v)) {
          console.warn(`[strategyManager] Invalid exit.${field} value "${final.exit[field]}" for strategy "${name}" — removed`);
          delete final.exit[field];
        } else {
          final.exit[field] = v;
        }
      }
    }
  }

  return { ...final, name };
}

// Alias for backward compatibility with legacy agents (Claude, Handler)
export { getStrategy as getStrategyByName };

export function getAllStrategies() {
  // 1. Baseline
  const baselineList = Object.keys(BASELINE_STRATEGIES).map(name => getStrategy(name));

  // 2. Database
  const _db = getDbIfReady();
  if (!_db) return baselineList;
  const dbRows = _db.prepare(`SELECT name FROM strategies WHERE is_active = 1`).all();
  const dbList = dbRows
    .filter(row => !BASELINE_STRATEGIES[row.name])
    .map(row => getStrategy(row.name));

  return [...baselineList, ...dbList];
}

/**
 * Helper untuk parse parameter ke format yang dimengerti tool deployment lama
 */
export function parseStrategyParameters(strategy) {
  if (!strategy) return { priceRangePercent: 10, strategyType: 0, tokenXWeight: 0, tokenYWeight: 100 };

  const deploy = strategy.deploy || {};
  const offsetMin = Number(deploy.entryPriceOffsetMin);
  const offsetMax = Number(deploy.entryPriceOffsetMax);
  const derivedRangePct = Number.isFinite(offsetMax) && Number.isFinite(offsetMin) && offsetMax >= offsetMin
    ? Math.max(1, offsetMax - offsetMin)
    : null;
  const priceRangePercent = deploy.priceRangePct ?? derivedRangePct ?? 10;

  const derivedStrategyType = deploy.strategyType ?? (strategy.type === 'single_side_y' ? 2 : 0);

  return {
    ...(strategy.parameters || {}),
    priceRangePercent,
    strategyType: derivedStrategyType,
    tokenXWeight: strategy.type === 'single_side_y' ? 0 : 50,
    tokenYWeight: strategy.type === 'single_side_y' ? 100 : 50,
  };
}
