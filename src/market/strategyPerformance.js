/**
 * Strategy Performance Tracker
 *
 * Melacak performa setiap strategi berdasarkan posisi yang sudah ditutup:
 * - Fees earned per strategi
 * - Win/loss rate per strategi
 * - Auto-generate "strategy intelligence" untuk di-inject ke Hunter/Healer
 */

import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getClosedPositions } from '../db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const PERF_PATH = join(ROOT, 'strategyPerformance.json');

// File-file data yang di-auto-save ke root project
const DATA_FILES = [
  join(ROOT, 'memory.json'),
  join(ROOT, 'lessons.json'),
  join(ROOT, 'strategyPerformance.json'),
  join(ROOT, 'strategy-library.json'),
];

// ─── Simpan snapshot performa ke file lokal ───────────────────────

export function savePerformanceSnapshot() {
  try {
    const snapshot = {
      savedAt: new Date().toISOString(),
      allTime: getStrategyPerformance(),
      today: getTodayResults(),
    };
    writeFileSync(PERF_PATH, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save strategyPerformance.json:', e.message);
  }
}

// ─── Sync semua data files — pastikan semua ada & up-to-date ──────
// Dipanggil otomatis dari cron, hasilnya langsung di root AI-Agent-DLMM
// sehingga bisa langsung di-push ke GitHub.

export function backupAllData() {
  savePerformanceSnapshot(); // pastikan strategyPerformance.json fresh
  const saved = DATA_FILES.filter(f => existsSync(f)).length;
  console.log(`💾 Data files tersimpan di root project: ${saved}/${DATA_FILES.length}`);
  return saved;
}

// ─── Analisis performa per strategi ──────────────────────────────

export function getStrategyPerformance() {
  const closed = getClosedPositions();
  const perf = {};

  for (const pos of closed) {
    const strat = pos.strategy_used || 'unknown';
    if (!perf[strat]) {
      perf[strat] = {
        name: strat,
        count: 0,
        wins: 0,
        losses: 0,
        totalFeesUsd: 0,
        totalPnlUsd: 0,
        avgFeesUsd: 0,
        avgPnlUsd: 0,
        winRate: 0,
        closeReasons: {},
      };
    }

    const s = perf[strat];
    s.count++;
    s.totalFeesUsd += pos.fees_collected_usd || 0;
    s.totalPnlUsd  += pos.pnl_usd || 0;

    if ((pos.pnl_usd || 0) > 0) s.wins++;
    else s.losses++;

    const reason = pos.close_reason || 'unknown';
    s.closeReasons[reason] = (s.closeReasons[reason] || 0) + 1;
  }

  // Hitung rata-rata
  for (const s of Object.values(perf)) {
    s.avgFeesUsd = s.count > 0 ? s.totalFeesUsd / s.count : 0;
    s.avgPnlUsd  = s.count > 0 ? s.totalPnlUsd  / s.count : 0;
    s.winRate    = s.count > 0 ? (s.wins / s.count * 100) : 0;
  }

  return perf;
}

// ─── Hasil hari ini ───────────────────────────────────────────────

export function getTodayResults() {
  const closed = getClosedPositions();
  const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const todayPositions = closed.filter(p =>
    p.closed_at && p.closed_at.slice(0, 10) === today
  );

  if (todayPositions.length === 0) {
    return { date: today, count: 0, totalFeesUsd: 0, totalPnlUsd: 0, byStrategy: {}, positions: [] };
  }

  const totalFees = todayPositions.reduce((s, p) => s + (p.fees_collected_usd || 0), 0);
  const totalPnl  = todayPositions.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const winners   = todayPositions.filter(p => (p.pnl_usd || 0) > 0);

  // Grouping per strategi
  const byStrategy = {};
  for (const pos of todayPositions) {
    const strat = pos.strategy_used || 'unknown';
    if (!byStrategy[strat]) {
      byStrategy[strat] = { wins: 0, losses: 0, feesUsd: 0, pnlUsd: 0, count: 0 };
    }
    const s = byStrategy[strat];
    s.count++;
    s.feesUsd += pos.fees_collected_usd || 0;
    s.pnlUsd  += pos.pnl_usd || 0;
    if ((pos.pnl_usd || 0) > 0) s.wins++;
    else s.losses++;
  }

  return {
    date: today,
    count: todayPositions.length,
    wins: winners.length,
    losses: todayPositions.length - winners.length,
    winRate: ((winners.length / todayPositions.length) * 100).toFixed(0),
    totalFeesUsd: totalFees,
    totalPnlUsd: totalPnl,
    byStrategy,
    positions: todayPositions,
  };
}

// ─── Format laporan untuk Telegram ───────────────────────────────

export function formatDailyReport(results) {
  if (results.count === 0) {
    return `📊 *Hasil Hari Ini (${results.date})*\n\nBelum ada posisi yang ditutup hari ini.`;
  }

  const totalNet = results.totalFeesUsd + results.totalPnlUsd;
  const netEmoji = totalNet >= 0 ? '🟢' : '🔴';

  let text = `📊 *Hasil Hari Ini — ${results.date}*\n\n`;
  text += `${netEmoji} Net: ◎${totalNet.toFixed(4)} (Fees: ◎${results.totalFeesUsd.toFixed(4)} | PnL: ◎${results.totalPnlUsd.toFixed(4)})\n`;
  text += `📍 Posisi ditutup: ${results.count} | ✅ Win: ${results.wins} | ❌ Loss: ${results.losses} | Win rate: ${results.winRate}%\n\n`;

  // Per strategi
  const strategies = Object.entries(results.byStrategy).sort((a, b) => b[1].feesUsd - a[1].feesUsd);

  if (strategies.length > 0) {
    text += `*Performa per Strategi:*\n`;
    for (const [name, s] of strategies) {
      const net = s.feesUsd + s.pnlUsd;
      const emoji = net >= 0 ? '✅' : '❌';
      text += `\n${emoji} *${name}* (${s.count}x)\n`;
      text += `   Fees: ◎${s.feesUsd.toFixed(4)} | PnL: ◎${s.pnlUsd.toFixed(4)}\n`;
      text += `   Win: ${s.wins} Loss: ${s.losses}\n`;
    }
  }

  // Rekomendasi otomatis
  const rec = generateRecommendations(results.byStrategy);
  if (rec.length > 0) {
    text += `\n💡 *Auto-Insight untuk Trade Berikutnya:*\n`;
    for (const r of rec) text += `• ${r}\n`;
  }

  return text;
}

// ─── Generate rekomendasi otomatis ───────────────────────────────

function generateRecommendations(byStrategy) {
  const recs = [];
  const entries = Object.entries(byStrategy);
  if (entries.length === 0) return recs;

  // Strategi terbaik (fee + pnl tertinggi)
  const best = entries
    .map(([name, s]) => ({ name, net: s.feesUsd + s.pnlUsd, winRate: s.wins / s.count }))
    .sort((a, b) => b.net - a.net);

  const winners = best.filter(s => s.net > 0);
  const losers  = best.filter(s => s.net < 0);

  if (winners.length > 0) {
    recs.push(`Prioritaskan *${winners[0].name}* — net ◎${winners[0].net.toFixed(4)} hari ini`);
  }
  if (losers.length > 0) {
    recs.push(`Hindari *${losers[losers.length - 1].name}* dulu — net ◎${losers[losers.length - 1].net.toFixed(4)} hari ini`);
  }

  return recs;
}

// ─── Strategy Intelligence untuk di-inject ke agent ─────────────
// Dipanggil dari Hunter/Healer supaya AI tahu strategi mana yang works

export function getStrategyIntelligenceContext() {
  const perf = getStrategyPerformance();
  const entries = Object.values(perf);

  if (entries.length === 0) return '';

  // Sort: terbaik duluan
  const sorted = entries.sort((a, b) => (b.totalFeesUsd + b.totalPnlUsd) - (a.totalFeesUsd + a.totalPnlUsd));

  const winners = sorted.filter(s => s.totalPnlUsd > 0 && s.count >= 2);
  const losers  = sorted.filter(s => s.totalPnlUsd < 0 && s.count >= 2);

  let ctx = '\n\n📈 STRATEGY PERFORMANCE (dari data nyata):';

  if (winners.length > 0) {
    ctx += '\n✅ Strategi yang TERBUKTI PROFIT:';
    for (const s of winners.slice(0, 3)) {
      ctx += `\n  • ${s.name}: ${s.wins}W/${s.losses}L | Fees ◎${s.totalFeesUsd.toFixed(4)} | Avg PnL ◎${s.avgPnlUsd.toFixed(4)}`;
    }
  }

  if (losers.length > 0) {
    ctx += '\n❌ Strategi yang SERING RUGI (hindari):';
    for (const s of losers.slice(0, 3)) {
      ctx += `\n  • ${s.name}: ${s.wins}W/${s.losses}L | Total loss ◎${s.totalPnlUsd.toFixed(4)}`;
    }
  }

  // Today snapshot
  const today = getTodayResults();
  if (today.count > 0) {
    ctx += `\n\n📅 Hari ini: ${today.count} posisi closed | Net ◎${(today.totalFeesUsd + today.totalPnlUsd).toFixed(4)} | Win rate ${today.winRate}%`;
  }

  return ctx;
}
