/**
 * src/telegram/briefing.js — Daily Briefing Generator
 *
 * Mengumpulkan data dari:
 *   - decision.log (pools scanned, VETOs per gate)
 *   - position-ledger.jsonl (realized on-chain pool PnL)
 *   - evilPanda _activePositions (posisi terbuka saat ini)
 *   - tokenBlacklist (jumlah token di-ban)
 *
 * Return: pesan HTML untuk Telegram via /briefing command.
 */

import { getDecisionStats }     from '../learn/decisionLog.js';
import { readBlacklist }         from '../learn/tokenBlacklist.js';
import { getActivePositionKeys, getPositionMeta } from '../sniper/evilPanda.js';
import { getWalletBalance }       from '../solana/wallet.js';
import { getConfig }              from '../config.js';
import { escapeHTML }             from '../utils/safeJson.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSITION_LEDGER_LOG = join(__dirname, '../../position-ledger.jsonl');

function formatPnlSigned(value, digits = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function formatSolSigned(value, digits = 4) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)} SOL`;
}

export function parsePositionLedger(maxEntries = 500) {
  if (!existsSync(POSITION_LEDGER_LOG)) return [];

  const raw = readFileSync(POSITION_LEDGER_LOG, 'utf-8').trim();
  if (!raw) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .slice(-maxEntries)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function computeRealizedPoolPnlStats(rows = [], hoursBack = 24) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const realized = (Array.isArray(rows) ? rows : []).filter((row) => {
    const closedTs = new Date(row?.closedAt || row?.ts || 0).getTime();
    if (!Number.isFinite(closedTs) || closedTs < cutoff) return false;
    if (row?.manualCloseDetected) return false;
    if (row?.accountingStatus === 'manual_close_pnl_unknown') return false;
    return Number.isFinite(Number(row?.cashflow?.pnlTotalSol));
  });

  const totalPnlSol = realized.reduce((sum, row) => sum + Number(row.cashflow.pnlTotalSol || 0), 0);
  const capitalInSol = realized.reduce((sum, row) => sum + Math.max(0, Number(row.cashflow.capitalInSol || 0)), 0);
  const totalPnlPct = capitalInSol > 0 ? (totalPnlSol / capitalInSol) * 100 : 0;
  const wins = realized.filter((row) => Number(row.cashflow.pnlTotalSol || 0) > 0);
  const losses = realized.filter((row) => Number(row.cashflow.pnlTotalSol || 0) < 0);

  return {
    realized,
    total: realized.length,
    wins: wins.length,
    losses: losses.length,
    totalPnlSol,
    totalPnlPct,
    capitalInSol,
  };
}

export function formatActivePositionsTelegram(activePositions = [], { maxItems = 5 } = {}) {
  const items = Array.isArray(activePositions) ? activePositions.filter(Boolean) : [];
  const total = items.length;
  const header =
    `\n\n🏦 <b>Posisi Aktif</b>: <code>${total}</code>\n`;

  if (total === 0) {
    return header + `   <i>Tidak ada posisi aktif.</i>`;
  }

  const lines = items.slice(0, maxItems).map((pos, idx) => {
    const symbol = escapeHTML(pos.symbol || pos.token || 'UNKNOWN');
    const pubkey = escapeHTML(String(pos.pubkey || '').slice(0, 8) || '--------');
    const pool   = escapeHTML(String(pos.poolAddress || '').slice(0, 8) || '--------');
    const state  = escapeHTML(String(pos.lifecycleState || pos.state || 'OPEN').toUpperCase());
    const range  = Number.isFinite(pos.rangeMin) && Number.isFinite(pos.rangeMax)
      ? `${pos.rangeMin}-${pos.rangeMax}`
      : 'n/a';
    const hwm    = formatPnlSigned(Number(pos.hwmPct));
    const deploy = Number.isFinite(Number(pos.deploySol)) ? `${Number(pos.deploySol).toFixed(3)} SOL` : 'n/a';
    const pnl    = Number.isFinite(Number(pos.pnlPct)) ? formatPnlSigned(Number(pos.pnlPct)) : 'n/a';
    const value  = Number.isFinite(Number(pos.currentValueSol)) ? `${Number(pos.currentValueSol).toFixed(4)} SOL` : 'n/a';

    return [
      `${String(idx + 1).padStart(2, ' ')}. <b>${symbol}</b>`,
      `   Pos: <code>${pubkey}</code>`,
      `   Pool: <code>${pool}</code>`,
      `   State: <code>${state}</code>`,
      `   Range: <code>${escapeHTML(range)}</code>`,
      `   PnL: <code>${escapeHTML(pnl)}</code>`,
      `   Value: <code>${escapeHTML(value)}</code>`,
      `   HWM: <code>${escapeHTML(hwm)}</code>`,
      `   Deploy: <code>${escapeHTML(deploy)}</code>`,
    ].join('\n');
  }).join('\n\n');

  const more = total > maxItems
    ? `\n   <i>+${total - maxItems} posisi lagi</i>`
    : '';

  return `${header}<pre>${lines}</pre>${more}`;
}

// ── generateBriefing ─────────────────────────────────────────────

export async function generateBriefing(hoursBack = 24) {
  const cfg = getConfig();

  // 1. Decision log stats (screening funnel)
  const dStats  = getDecisionStats(hoursBack);

  // 2. Realized pool PnL from on-chain close ledger.
  // capitalOutSol/liquidity withdrawal is not counted as PnL; only pnlTotalSol is.
  const ledgerRows = parsePositionLedger(500);
  const pnlStats = computeRealizedPoolPnlStats(ledgerRows, hoursBack);

  // 3. Active positions
  const activeKeys  = getActivePositionKeys();
  const activeItems = activeKeys.map((pubkey) => {
    const meta = getPositionMeta(pubkey) || {};
    return {
      pubkey,
      symbol: meta.tokenXMint ? meta.tokenXMint.slice(0, 8) : pubkey.slice(0, 8),
      poolAddress: meta.poolAddress || '',
      lifecycleState: meta.lifecycleState || meta.lifecycle_state || 'OPEN',
      rangeMin: Number(meta.rangeMin),
      rangeMax: Number(meta.rangeMax),
      hwmPct: Number(meta.hwmPct),
      deploySol: Number(meta.deploySol),
      pnlPct: Number(meta.pnlPct),
      currentValueSol: Number(meta.currentValueSol),
    };
  });

  // 4. Blacklist
  const blacklist   = readBlacklist();

  // 5. Wallet balance
  let balance = '?';
  try { balance = (await getWalletBalance()).toFixed(4); } catch {}

  // ── Format ────────────────────────────────────────────────────

  const period = `${hoursBack}h`;

  const funnel =
    `📡 <b>Screening Funnel</b> (${period})\n` +
    `   Diproses : <code>${dStats.total}</code>\n` +
    `   PASS     : <code>${dStats.passes}</code>\n` +
    `   VETO     : <code>${dStats.vetos}</code>\n` +
    `   Fail     : <code>${dStats.screenFail}</code>\n` +
    (dStats.topGates.length
      ? `   Top Gate : <code>${dStats.topGates.join(', ')}</code>`
      : '');

  const pnlBlock =
    `\n\n📊 <b>PnL Harian</b> (${period})\n` +
    `   Closed   : <code>${pnlStats.total}</code> ` +
    `(<code>${pnlStats.wins}W / ${pnlStats.losses}L</code>)\n` +
    `   Total PnL: <code>${formatSolSigned(pnlStats.totalPnlSol)}</code> ` +
    `(<code>${formatPnlSigned(pnlStats.totalPnlPct)}</code>)\n` +
    `   Capital  : <code>${pnlStats.capitalInSol.toFixed(4)} SOL</code>\n` +
    `   Basis    : <code>on-chain pool PnL only</code>`;

  const posBlock =
    formatActivePositionsTelegram(activeItems, { maxItems: 5 }) +
    `\n💰 <b>Wallet</b>: <code>${balance} SOL</code>`;

  const blBlock =
    `\n\n🚫 <b>Blacklist</b>: <code>${blacklist.length}</code> token\n` +
    (blacklist.slice(0, 3).map(e =>
      `   • ${e.token} (${e.reason})`
    ).join('\n') || '   <i>-</i>');

  const cfgBlock =
    `\n\n⚙️ <b>Config Aktif</b>\n` +
    `   Deploy : <code>${cfg.deployAmountSol} SOL</code> ` +
    `| SL: <code>${cfg.stopLossPct}%</code> ` +
    `| Trail: <code>${cfg.trailingStopPct}%</code>\n` +
    `   Dry Run: <code>${cfg.dryRun ? 'ON' : 'OFF'}</code> ` +
    `| ATR Guard: <code>${cfg.atrGuardEnabled ? 'ON' : 'OFF'}</code>\n` +
    `   Realtime PnL: <code>${cfg.realtimePnlIntervalSec || 15}s</code>`;

  return (
    `📋 <b>Daily Briefing — AI-Agent-DLMM</b>\n` +
    `<i>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>\n` +
    `─────────────────────\n` +
    funnel +
    pnlBlock +
    posBlock +
    blBlock +
    cfgBlock
  );
}
