/**
 * src/learn/decisionLog.js — Screening Decision Logger (Stateless)
 *
 * Setiap token yang diproses oleh screening/VETO pipeline dicatat ke
 * decision.log dalam format JSONL (1 JSON per baris).
 *
 * Fields:
 *   ts        — ISO timestamp
 *   token     — symbol token
 *   mint      — mint address (8 char)
 *   decision  — 'PASS' | 'VETO' | 'SCREEN_FAIL'
 *   gate      — VETO gate yang memblokir (atau null)
 *   reason    — reasoning string dari gate
 *   pool      — pool address (8 char)
 *   feeRatio  — fee/TVL ratio pool
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DECISION_LOG = join(__dirname, '../../decision.log');

const MAX_LINES = 500; // maksimum baris yang dibaca saat readDecisionLog

// ── appendDecisionLog ─────────────────────────────────────────────

export function appendDecisionLog({
  token    = 'UNKNOWN',
  mint     = '',
  decision = 'PASS',    // 'PASS' | 'VETO' | 'SCREEN_FAIL'
  gate     = null,      // e.g. 'SUPERTREND_15M', 'ATH_DANGER'
  reason   = '',
  pool     = '',
  feeRatio = 0,
} = {}) {
  try {
    const entry = {
      ts:       new Date().toISOString(),
      token,
      mint:     mint.slice(0, 8),
      decision,
      gate,
      reason:   String(reason).slice(0, 200),
      pool:     pool.slice(0, 8),
      feeRatio: Number(feeRatio).toFixed(4),
    };
    appendFileSync(DECISION_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[decisionLog] write error: ${e.message}`);
  }
}

// ── readDecisionLog ───────────────────────────────────────────────

export function readDecisionLog(maxEntries = MAX_LINES) {
  if (!existsSync(DECISION_LOG)) return [];
  try {
    const raw = readFileSync(DECISION_LOG, 'utf-8').trim();
    if (!raw) return [];

    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-maxEntries)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── getDecisionStats ──────────────────────────────────────────────
// Hitung ringkasan dari N entry terakhir untuk /briefing

export function getDecisionStats(hoursBack = 24) {
  const entries = readDecisionLog(1000);
  const cutoff  = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent  = entries.filter(e => new Date(e.ts).getTime() >= cutoff);

  const total      = recent.length;
  const passes     = recent.filter(e => e.decision === 'PASS').length;
  const vetos      = recent.filter(e => e.decision === 'VETO').length;
  const screenFail = recent.filter(e => e.decision === 'SCREEN_FAIL').length;

  // Top VETO gates
  const gateCount = {};
  for (const e of recent.filter(e => e.decision === 'VETO')) {
    gateCount[e.gate] = (gateCount[e.gate] || 0) + 1;
  }
  const topGates = Object.entries(gateCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g, c]) => `${g}(${c}x)`);

  return { total, passes, vetos, screenFail, topGates, hoursBack };
}
