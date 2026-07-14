/**
 * src/learn/tokenBlacklist.js — Persistent Token Blacklist (File-based)
 *
 * Token yang terkena STOP_LOSS, RUGPULL, atau PARTIAL_DEPLOY_ROLLBACK
 * otomatis ditambahkan ke blacklist.json. Agent menolak entry pada
 * mint yang ada di daftar ini.
 *
 * Format blacklist.json:
 * {
 *   "MintAddress123...": {
 *     "token": "REKT",
 *     "reason": "STOP_LOSS",
 *     "note": "PnL -15%",
 *     "ts": "2026-04-26T12:00:00.000Z",
 *     "expires": null  // null = permanent, atau ISO timestamp
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const BLACKLIST_FILE = join(__dirname, '../../blacklist.json');

// Auto-expire default: 7 hari untuk SL biasa, permanent untuk rugpull
const EXPIRE_DAYS_DEFAULT  = 7;
const EXPIRE_DAYS_RUGPULL  = null; // permanent

// ── Helpers ───────────────────────────────────────────────────────

function readBlacklistRaw() {
  if (!existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BLACKLIST_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeBlacklistRaw(data) {
  try {
    writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[blacklist] write error: ${e.message}`);
  }
}

// ── addToBlacklist ────────────────────────────────────────────────

export function addToBlacklist(mint, {
  token  = 'UNKNOWN',
  reason = 'STOP_LOSS',
  note   = '',
  permanent = false,
} = {}) {
  if (!mint || typeof mint !== 'string') return;

  const isRug     = reason.toLowerCase().includes('rug') || reason.toLowerCase().includes('dump');
  const expireDays = permanent || isRug ? EXPIRE_DAYS_RUGPULL : EXPIRE_DAYS_DEFAULT;
  const expires   = expireDays
    ? new Date(Date.now() + expireDays * 86400_000).toISOString()
    : null;

  const data = readBlacklistRaw();
  data[mint] = {
    token,
    reason,
    note:    String(note).slice(0, 200),
    ts:      new Date().toISOString(),
    expires,
  };
  writeBlacklistRaw(data);
  console.log(`[blacklist] 🚫 ${token} (${mint.slice(0,8)}) ditambahkan — reason: ${reason}`);
}

// ── isBlacklisted ─────────────────────────────────────────────────

export function isBlacklisted(mint) {
  if (!mint) return false;
  // Cek allowlist dulu — unblock override blacklist lokal
  if (isUnblocked(mint)) return false;
  const data  = readBlacklistRaw();
  const entry = data[mint];
  if (!entry) return false;

  // Cek expiry
  if (entry.expires && new Date(entry.expires).getTime() < Date.now()) {
    // Entry expired — hapus secara lazy
    delete data[mint];
    writeBlacklistRaw(data);
    return false;
  }
  return true;
}


// ── getBlacklistEntry ─────────────────────────────────────────────

export function getBlacklistEntry(mint) {
  if (!mint) return null;
  const data = readBlacklistRaw();
  return data[mint] || null;
}

// ── readBlacklist ─────────────────────────────────────────────────
// Return semua entry yang belum expired, diurutkan dari terbaru

export function readBlacklist() {
  const data = readBlacklistRaw();
  const now  = Date.now();
  return Object.entries(data)
    .filter(([, e]) => !e.expires || new Date(e.expires).getTime() > now)
    .map(([mint, e]) => ({ mint, ...e }))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

// ── removeFromBlacklist ───────────────────────────────────────────

export function removeFromBlacklist(mint) {
  const data = readBlacklistRaw();
  if (data[mint]) {
    delete data[mint];
    writeBlacklistRaw(data);
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════
// ALLOWLIST (UNBLOCK) — token-level exception untuk blacklist lokal
// ══════════════════════════════════════════════════════════════════
// Format unblock.json:
// {
//   "MintAddress123...": {
//     "token": "bcat",
//     "operator": "manual_telegram",
//     "note": "potensi recovery",
//     "unblockedAt": "2026-07-14T00:00:00.000Z"
//   }
// }
// PENTING: unblock hanya berlaku untuk blacklist lokal.
// Gate GMGN, Meridian, FlatConfig, dll. tetap berjalan normal.

const UNBLOCK_FILE = join(__dirname, '../../unblock.json');

function readUnblockRaw() {
  if (!existsSync(UNBLOCK_FILE)) return {};
  try {
    return JSON.parse(readFileSync(UNBLOCK_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeUnblockRaw(data) {
  try {
    writeFileSync(UNBLOCK_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[unblock] write error: ${e.message}`);
  }
}

// ── addToUnblocklist ──────────────────────────────────────────────

export function addToUnblocklist(mint, {
  token    = 'UNKNOWN',
  operator = 'manual_telegram',
  note     = '',
} = {}) {
  if (!mint || typeof mint !== 'string') return false;
  const data = readUnblockRaw();
  data[mint] = {
    token,
    operator,
    note:        String(note).slice(0, 200),
    unblockedAt: new Date().toISOString(),
  };
  writeUnblockRaw(data);
  console.log(`[unblock] 🔓 ${token} (${mint.slice(0, 8)}) di-unblock — note: ${note || '-'}`);
  return true;
}

// ── isUnblocked ───────────────────────────────────────────────────

export function isUnblocked(mint) {
  if (!mint) return false;
  const data = readUnblockRaw();
  return Boolean(data[mint]);
}

// ── readUnblocklist ───────────────────────────────────────────────

export function readUnblocklist() {
  const data = readUnblockRaw();
  return Object.entries(data)
    .map(([mint, e]) => ({ mint, ...e }))
    .sort((a, b) => new Date(b.unblockedAt) - new Date(a.unblockedAt));
}

// ── removeFromUnblocklist ─────────────────────────────────────────

export function removeFromUnblocklist(mint) {
  const data = readUnblockRaw();
  if (data[mint]) {
    delete data[mint];
    writeUnblockRaw(data);
    return true;
  }
  return false;
}

