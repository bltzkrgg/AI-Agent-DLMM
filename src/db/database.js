import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '../../data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT NOT NULL,
    position_address TEXT NOT NULL UNIQUE,
    token_x TEXT NOT NULL,
    token_y TEXT NOT NULL,
    token_x_amount REAL DEFAULT 0,
    token_y_amount REAL DEFAULT 0,
    deployed_sol REAL DEFAULT 0,
    entry_price REAL,
    deployed_usd REAL DEFAULT 0,
    pnl_usd REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    fees_collected_usd REAL DEFAULT 0,
    range_efficiency_pct REAL DEFAULT 0,
    strategy_used TEXT,
    close_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    status TEXT DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrasi kolom — setiap ALTER dijalankan sendiri supaya error satu tidak block yang lain
const migrations = [
  'ALTER TABLE positions ADD COLUMN pnl_usd REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN pnl_pct REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN fees_collected_usd REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN strategy_used TEXT',
  'ALTER TABLE positions ADD COLUMN close_reason TEXT',
  'ALTER TABLE positions ADD COLUMN deployed_usd REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN range_efficiency_pct REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN deployed_sol REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN token_x_symbol TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* kolom sudah ada, skip */ }
}

export function savePosition(data) {
  return db.prepare(`
    INSERT OR IGNORE INTO positions
    (pool_address, position_address, token_x, token_y, token_x_amount, token_y_amount, deployed_sol, entry_price, deployed_usd, strategy_used, token_x_symbol)
    VALUES (@pool_address, @position_address, @token_x, @token_y, @token_x_amount, @token_y_amount, @deployed_sol, @entry_price, @deployed_usd, @strategy_used, @token_x_symbol)
  `).run({
    pool_address:     data.pool_address,
    position_address: data.position_address,
    token_x:          data.token_x,
    token_y:          data.token_y,
    token_x_amount:   data.token_x_amount  || 0,
    token_y_amount:   data.token_y_amount  || 0,
    deployed_sol:     data.deployed_sol    || 0,
    entry_price:      data.entry_price     || 0,
    deployed_usd:     data.deployed_usd    || 0,
    strategy_used:    data.strategy_used   || null,
    token_x_symbol:   data.token_x_symbol  || null,
  });
}

export function getOpenPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY created_at DESC`).all();
}

export function closePosition(positionAddress) {
  return db.prepare(`
    UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(positionAddress);
}

export function closePositionWithPnl(positionAddress, { pnlUsd, pnlPct, feesUsd, closeReason }) {
  return db.prepare(`
    UPDATE positions SET 
      status = 'closed', 
      closed_at = CURRENT_TIMESTAMP,
      pnl_usd = ?,
      pnl_pct = ?,
      fees_collected_usd = ?,
      close_reason = ?
    WHERE position_address = ?
  `).run(pnlUsd || 0, pnlPct || 0, feesUsd || 0, closeReason || 'unknown', positionAddress);
}

export function updatePositionStatus(positionAddress, status) {
  return db.prepare(`UPDATE positions SET status = ? WHERE position_address = ?`).run(status, positionAddress);
}

export function getClosedPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC`).all();
}

export function getPositionStats() {
  const closed = db.prepare(`SELECT * FROM positions WHERE status = 'closed'`).all();
  const open = db.prepare(`SELECT COUNT(*) as count FROM positions WHERE status = 'open'`).get();

  if (closed.length === 0) {
    return {
      openPositions: open.count,
      closedPositions: 0,
      winRate: 'N/A',
      avgPnl: 'N/A',
      totalPnlUsd: 0,
      totalFeesUsd: 0,
    };
  }

  const winners = closed.filter(p => (p.pnl_usd || 0) > 0);
  const totalPnl = closed.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const totalFees = closed.reduce((s, p) => s + (p.fees_collected_usd || 0), 0);

  return {
    openPositions: open.count,
    closedPositions: closed.length,
    winRate: ((winners.length / closed.length) * 100).toFixed(1) + '%',
    avgPnl: '$' + (totalPnl / closed.length).toFixed(2),
    totalPnlUsd: totalPnl.toFixed(2),
    totalFeesUsd: totalFees.toFixed(2),
  };
}

export function getPoolStats(poolAddress) {
  const positions = db.prepare(`
    SELECT * FROM positions WHERE pool_address = ? AND status = 'closed' ORDER BY closed_at DESC
  `).all(poolAddress);
  if (!positions.length) return null;

  const winners = positions.filter(p => (p.pnl_usd || 0) > 0);
  const avgPnlPct = positions.reduce((s, p) => s + (p.pnl_pct || 0), 0) / positions.length;
  const avgRangeEff = positions.filter(p => p.range_efficiency_pct > 0);
  const reasonCounts = {};
  for (const p of positions) {
    const r = p.close_reason || 'unknown';
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  const dominantCloseReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    poolAddress,
    totalDeploys: positions.length,
    winRate: parseFloat((winners.length / positions.length * 100).toFixed(1)),
    avgPnlPct: parseFloat(avgPnlPct.toFixed(2)),
    avgRangeEfficiency: avgRangeEff.length
      ? parseFloat((avgRangeEff.reduce((s, p) => s + p.range_efficiency_pct, 0) / avgRangeEff.length).toFixed(1))
      : null,
    dominantCloseReason,
    lastDeployedAt: positions[0]?.closed_at || null,
  };
}

export function saveNotification(type, message) {
  // Deduplicate — don't send same notification within 30 minutes
  const recent = db.prepare(`
    SELECT id FROM notifications 
    WHERE type = ? AND message = ? AND sent_at > datetime('now', '-30 minutes')
  `).get(type, message);
  if (recent) return null;
  return db.prepare(`INSERT INTO notifications (type, message) VALUES (?, ?)`).run(type, message);
}

export function getConversationHistory(limit = 20) {
  return db.prepare(`
    SELECT role, content FROM conversation_history
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse();
}

export function addToHistory(role, content) {
  db.prepare(`INSERT INTO conversation_history (role, content) VALUES (?, ?)`).run(role, String(content));
  db.prepare(`
    DELETE FROM conversation_history WHERE id NOT IN (
      SELECT id FROM conversation_history ORDER BY created_at DESC LIMIT 50
    )
  `).run();
}

export default db;
