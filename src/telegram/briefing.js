/**
 * src/telegram/briefing.js — Daily Briefing Generator
 *
 * Mengumpulkan data dari:
 *   - decision.log (pools scanned, VETOs per gate)
 *   - harvest.log  (PnL harian, win/loss)
 *   - evilPanda _activePositions (posisi terbuka saat ini)
 *   - tokenBlacklist (jumlah token di-ban)
 *
 * Return: pesan HTML untuk Telegram via /briefing command.
 */

import { getDecisionStats }     from '../learn/decisionLog.js';
import { parseHarvestLog }       from '../learn/statelessEvolve.js';
import { readBlacklist }         from '../learn/tokenBlacklist.js';
import { getActivePositionCount } from '../sniper/evilPanda.js';
import { getWalletBalance }       from '../solana/wallet.js';
import { getConfig }              from '../config.js';

// ── generateBriefing ─────────────────────────────────────────────

export async function generateBriefing(hoursBack = 24) {
  const cfg = getConfig();

  // 1. Decision log stats (screening funnel)
  const dStats  = getDecisionStats(hoursBack);

  // 2. Harvest log stats (PnL)
  const trades  = parseHarvestLog(200);
  const cutoff  = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent  = trades.filter(t => new Date(t.ts).getTime() >= cutoff);

  const wins    = recent.filter(t => t.isWin);
  const losses  = recent.filter(t => !t.isWin);
  const totalPnl = recent.reduce((s, t) => s + t.pnl, 0);
  const totalSol = recent.reduce((s, t) => s + t.sol, 0);

  // 3. Active positions
  const activeCount = getActivePositionCount();

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

  const pnlSign  = totalPnl >= 0 ? '+' : '';
  const pnlBlock =
    `\n\n📊 <b>PnL Harian</b> (${period})\n` +
    `   Trades   : <code>${recent.length}</code> ` +
    `(<code>${wins.length}W / ${losses.length}L</code>)\n` +
    `   Total PnL: <code>${pnlSign}${totalPnl.toFixed(2)}%</code>\n` +
    `   SOL in   : <code>${totalSol.toFixed(4)} SOL</code>`;

  const posBlock =
    `\n\n🏦 <b>Posisi Aktif</b>: <code>${activeCount}</code>\n` +
    `💰 <b>Wallet</b>: <code>${balance} SOL</code>`;

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
    `| ATR Guard: <code>${cfg.atrGuardEnabled ? 'ON' : 'OFF'}</code>`;

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
