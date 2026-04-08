import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '../../data.db'));

// Setup strategy tables
db.exec(`
  CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    strategy_type TEXT NOT NULL,
    parameters TEXT NOT NULL,
    logic TEXT,
    created_by TEXT DEFAULT 'admin',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Seed default strategies kalau belum ada
  INSERT OR IGNORE INTO strategies (name, description, strategy_type, parameters, created_by) VALUES
  (
    'Spot Balanced',
    'Distribusi likuiditas merata di sekitar harga aktif. Cocok untuk market sideways.',
    'spot',
    '{"priceRangePercent": 5, "binStep": 10, "strategyType": 0}',
    'system'
  ),
  (
    'Curve Concentrated',
    'Likuiditas terkonsentrasi di tengah range. Maksimalkan fee tapi lebih cepat out of range.',
    'curve',
    '{"priceRangePercent": 3, "binStep": 5, "strategyType": 1}',
    'system'
  ),
  (
    'Bid-Ask Wide',
    'Spread lebar, cocok untuk aset volatile. Lebih tahan terhadap pergerakan harga ekstrem.',
    'bid_ask',
    '{"priceRangePercent": 15, "binStep": 20, "strategyType": 2}',
    'system'
  ),
  (
    'Evil Panda',
    'STRATEGI UTAMA. Single-side SOL pada high-volume coins. Entry saat price break atas Supertrend 15m. Exit confluence RSI(2)>90 + BB upper ATAU RSI(2)>90 + MACD first green. Pilih pool bin step 80/100/125.',
    'single_side_y',
    '{"fixedBinsBelow": 69, "binStep": 100, "strategyType": 0, "tokenXWeight": 0, "tokenYWeight": 100, "singleSide": "y", "preferredBinSteps": [80, 100, 125], "minMcap": 250000, "minVolume24h": 1000000, "binPadding": 1}',
    'system'
  ),
  (
    'Wave Enjoyer',
    'STRATEGI CADANGAN 1. Single-side SOL untuk tangkap 1-2 wave retracement. Entry dekat latest support, volume 5m minimal $100k, hold 10-20 menit.',
    'single_side_y',
    '{"fixedBinsBelow": 24, "binStep": 80, "strategyType": 0, "tokenXWeight": 0, "tokenYWeight": 100, "singleSide": "y", "minVolume5mUsd": 100000, "holdMinMinutes": 10, "holdMaxMinutes": 20, "binPadding": 1}',
    'system'
  ),
  (
    'NPC',
    'STRATEGI CADANGAN 2. Single-side SOL setelah volume spike / ATH. Default 70 bin, volume 5m minimal $50k, hold 30 menit sampai 6 jam.',
    'single_side_y',
    '{"fixedBinsBelow": 69, "binStep": 80, "strategyType": 0, "tokenXWeight": 0, "tokenYWeight": 100, "singleSide": "y", "minVolume5mUsd": 50000, "holdMinMinutes": 30, "holdMaxMinutes": 360, "binPadding": 1}',
    'system'
  );
`);

export function getAllStrategies() {
  return db.prepare(`SELECT * FROM strategies WHERE is_active = 1 ORDER BY created_at DESC`).all();
}

export function getStrategyByName(name) {
  return db.prepare(`SELECT * FROM strategies WHERE name = ? AND is_active = 1`).get(name);
}

export function getStrategyById(id) {
  return db.prepare(`SELECT * FROM strategies WHERE id = ? AND is_active = 1`).get(id);
}

export function addStrategy({ name, description, strategyType, parameters, logic, createdBy }) {
  try {
    const paramsStr = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
    const result = db.prepare(`
      INSERT INTO strategies (name, description, strategy_type, parameters, logic, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, description, strategyType, paramsStr, logic || null, createdBy || 'admin');
    return { success: true, id: result.lastInsertRowid };
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      throw new Error(`Strategi dengan nama "${name}" sudah ada.`);
    }
    throw e;
  }
}

export function updateStrategy(name, updates) {
  const fields = [];
  const values = [];

  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.parameters !== undefined) { fields.push('parameters = ?'); values.push(JSON.stringify(updates.parameters)); }
  if (updates.logic !== undefined) { fields.push('logic = ?'); values.push(updates.logic); }
  if (updates.strategyType !== undefined) { fields.push('strategy_type = ?'); values.push(updates.strategyType); }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(name);

  const result = db.prepare(`UPDATE strategies SET ${fields.join(', ')} WHERE name = ?`).run(...values);
  return result.changes > 0;
}

export function deleteStrategy(name) {
  // Soft delete
  const result = db.prepare(`UPDATE strategies SET is_active = 0 WHERE name = ? AND created_by != 'system'`).run(name);
  return result.changes > 0;
}

export function parseStrategyParameters(strategy) {
  try {
    return typeof strategy.parameters === 'string'
      ? JSON.parse(strategy.parameters)
      : strategy.parameters;
  } catch {
    return {};
  }
}

export default db;
