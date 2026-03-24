import Database from 'better-sqlite3';
import path from 'path';

// 🔥 FIX path (biar aman di codespace / prod)
const dbPath = path.resolve(process.cwd(), 'data.db');
const db = new Database(dbPath);

// ================= INIT =================
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
`);

// ================= SEED =================
db.prepare(`
INSERT OR IGNORE INTO strategies (name, description, strategy_type, parameters, created_by)
VALUES (?, ?, ?, ?, ?)
`).run(
  'Volatility Breakout',
  'Wide range for high volatility',
  'volatility',
  JSON.stringify({
    volatilityMin: 0.03,
    range: 10,
    tp: 5,
    sl: -7
  }),
  'system'
);

// ================= HELPERS =================

export function parseParams(p) {
  try {
    return typeof p === 'string' ? JSON.parse(p) : p;
  } catch {
    return {};
  }
}

// 🔥 convert ke format bot
export function normalizeStrategy(row) {
  const params = parseParams(row.parameters);

  return {
    name: row.name,
    description: row.description,

    conditions: {
      volatilityMin: params.volatilityMin || 0,
    },

    params: {
      range: params.range || 5,
      tp: params.tp || 3,
      sl: params.sl || -5,
    },
  };
}

// ================= GET =================

export function getAllStrategies() {
  const rows = db
    .prepare(`SELECT * FROM strategies WHERE is_active = 1`)
    .all();

  return rows.map(normalizeStrategy);
}

export function getStrategyByName(name) {
  const row = db
    .prepare(`SELECT * FROM strategies WHERE name = ? AND is_active = 1`)
    .get(name);

  return row ? normalizeStrategy(row) : null;
}

// ================= ADD =================

export function addStrategy({ name, description, parameters }) {
  // 🔥 VALIDATION WAJIB
  if (!name) throw new Error('Strategy name required');

  const params = {
    volatilityMin: parameters.volatilityMin || 0,
    range: parameters.range || 5,
    tp: parameters.tp || 3,
    sl: parameters.sl || -5,
  };

  try {
    const result = db.prepare(`
      INSERT INTO strategies (name, description, strategy_type, parameters)
      VALUES (?, ?, ?, ?)
    `).run(
      name,
      description || '',
      'custom',
      JSON.stringify(params)
    );

    return result.lastInsertRowid;
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      throw new Error(`Strategy "${name}" already exists`);
    }
    throw e;
  }
}

// ================= UPDATE =================

export function updateStrategy(name, parameters) {
  const params = JSON.stringify(parameters);

  const result = db.prepare(`
    UPDATE strategies
    SET parameters = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?
  `).run(params, name);

  return result.changes > 0;
}

// ================= DELETE =================

export function deleteStrategy(name) {
  const result = db.prepare(`
    UPDATE strategies
    SET is_active = 0
    WHERE name = ? AND created_by != 'system'
  `).run(name);

  return result.changes > 0;
}

export default db;
