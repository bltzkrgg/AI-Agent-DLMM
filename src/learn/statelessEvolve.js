/**
 * src/learn/statelessEvolve.js — Log-Based Learning (Stateless)
 *
 * Membaca harvest.log (CSV, tanpa database), mengirim ringkasan
 * trade ke AGENT_MODEL (DeepSeek), dan mendapatkan rekomendasi
 * perubahan user-config.json dari LLM.
 *
 * Alur:
 *   1. Baca & parse harvest.log → array trade entries
 *   2. Hitung statistik: win rate, avg PnL, failure pattern
 *   3. Kirim ke LLM dengan prompt terstruktur
 *   4. Parse respons JSON → daftar { key, value, reason }
 *   5. Validasi via updateConfig() (bounds check bawaan)
 *   6. Return hasil untuk ditampilkan / dikonfirmasi di Telegram
 *
 * Tidak ada SQLite. Tidak ada state lokal selain harvest.log.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';
import { fileURLToPath }            from 'url';
import { getConfig, updateConfig, isConfigKeySupported } from '../config.js';
import { createMessage }            from '../agent/provider.js';
import { resolveModel }             from '../agent/provider.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const HARVEST_LOG = join(__dirname, '../../harvest.log');

// ── Kolom harvest.log ─────────────────────────────────────────────
// timestamp, token, pubkey8, pnlPct, deploySol, reason
const COL = { TS: 0, TOKEN: 1, PUBKEY: 2, PNL: 3, SOL: 4, REASON: 5 };

// Reason categories
const WIN_REASONS  = ['TAKE_PROFIT_A', 'TAKE_PROFIT_B', 'TRAILING_STOP', 'MANUAL_PROFIT'];
const LOSS_REASONS = ['STOP_LOSS', 'TRAILING_STOP_LOSS', 'OUT_OF_RANGE', 'PARTIAL_DEPLOY_ROLLBACK'];

// ── parseHarvestLog ───────────────────────────────────────────────

export function parseHarvestLog(maxEntries = 50) {
  if (!existsSync(HARVEST_LOG)) return [];

  const raw = readFileSync(HARVEST_LOG, 'utf-8').trim();
  if (!raw) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .slice(-maxEntries)          // ambil N entry terbaru
    .map(line => {
      const cols = line.split(',');
      const pnl  = parseFloat(cols[COL.PNL]) || 0;
      const sol  = parseFloat(cols[COL.SOL]) || 0;
      return {
        ts:     cols[COL.TS]     || '',
        token:  cols[COL.TOKEN]  || 'UNKNOWN',
        pubkey: cols[COL.PUBKEY] || '',
        pnl,
        sol,
        reason: cols[COL.REASON]?.trim() || 'UNKNOWN',
        isWin:  pnl > 0 || WIN_REASONS.includes(cols[COL.REASON]?.trim()),
      };
    });
}

// ── computeStats ──────────────────────────────────────────────────

function computeStats(trades) {
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const avgPnl = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;

  // Pattern analysis
  const reasonCount = {};
  for (const t of losses) {
    reasonCount[t.reason] = (reasonCount[t.reason] || 0) + 1;
  }
  const topFailure = Object.entries(reasonCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, c]) => `${r}(${c}x)`);

  // Fast loss detection: posisi kalah dengan PnL < -8 dalam waktu singkat
  const fastLosses = losses.filter(t => t.pnl < -8);

  return {
    total:        trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      ((wins.length / trades.length) * 100).toFixed(1),
    avgPnl:       avgPnl.toFixed(2),
    totalSolIn:   trades.reduce((s, t) => s + t.sol, 0).toFixed(4),
    topFailures:  topFailure,
    fastLosses:   fastLosses.length,
    recentTrades: trades.slice(-10).map(t =>
      `${t.token}: ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}% [${t.reason}]`
    ),
  };
}

// ── buildEvolutionPrompt ──────────────────────────────────────────

function buildEvolutionPrompt(stats, currentConfig) {
  const cfgSummary = {
    minOrganic:          currentConfig.minOrganic,
    gmgnMinAgeHours:     currentConfig.gmgnMinAgeHours,
    stopLossPct:         currentConfig.stopLossPct,
    trailingStopPct:     currentConfig.trailingStopPct,
    minFeeActiveTvlRatio: currentConfig.minFeeActiveTvlRatio,
    maxPoolAgeDays:      currentConfig.maxPoolAgeDays,
    slippageBps:         currentConfig.slippageBps,
    minVolume24h:        currentConfig.minVolume24h,
    minMcap:             currentConfig.minMcap,
  };

  return `You are an expert DeFi LP trading analyst for a Meteora DLMM bot.

Analyze the bot's recent trade performance and suggest SPECIFIC config changes.

## Current Config
${JSON.stringify(cfgSummary, null, 2)}

## Trade Statistics (last ${stats.total} trades)
- Win Rate: ${stats.winRate}%
- Average PnL: ${stats.avgPnl}%
- Wins: ${stats.wins} | Losses: ${stats.losses}
- Fast losses (PnL < -8%): ${stats.fastLosses}
- Top failure reasons: ${stats.topFailures.join(', ') || 'none'}

## Recent Trades
${stats.recentTrades.join('\n')}

## Rules
1. Only suggest changes to these config keys:
   minOrganic (0-100), gmgnMinAgeHours (0-720), stopLossPct (1-50),
   trailingStopPct (0.5-50), minFeeActiveTvlRatio (0-1),
   maxPoolAgeDays (0.1-30), slippageBps (10-1000),
   minVolume24h (0-1000000000), minMcap (0-100000000)

2. Be conservative — only suggest changes supported by the data.

3. If win rate > 60% and avg PnL > 5%, suggest NO changes.

## Response Format (JSON ONLY, no markdown):
{
  "lesson": "1-2 sentence summary of what the data shows",
  "changes": [
    { "key": "configKeyName", "value": <number>, "reason": "why this specific change" }
  ]
}`;
}

// ── analyzePerformance ────────────────────────────────────────────
// Fungsi utama — baca log, analisis, kirim ke LLM, return hasil.

export async function analyzePerformance({ maxEntries = 50, autoApply = false } = {}) {
  const trades = parseHarvestLog(maxEntries);

  if (trades.length === 0) {
    return {
      ok: false,
      message: 'harvest.log kosong atau tidak ditemukan. Belum ada trade yang bisa dianalisis.',
      stats: null,
      recommendations: [],
      applied: [],
    };
  }

  const stats  = computeStats(trades);
  const cfg    = getConfig();
  const prompt = buildEvolutionPrompt(stats, cfg);

  // Kirim ke AGENT_MODEL (resolveModel akan baca dari cfg.agentModel / process.env)
  let rawResponse = '';
  try {
    const response = await createMessage({
      model: cfg.agentModel,
      maxTokens: 1024,
      system: 'You are a precise DeFi config optimizer. Respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text dari response (Anthropic format)
    rawResponse = response?.content?.find(b => b.type === 'text')?.text || '';
  } catch (e) {
    return {
      ok: false,
      message: `LLM call gagal: ${e.message}`,
      stats,
      recommendations: [],
      applied: [],
    };
  }

  // Parse JSON dari response LLM
  let parsed = null;
  try {
    // Strip markdown code blocks jika ada
    const clean = rawResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    return {
      ok: false,
      message: `LLM memberikan respons tidak valid (bukan JSON).\n\nRaw: ${rawResponse.slice(0, 300)}`,
      stats,
      recommendations: [],
      applied: [],
    };
  }

  const lesson      = String(parsed?.lesson || 'No lesson provided.');
  const rawChanges  = Array.isArray(parsed?.changes) ? parsed.changes : [];

  // Validasi tiap rekomendasi
  const recommendations = rawChanges.filter(c =>
    c?.key && c?.value !== undefined && isConfigKeySupported(c.key)
  );

  const applied = [];
  const rejected = [];

  if (autoApply && recommendations.length > 0) {
    const updatePayload = {};
    for (const rec of recommendations) {
      updatePayload[rec.key] = rec.value;
    }
    try {
      const result = updateConfig(updatePayload);
      // Cek mana yang benar-benar berubah
      for (const rec of recommendations) {
        if (result[rec.key] === rec.value) {
          applied.push(rec);
        } else {
          rejected.push({ ...rec, error: 'out of bounds atau rejected oleh updateConfig' });
        }
      }
    } catch (e) {
      rejected.push(...recommendations.map(r => ({ ...r, error: e.message })));
    }
  }

  return {
    ok: true,
    stats,
    lesson,
    recommendations,
    applied,
    rejected,
    rawResponse: rawResponse.slice(0, 500),
  };
}

// ── formatEvolutionReport ─────────────────────────────────────────
// Format hasil analyzePerformance() menjadi pesan Telegram (HTML).

export function formatEvolutionReport(result) {
  if (!result.ok) {
    return `⚠️ <b>Evolve gagal</b>\n\n<code>${result.message}</code>`;
  }

  const { stats, lesson, recommendations, applied, rejected } = result;

  const statsBlock =
    `📈 <b>Trade Stats</b> (${stats.total} entries)\n` +
    `   Win Rate: <code>${stats.winRate}%</code>\n` +
    `   Avg PnL:  <code>${stats.avgPnl}%</code>\n` +
    `   Failure:  <code>${stats.topFailures.join(', ') || '-'}</code>`;

  const lessonBlock =
    `\n\n💡 <b>Pelajaran Hari Ini</b>\n${lesson}`;

  let recBlock = '\n\n🔧 <b>Rekomendasi Perubahan Config</b>\n';
  if (recommendations.length === 0) {
    recBlock += '<i>Tidak ada perubahan yang disarankan — performa sudah baik.</i>';
  } else {
    recBlock += recommendations.map(r =>
      `• <code>${r.key}</code> → <code>${r.value}</code>\n  <i>${r.reason}</i>`
    ).join('\n');
  }

  let appliedBlock = '';
  if (applied.length > 0) {
    appliedBlock = `\n\n✅ <b>Auto-applied (${applied.length})</b>\n` +
      applied.map(r => `• ${r.key} = ${r.value}`).join('\n');
  }
  if (rejected.length > 0) {
    appliedBlock += `\n\n❌ <b>Rejected (${rejected.length})</b>\n` +
      rejected.map(r => `• ${r.key}: ${r.error}`).join('\n');
  }

  return statsBlock + lessonBlock + recBlock + appliedBlock;
}
