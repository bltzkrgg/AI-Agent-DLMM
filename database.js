import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '../../data.db'));

// Setup tables
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT NOT NULL,
    position_address TEXT NOT NULL,
    token_x TEXT NOT NULL,
    token_y TEXT NOT NULL,
    token_x_amount REAL DEFAULT 0,
    token_y_amount REAL DEFAULT 0,
    entry_price REAL,
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

export function savePosition(data) {
  const stmt = db.prepare(`
    INSERT INTO positions (pool_address, position_address, token_x, token_y, entry_price)
    VALUES (@pool_address, @position_address, @token_x, @token_y, @entry_price)
  `);
  return stmt.run(data);
}

export function getOpenPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
}

export function closePosition(positionAddress) {
  return db.prepare(`
    UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(positionAddress);
}

export function updatePositionStatus(positionAddress, status) {
  return db.prepare(`
    UPDATE positions SET status = ? WHERE position_address = ?
  `).run(status, positionAddress);
}

export function getClosedPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC`).all();
}

export function getPositionStats() {
  const all = db.prepare(`SELECT * FROM positions`).all();
  const closed = all.filter(p => p.status === 'closed');
  const open = all.filter(p => p.status === 'open');

  return {
    totalPositions: all.length,
    openPositions: open.length,
    closedPositions: closed.length,
    winRate: closed.length > 0
      ? ((closed.filter(p => (p.pnl || 0) > 0).length / closed.length) * 100).toFixed(1) + '%'
      : 'N/A',
    avgPnl: closed.length > 0
      ? (closed.reduce((sum, p) => sum + (p.pnl || 0), 0) / closed.length).toFixed(4)
      : 'N/A',
  };
}

export function saveNotification(type, message) {
  return db.prepare(`
    INSERT INTO notifications (type, message) VALUES (?, ?)
  `).run(type, message);
}

export function getConversationHistory(limit = 20) {
  return db.prepare(`
    SELECT role, content FROM conversation_history
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse();
}

export function addToHistory(role, content) {
  db.prepare(`
    INSERT INTO conversation_history (role, content) VALUES (?, ?)
  `).run(role, content);

  // Keep only last 50 messages
  db.prepare(`
    DELETE FROM conversation_history WHERE id NOT IN (
      SELECT id FROM conversation_history ORDER BY created_at DESC LIMIT 50
    )
  `).run();
}

export default db;
