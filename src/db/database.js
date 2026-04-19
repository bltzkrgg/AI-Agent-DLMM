import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DbBackup } from './backup.js';
import { safeStringify } from '../utils/serializer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BOT_DB_PATH || join(__dirname, '../../data.db');
let db;

// Initialize database with integrity check and recovery
function initializeDatabase() {
  try {
    db = new Database(DB_PATH);

    // Quick integrity check
    db.prepare("PRAGMA integrity_check").all();
    console.log('✅ Database integrity check passed');

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    console.log('⚡ SQLite WAL mode enabled');

    return db;
  } catch (e) {
    const message = String(e?.message || '');
    const isNativeBindingIssue =
      message.includes('NODE_MODULE_VERSION') ||
      message.includes('Could not locate the bindings file') ||
      message.includes('compiled against a different Node.js version');

    if (isNativeBindingIssue) {
      console.error('❌ SQLite native binding unavailable:', e.message);
      throw new Error(`better-sqlite3 native binding tidak cocok dengan Node.js aktif. Jalankan "npm rebuild better-sqlite3" atau pakai versi Node yang sesuai.`);
    }

    console.error('❌ Database corrupted or unreadable:', e.message);

    // Attempt recovery from backup
    const backup = new DbBackup(DB_PATH);
    const recovered = backup.attemptRecoverySync?.();

    if (recovered) {
      // Try to open recovered DB
      try {
        db = new Database(DB_PATH);
        db.prepare("PRAGMA integrity_check").all();
        console.log('✅ Database recovered and integrity check passed');
        return db;
      } catch (e2) {
        console.error('❌ Recovered database still invalid:', e2.message);
        throw e2;
      }
    } else {
      throw new Error('Database corrupted and no valid backup available. Manual intervention required.');
    }
  }
}

// Synchronous recovery attempt (called during startup)
DbBackup.prototype.attemptRecoverySync = function () {
  console.warn('⚠️ Database corrupted, attempting recovery...');

  const backups = this.listBackups();
  if (backups.length === 0) {
    console.error('❌ No backups available for recovery');
    return false;
  }

  for (const backup of backups) {
    try {
      console.log(`Trying backup: ${backup.name}`);
      this.restore(backup.path);
      return true;
    } catch (e) {
      console.warn(`⚠️ Failed to recover from ${backup.name}:`, e.message);
      continue;
    }
  }

  return false;
};

// ─── Singleton Database Instance & Mutex ─────────────────────────
db = initializeDatabase();
globalThis.db = db; // Sledgehammer fix: Make db globally accessible to the process

/**
 * Mutex Queue to prevent SQLITE_BUSY during concurrent Hunter/Healer execution.
 * Even though better-sqlite3 is synchronous, concurrent write attempts from 
 * different async callbacks can still trigger contention in WAL mode.
 */
const queue = [];
let processing = false;

function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  while (queue.length > 0) {
    const { task, resolve, reject } = queue.shift();
    try {
      const res = task();
      resolve(res);
    } catch (err) {
      reject(err);
    }
  }
  processing = false;
}

export function runInQueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    processQueue();
  });
}

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
    lifecycle_state TEXT DEFAULT 'open',
    pnl_sol REAL DEFAULT 0,
    fees_collected_sol REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

  CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,
    entity_id TEXT,
    status TEXT NOT NULL,
    payload TEXT,
    result TEXT,
    metadata TEXT,
    error_message TEXT,
    tx_hashes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reconcile_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS app_stats (
    key TEXT PRIMARY KEY,
    value REAL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_address TEXT NOT NULL UNIQUE,
    pool_address TEXT NOT NULL,
    token_mint TEXT,

    -- Entry timing
    entry_time TEXT,
    entry_price REAL,

    -- Exit timing & price
    exit_time TEXT,
    exit_price REAL,
    hold_minutes INTEGER,

    -- PnL & returns
    pnl_pct REAL,
    pnl_usd REAL,
    fees_claimed_usd REAL,
    total_return_usd REAL,

    -- TAE exit metadata
    exit_trigger TEXT,
    exit_zone TEXT,
    exit_retracement REAL,
    exit_retracement_cap REAL,

    -- Fee & modifier status saat exit
    fee_ratio_at_exit REAL,
    fee_velocity_increasing INTEGER,
    lper_patience_active INTEGER,

    -- Outcome
    profit_or_loss TEXT,
    exit_reason TEXT,
    close_reason_code TEXT,

    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_address) REFERENCES positions(position_address)
  );

  CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT,
    triggered_at INTEGER NOT NULL,
    paused_until INTEGER NOT NULL,
    sl_count INTEGER NOT NULL,
    cb_window_ms INTEGER,
    cb_pause_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pnl_divergence_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_address TEXT,
    pool_address TEXT,
    token_mint TEXT,
    provider_pnl_pct REAL NOT NULL,
    onchain_pnl_pct REAL NOT NULL,
    divergence_pct REAL NOT NULL,
    selected_source TEXT NOT NULL DEFAULT 'lp_agent',
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS screening_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_mint TEXT,
    token_symbol TEXT,
    token_name TEXT,
    pool_address TEXT,
    verdict TEXT NOT NULL,
    eligible INTEGER NOT NULL DEFAULT 0,
    primary_rule TEXT,
    primary_message TEXT,
    gmgn_status TEXT,
    vamped_source_status TEXT,
    total_fees_sol REAL,
    total_fees_source TEXT,
    source_context TEXT,
    high_flags TEXT,
    medium_flags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_active_unique
  ON operation_log(operation_type, IFNULL(entity_id, '__global__'))
  WHERE status IN ('pending', 'in_progress');

  CREATE INDEX IF NOT EXISTS idx_exit_trigger ON exit_events(exit_trigger);
  CREATE INDEX IF NOT EXISTS idx_exit_zone ON exit_events(exit_zone);
  CREATE INDEX IF NOT EXISTS idx_exit_created_at ON exit_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_exit_pool ON exit_events(pool_address);
  CREATE INDEX IF NOT EXISTS idx_pnl_div_pos_created ON pnl_divergence_events(position_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_pnl_div_created_at ON pnl_divergence_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_cb_events_triggered_at ON circuit_breaker_events(triggered_at);
  CREATE INDEX IF NOT EXISTS idx_screening_events_token_created ON screening_events(token_mint, created_at);
  CREATE INDEX IF NOT EXISTS idx_screening_events_verdict_created ON screening_events(verdict, created_at);
  CREATE INDEX IF NOT EXISTS idx_screening_events_created ON screening_events(created_at);
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
  "ALTER TABLE positions ADD COLUMN lifecycle_state TEXT DEFAULT 'open'",
  'ALTER TABLE positions ADD COLUMN pnl_sol REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN fees_collected_sol REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN dev_address TEXT',
  'ALTER TABLE positions ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
  // Fix #1: Add token_mint for proper token identity tracking
  'ALTER TABLE positions ADD COLUMN token_mint TEXT',
  // Fix #1: Track claimed fees separately so unclaimed = collected - claimed
  'ALTER TABLE positions ADD COLUMN fees_claimed_sol REAL DEFAULT 0',
  'ALTER TABLE positions ADD COLUMN fees_claimed_usd REAL DEFAULT 0',
  // Fix #4: Persist trailing TP peak so it survives healer restarts
  'ALTER TABLE positions ADD COLUMN peak_pnl_pct REAL DEFAULT NULL',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    // "duplicate column name" and "already exists" are expected during re-runs — safe to skip.
    // Any other error indicates a real schema problem that should surface.
    const msg = e?.message || '';
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.error('[db] Migration failed (unexpected):', msg, '\nSQL:', sql);
    }
  }
}

export function savePosition(data) {
  return runInQueue(() => db.prepare(`
    INSERT OR IGNORE INTO positions
    (pool_address, position_address, token_x, token_y, token_mint, token_x_amount, token_y_amount, deployed_sol, entry_price, deployed_usd, strategy_used, token_x_symbol, lifecycle_state, pnl_sol, fees_collected_sol)
    VALUES (@pool_address, @position_address, @token_x, @token_y, @token_mint, @token_x_amount, @token_y_amount, @deployed_sol, @entry_price, @deployed_usd, @strategy_used, @token_x_symbol, @lifecycle_state, @pnl_sol, @fees_collected_sol)
  `).run({
    pool_address: data.pool_address,
    position_address: data.position_address,
    token_x: data.token_x,
    token_y: data.token_y,
    token_mint: data.token_mint || data.token_x || null, // token_mint defaults to token_x
    token_x_amount: data.token_x_amount || 0,
    token_y_amount: data.token_y_amount || 0,
    deployed_sol: data.deployed_sol || 0,
    entry_price: data.entry_price || 0,
    deployed_usd: data.deployed_usd || 0,
    strategy_used: data.strategy_used || null,
    token_x_symbol: data.token_x_symbol || null,
    lifecycle_state: data.lifecycle_state || 'open',
    pnl_sol: data.pnl_sol || 0,
    fees_collected_sol: data.fees_collected_sol || 0,
  }));
}

export function recordFeesClaimed(positionAddress, { claimedSol = 0, claimedUsd = 0 }) {
  return runInQueue(() => db.prepare(`
    UPDATE positions SET
      fees_claimed_sol = fees_claimed_sol + ?,
      fees_claimed_usd = fees_claimed_usd + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(claimedSol, claimedUsd, positionAddress));
}

export function getOpenPositions() {
  return db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY created_at DESC`).all();
}

export function closePosition(positionAddress) {
  return runInQueue(() => db.prepare(`
    UPDATE positions SET status = 'closed', lifecycle_state = 'closed_reconciled', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(positionAddress));
}

export function closePositionWithPnl(positionAddress, { pnlUsd, pnlPct, feesUsd, pnlSol, feesSol, closeReason, rangeEfficiencyPct, lifecycleState }) {
  const effPct = rangeEfficiencyPct ?? (
    closeReason === 'TAKE_PROFIT' ? 90 :
      closeReason?.startsWith('TRAILING') ? 85 :
        closeReason === 'OUT_OF_RANGE' ? 20 :
          closeReason === 'STOP_LOSS' ? 15 :
            closeReason === 'CLOSE_FAILED_PURGED' ? 0 :
              closeReason === 'EMPTY_POSITION_PURGED' ? 0 : 50
  );
  return runInQueue(() => db.prepare(`
    UPDATE positions SET
      status = 'closed',
      closed_at = CURRENT_TIMESTAMP,
      pnl_usd = ?,
      pnl_pct = ?,
      fees_collected_usd = ?,
      pnl_sol = ?,
      fees_collected_sol = ?,
      close_reason = ?,
      range_efficiency_pct = ?,
      lifecycle_state = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(
    pnlUsd || 0,
    pnlPct || 0,
    feesUsd || 0,
    pnlSol || 0,
    feesSol || 0,
    closeReason || 'unknown',
    effPct,
    lifecycleState || 'closed_reconciled',
    positionAddress,
  ));
}

export function updatePositionStatus(positionAddress, status) {
  return runInQueue(() => db.prepare(`UPDATE positions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE position_address = ?`).run(status, positionAddress));
}

export async function updatePositionLifecycle(positionAddress, lifecycleState) {
  return runInQueue(() => db.prepare(`
    UPDATE positions
    SET lifecycle_state = ?, updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(lifecycleState, positionAddress));
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

  const winners = closed.filter(p => (p.pnl_sol || p.pnl_usd || 0) > 0);
  const totalPnlUsd = closed.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const totalFeesUsd = closed.reduce((s, p) => s + (p.fees_collected_usd || 0), 0);
  const totalPnlSol = closed.reduce((s, p) => s + (p.pnl_sol || 0), 0);
  const totalFeesSol = closed.reduce((s, p) => s + (p.fees_collected_sol || 0), 0);

  return {
    openPositions: open.count,
    closedPositions: closed.length,
    winRate: ((winners.length / closed.length) * 100).toFixed(1) + '%',
    avgPnl: '◎' + (totalPnlSol / closed.length).toFixed(4),
    totalPnlUsd: totalPnlUsd.toFixed(2),
    totalFeesUsd: totalFeesUsd.toFixed(2),
    totalPnlSol: totalPnlSol.toFixed(4),
    totalFeesSol: totalFeesSol.toFixed(4),
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
  if (recent) return Promise.resolve(null);
  return runInQueue(() => db.prepare(`INSERT INTO notifications (type, message) VALUES (?, ?)`).run(type, message));
}

export function recordPnlDivergenceEvent({
  positionAddress = null,
  poolAddress = null,
  tokenMint = null,
  providerPnlPct,
  onChainPnlPct,
  divergencePct,
  selectedSource = 'lp_agent',
  metadata = null,
}) {
  return runInQueue(() => {
    const recent = db.prepare(`
      SELECT id
      FROM pnl_divergence_events
      WHERE IFNULL(position_address, '') = IFNULL(?, '')
        AND IFNULL(pool_address, '') = IFNULL(?, '')
        AND created_at > datetime('now', '-10 minutes')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(positionAddress, poolAddress);
    if (recent) return recent;

    return db.prepare(`
      INSERT INTO pnl_divergence_events (
        position_address,
        pool_address,
        token_mint,
        provider_pnl_pct,
        onchain_pnl_pct,
        divergence_pct,
        selected_source,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      positionAddress,
      poolAddress,
      tokenMint,
      providerPnlPct,
      onChainPnlPct,
      divergencePct,
      selectedSource,
      metadata ? safeStringify(metadata) : null,
    );
  });
}

export function recordScreeningEvent({
  tokenMint = null,
  tokenSymbol = null,
  tokenName = null,
  poolAddress = null,
  verdict = 'UNKNOWN',
  eligible = false,
  primaryRule = null,
  primaryMessage = null,
  gmgnStatus = null,
  vampedSourceStatus = null,
  totalFeesSol = null,
  totalFeesSource = null,
  sourceContext = 'hunter',
  highFlags = [],
  mediumFlags = [],
}) {
  return runInQueue(() => db.prepare(`
    INSERT INTO screening_events (
      token_mint,
      token_symbol,
      token_name,
      pool_address,
      verdict,
      eligible,
      primary_rule,
      primary_message,
      gmgn_status,
      vamped_source_status,
      total_fees_sol,
      total_fees_source,
      source_context,
      high_flags,
      medium_flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenMint,
    tokenSymbol,
    tokenName,
    poolAddress,
    verdict,
    eligible ? 1 : 0,
    primaryRule,
    primaryMessage,
    gmgnStatus,
    vampedSourceStatus,
    Number.isFinite(totalFeesSol) ? totalFeesSol : null,
    totalFeesSource,
    sourceContext,
    safeStringify(Array.isArray(highFlags) ? highFlags : []),
    safeStringify(Array.isArray(mediumFlags) ? mediumFlags : []),
  ));
}

export function getRecentScreeningEvents(limit = 50) {
  return db.prepare(`
    SELECT *
    FROM screening_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    ...row,
    high_flags: safeJsonParse(row.high_flags, []),
    medium_flags: safeJsonParse(row.medium_flags, []),
  }));
}

export function getConversationHistory(limit = 20) {
  return db.prepare(`
    SELECT role, content FROM conversation_history
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse();
}

export function addToHistory(role, content) {
  return runInQueue(() => {
    db.prepare(`INSERT INTO conversation_history (role, content) VALUES (?, ?)`).run(role, String(content));
    db.prepare(`
      DELETE FROM conversation_history WHERE id NOT IN (
        SELECT id FROM conversation_history ORDER BY created_at DESC LIMIT 50
      )
    `).run();
  });
}

export function getActiveOperation(operationType, entityId = null) {
  if (entityId) {
    return db.prepare(`
      SELECT * FROM operation_log
      WHERE operation_type = ?
        AND entity_id = ?
        AND status IN ('pending', 'in_progress')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(operationType, entityId);
  }
  return db.prepare(`
    SELECT * FROM operation_log
    WHERE operation_type = ?
      AND status IN ('pending', 'in_progress')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(operationType);
}

export function createOperationLog({ operationType, entityId = null, payload = null, metadata = null, status = 'pending' }) {
  return runInQueue(() => db.prepare(`
    INSERT INTO operation_log (operation_type, entity_id, status, payload, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    operationType,
    entityId,
    status,
    payload ? safeStringify(payload) : null,
    metadata ? safeStringify(metadata) : null,
  ));
}

export async function enqueueReconcileIssue({ issueType, entityId, payload = null, notes = null }) {
  return runInQueue(() => db.prepare(`
    INSERT INTO reconcile_queue (issue_type, entity_id, payload, notes)
    VALUES (?, ?, ?, ?)
  `).run(
    issueType,
    entityId,
    payload ? safeStringify(payload) : null,
    notes,
  ));
}

export function listPendingReconcileIssues(limit = 50) {
  return db.prepare(`
    SELECT * FROM reconcile_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

export function resolveReconcileIssue(id, notes = null) {
  return runInQueue(() => db.prepare(`
    UPDATE reconcile_queue
    SET status = 'resolved', notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(notes, id));
}

export function updateOperationLog(id, { status, result, metadata, errorMessage, txHashes }) {
  return runInQueue(() => db.prepare(`
    UPDATE operation_log
    SET
      status = COALESCE(?, status),
      result = COALESCE(?, result),
      metadata = COALESCE(?, metadata),
      error_message = COALESCE(?, error_message),
      tx_hashes = COALESCE(?, tx_hashes),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status ?? null,
    result !== undefined ? safeStringify(result) : null,
    metadata !== undefined ? safeStringify(metadata) : null,
    errorMessage ?? null,
    txHashes !== undefined ? safeStringify(txHashes) : null,
    id,
  ));
}

export function setPendingApproval(key, type, payload = null, expiryMinutes = 60) {
  return runInQueue(() => db.prepare(`
    INSERT OR REPLACE INTO pending_approvals (key, type, payload, expires_at)
    VALUES (?, ?, ?, datetime('now', ?))
  `).run(key, type, payload ? safeStringify(payload) : null, `+${expiryMinutes} minutes`));
}

export function getPendingApproval(key) {
  return db.prepare(`
    SELECT * FROM pending_approvals 
    WHERE key = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).get(key);
}

export function deletePendingApproval(key) {
  return runInQueue(() => db.prepare(`DELETE FROM pending_approvals WHERE key = ?`).run(key));
}

export function incrementStat(key, amount) {
  return runInQueue(() => db.prepare(`
    INSERT INTO app_stats (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = value + excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, amount));
}

export function getStat(key) {
  const row = db.prepare(`SELECT value FROM app_stats WHERE key = ?`).get(key);
  return row ? row.value : 0;
}

function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string' || !str.trim()) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function listRecentOperations(limit = 10) {
  return db.prepare(`
    SELECT * FROM operation_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    ...row,
    result:    safeJsonParse(row.result,    null),
    metadata:  safeJsonParse(row.metadata,  null),
    tx_hashes: safeJsonParse(row.tx_hashes, []),
  }));
}

export function listRecentFailedOperations(hours = 6, limit = 50) {
  return db.prepare(`
    SELECT *
    FROM operation_log
    WHERE status = 'failed'
      AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(`-${Math.max(1, Math.floor(hours))} hours`, limit).map(row => ({
    ...row,
    payload:  safeJsonParse(row.payload,  null),
    metadata: safeJsonParse(row.metadata, null),
  }));
}

export function updatePositionPeakPnl(positionAddress, peakPnlPct) {
  return runInQueue(() => db.prepare(`
    UPDATE positions SET peak_pnl_pct = ?, updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(peakPnlPct, positionAddress));
}

export function updateLivePositionStats(positionAddress, { pnlUsd, pnlPct, feesUsd, pnlSol, feesSol }) {
  return runInQueue(() => db.prepare(`
    UPDATE positions SET 
      pnl_usd = ?, 
      pnl_pct = ?, 
      fees_collected_usd = ?,
      pnl_sol = ?,
      fees_collected_sol = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE position_address = ?
  `).run(pnlUsd, pnlPct, feesUsd, pnlSol, feesSol, positionAddress));
}

export default db;
