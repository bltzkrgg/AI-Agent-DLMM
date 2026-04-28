/**
 * src/db/database.js — In-Memory State Store (Linear Sniper RPC-First)
 *
 * Pengganti DB lokal (SQLite/file). Semua state hidup di process memory.
 * Sumber kebenaran posisi = on-chain via RPC, bukan database lokal.
 *
 * CATATAN: Data hilang saat process restart — by design.
 * Gunakan getPoolInfoFromChain() / RPC untuk reconcile saat boot.
 */

'use strict';

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── In-memory stores ──────────────────────────────────────────────

/** @type {Map<string, Object>} positionAddress → position object */
const _positions = new Map();

/** @type {Array<Object>} Closed position records (append-only, max 500) */
const _closedPositions = [];
const MAX_CLOSED = 500;

/** @type {Array<Object>} Operation log (append-only, max 200) */
const _operationLog = [];
const MAX_OPS = 200;

/** @type {Array<Object>} Conversation history with AI (max 50 turns) */
const _conversationHistory = [];
const MAX_HISTORY = 50;

/** @type {Array<Object>} Notification log (max 100) */
const _notifications = [];
const MAX_NOTIFS = 100;

/** @type {Array<Object>} Screening events (max 500) */
const _screeningEvents = [];
const MAX_SCREENING = 500;

function nowIso() { return new Date().toISOString(); }
function todayKey() { return new Date().toISOString().slice(0, 10); }
function nowMs()  { return Date.now(); }

function getDailyPnlStatePath() {
  return process.env.BOT_DAILY_PNL_PATH || join(process.cwd(), 'daily-pnl-state.json');
}

function getDailyPnlLedgerPath() {
  return process.env.BOT_DAILY_PNL_LEDGER_PATH || join(process.cwd(), 'daily-pnl-ledger.jsonl');
}

function loadDailyPnlState() {
  const fallback = { date: todayKey(), totalPnlUsd: 0, totalFeesUsd: 0, trades: 0 };
  const path = getDailyPnlStatePath();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.date !== todayKey()) return fallback;
    return {
      date: raw.date,
      totalPnlUsd: Number(raw.totalPnlUsd) || 0,
      totalFeesUsd: Number(raw.totalFeesUsd) || 0,
      trades: Number(raw.trades) || 0,
    };
  } catch {
    return fallback;
  }
}

function saveDailyPnlState(state) {
  writeFileSync(getDailyPnlStatePath(), JSON.stringify(state, null, 2));
}

function appendDailyPnlLedger(row) {
  try {
    appendFileSync(getDailyPnlLedgerPath(), `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // non-fatal: state snapshot remains the circuit-breaker source of truth
  }
}

// ── Position API ──────────────────────────────────────────────────

export function savePosition(pos) {
  if (!pos?.position_address) return null;
  const existing = _positions.get(pos.position_address) || {};
  const merged = { ...existing, ...pos, updated_at: nowIso() };
  if (!merged.created_at) merged.created_at = nowIso();
  if (!merged.status) merged.status = 'open';
  _positions.set(pos.position_address, merged);
  return merged;
}

export function getOpenPositions() {
  return [..._positions.values()].filter(p => p.status === 'open');
}

export function getPartialOpenPositions(limit = 8) {
  return [..._positions.values()]
    .filter(p => p.status === 'open' && ['deploying', 'open_partial'].includes(p.lifecycle_state))
    .slice(0, limit);
}

export function getPositionByAddress(addr) {
  return _positions.get(addr) || null;
}

export function updatePositionStatus(addr, status) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  pos.status = status;
  pos.updated_at = nowIso();
  if (status === 'closed') pos.closed_at = nowIso();
  _positions.set(addr, pos);
  return pos;
}

export function updatePositionLifecycle(addr, lifecycleState, opts = {}) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  pos.lifecycle_state = lifecycleState;
  pos.updated_at = nowIso();
  if (opts.force) pos.force_closed = true;
  _positions.set(addr, pos);
  return pos;
}

export function updateLivePositionStats(addr, stats = {}) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  Object.assign(pos, stats, { updated_at: nowIso() });
  _positions.set(addr, pos);
  return pos;
}

export function updatePositionPeakPnl(addr, peakPnlPct) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  if (!Number.isFinite(pos.peak_pnl_pct) || peakPnlPct > pos.peak_pnl_pct) {
    pos.peak_pnl_pct = peakPnlPct;
    pos.updated_at = nowIso();
    _positions.set(addr, pos);
  }
  return pos;
}

export function closePositionWithPnl(addr, pnlData = {}) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  const closed = {
    ...pos,
    ...pnlData,
    close_reason: pnlData.closeReason ?? pos.close_reason ?? null,
    pnl_pct: pnlData.pnlPct ?? pos.pnl_pct ?? null,
    fees_usd: pnlData.feesUsd ?? pos.fees_usd ?? null,
    lifecycle_state: pnlData.lifecycleState ?? pos.lifecycle_state ?? 'closed',
    status: 'closed',
    closed_at: nowIso(),
    updated_at: nowIso(),
  };
  _positions.set(addr, closed);
  _closedPositions.unshift(closed);
  if (_closedPositions.length > MAX_CLOSED) _closedPositions.length = MAX_CLOSED;
  return closed;
}

export function getClosedPositions(limit = 50) {
  return _closedPositions.slice(0, limit);
}

export function recordFeesClaimed(addr, feesData = {}) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  pos.fees_claimed = (pos.fees_claimed || 0) + (feesData.amountSol || 0);
  pos.last_claim_at = nowIso();
  pos.updated_at = nowIso();
  _positions.set(addr, pos);
  return pos;
}

export function recordPnlDivergenceEvent(addr, data = {}) {
  const pos = _positions.get(addr);
  if (!pos) return null;
  if (!Array.isArray(pos.pnl_divergence_events)) pos.pnl_divergence_events = [];
  pos.pnl_divergence_events.push({ ...data, ts: nowIso() });
  _positions.set(addr, pos);
  return pos;
}

// ── Position Stats ────────────────────────────────────────────────

export function getPositionStats() {
  const open = getOpenPositions();
  const closed = _closedPositions;
  const wins = closed.filter(p => (p.pnl_pct || 0) > 0).length;
  return {
    openCount: open.length,
    closedCount: closed.length,
    winRate: closed.length > 0 ? (wins / closed.length) : 0,
    avgPnlPct: closed.length > 0
      ? closed.reduce((s, p) => s + (p.pnl_pct || 0), 0) / closed.length
      : 0,
  };
}

// ── Operation Log ─────────────────────────────────────────────────

export function createOperationLog(data = {}) {
  const op = {
    id: `op_${nowMs()}_${Math.random().toString(36).slice(2, 7)}`,
    status: 'pending',
    created_at: nowIso(),
    ...data,
  };
  _operationLog.unshift(op);
  if (_operationLog.length > MAX_OPS) _operationLog.length = MAX_OPS;
  return op;
}

export function updateOperationLog(id, updates = {}) {
  const op = _operationLog.find(o => o.id === id);
  if (!op) return null;
  Object.assign(op, updates, { updated_at: nowIso() });
  return op;
}

export function getActiveOperation() {
  return _operationLog.find(o => o.status === 'pending' || o.status === 'running') || null;
}

export function listRecentOperations(limitHours = 6, limit = 20) {
  const cutoff = Date.now() - limitHours * 60 * 60 * 1000;
  return _operationLog
    .filter(o => new Date(o.created_at).getTime() > cutoff)
    .slice(0, limit);
}

export function listRecentFailedOperations(limitHours = 6, limit = 10) {
  const cutoff = Date.now() - limitHours * 60 * 60 * 1000;
  return _operationLog
    .filter(o => o.status === 'failed' && new Date(o.created_at).getTime() > cutoff)
    .slice(0, limit);
}

export function listPendingReconcileIssues(limit = 50) {
  return _operationLog
    .filter(o => o.needsReconcile === true && o.status !== 'resolved')
    .slice(0, limit);
}

// ── Conversation History ──────────────────────────────────────────

export function getConversationHistory(limit = 20) {
  return _conversationHistory.slice(-limit);
}

export function addToHistory(entry) {
  if (!entry) return;
  _conversationHistory.push({ ...entry, ts: nowIso() });
  if (_conversationHistory.length > MAX_HISTORY) {
    _conversationHistory.splice(0, _conversationHistory.length - MAX_HISTORY);
  }
}

// ── Notifications ─────────────────────────────────────────────────

export function saveNotification(data = {}) {
  _notifications.unshift({ ...data, ts: nowIso() });
  if (_notifications.length > MAX_NOTIFS) _notifications.length = MAX_NOTIFS;
}

// ── Screening Events ──────────────────────────────────────────────

export async function recordScreeningEvent(data = {}) {
  _screeningEvents.unshift({ ...data, ts: nowIso() });
  if (_screeningEvents.length > MAX_SCREENING) _screeningEvents.length = MAX_SCREENING;
}

export function getScreeningEvents(limit = 50) {
  return _screeningEvents.slice(0, limit);
}

// ── PnL Recording (daily tracker) ────────────────────────────────

const _dailyPnl = loadDailyPnlState();

export function recordPnlUsd(pnlUsd = 0, feesUsd = 0) {
  const today = todayKey();
  if (_dailyPnl.date !== today) {
    _dailyPnl.date = today;
    _dailyPnl.totalPnlUsd = 0;
    _dailyPnl.totalFeesUsd = 0;
    _dailyPnl.trades = 0;
  }
  _dailyPnl.totalPnlUsd += pnlUsd;
  _dailyPnl.totalFeesUsd += feesUsd;
  _dailyPnl.trades++;
  saveDailyPnlState(_dailyPnl);
  appendDailyPnlLedger({
    ts: nowIso(),
    date: _dailyPnl.date,
    pnlUsd: Number(pnlUsd) || 0,
    feesUsd: Number(feesUsd) || 0,
    totalPnlUsd: _dailyPnl.totalPnlUsd,
    totalFeesUsd: _dailyPnl.totalFeesUsd,
    trades: _dailyPnl.trades,
  });
}

export function getTodayResults() {
  const restored = loadDailyPnlState();
  _dailyPnl.date = restored.date;
  _dailyPnl.totalPnlUsd = restored.totalPnlUsd;
  _dailyPnl.totalFeesUsd = restored.totalFeesUsd;
  _dailyPnl.trades = restored.trades;
  const today = todayKey();
  if (_dailyPnl.date !== today) return { totalPnlUsd: 0, totalFeesUsd: 0, trades: 0 };
  return { ..._dailyPnl };
}

// ── Exit Tracking (stub — RPC-First tidak butuh persisten) ────────

export function recordExitEvent(data = {}) {
  // no-op in stateless mode — exit events di-track via on-chain state
  void data;
}

export function recordCircuitBreakerEvent(data = {}) {
  void data;
}

export function getStat(key) {
  // Deprecated in RPC-First — return null gracefully
  void key;
  return null;
}
