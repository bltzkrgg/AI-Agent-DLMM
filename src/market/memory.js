import { safeParseAI } from '../utils/safeJson.js';
/**
 * Memory & Evolution Layer
 *
 * Menyimpan pengalaman agent dan menghasilkan "instincts" —
 * pattern yang terbukti profitable, di-inject ke agent berikutnya.
 *
 * Improvement dari Meridian:
 * - Range efficiency tracking (% waktu in-range)
 * - Instincts disort: AVOID/EXIT duluan supaya AI belajar menghindari kerugian
 * - Performance bucketing per hold-duration & close-reason
 * - Darwin weight auto-recalibration dari data nyata setiap /evolve
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMemoryPath() {
  return process.env.BOT_MEMORY_PATH || join(__dirname, '../../memory.json');
}

const DEFAULT_MEMORY = {
  instincts: [],
  closedTrades: [],
  marketEvents: [],
  lastEvolution: null,
  evolutionCount: 0,
  lastEvolvedAtCount: 0,
  lastAutoEvolution: null,
};

// ─── Load / Save ──────────────────────────────────────────────────

export function loadMemory() {
  const memoryPath = getMemoryPath();
  if (!existsSync(memoryPath)) return { ...DEFAULT_MEMORY };
  try {
    return { ...DEFAULT_MEMORY, ...JSON.parse(readFileSync(memoryPath, 'utf-8')) };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export function saveMemory(memory) {
  try {
    writeFileSync(getMemoryPath(), JSON.stringify(memory, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save memory.json:', e.message);
  }
}

// ─── Record closed trade dengan market context ────────────────────

export function recordClosedTrade({
  positionAddress,
  poolAddress,
  tokenX,
  tokenY,
  entryPrice,
  exitPrice,
  pnlUsd,
  pnlPct,
  holdDurationMinutes,
  minutesInRange,        // NEW: berapa menit posisi in-range
  rangeEfficiencyPct,    // NEW: minutesInRange / holdDurationMinutes * 100
  strategy,             // NEW: nama strategi yang dipakai
  volatility,           // NEW: volatilitas pool saat deploy
  closeReason,
  marketAnalysis,
  marketAtEntry,
  marketAtExit,
}) {
  const memory = loadMemory();

  // Hitung range efficiency kalau belum dihitung
  const effPct = rangeEfficiencyPct != null
    ? rangeEfficiencyPct
    : (holdDurationMinutes > 0 && minutesInRange != null)
      ? parseFloat(((minutesInRange / holdDurationMinutes) * 100).toFixed(1))
      : null;

  const trade = {
    id: Date.now(),
    positionAddress,
    poolAddress,
    tokenX,
    tokenY,
    entryPrice,
    exitPrice,
    pnlUsd,
    pnlPct,
    holdDurationMinutes,
    minutesInRange:      minutesInRange  ?? null,
    rangeEfficiencyPct:  effPct,
    strategy:            strategy        ?? null,
    volatility:          volatility      ?? null,
    closeReason,
    profitable: pnlUsd > 0,
    marketAtEntry: marketAtEntry ? summarizeSnapshot(marketAtEntry) : null,
    marketAtExit:  marketAtExit  ? summarizeSnapshot(marketAtExit)  : null,
    analystSignalAtClose:   marketAnalysis?.signal,
    analystConfidenceAtClose: marketAnalysis?.confidence,
    analystWasRight: marketAnalysis
      ? (marketAnalysis.holdRecommendation && pnlUsd > 0) ||
        (!marketAnalysis.holdRecommendation && pnlUsd < 0)
      : null,
    timestamp: new Date().toISOString(),
  };

  memory.closedTrades.push(trade);
  if (memory.closedTrades.length > 500) {
    memory.closedTrades = memory.closedTrades.slice(-500);
  }

  saveMemory(memory);
  return trade;
}

function summarizeSnapshot(snapshot) {
  return {
    trend:        snapshot.ohlcv?.trend,
    priceChange:  snapshot.ohlcv?.priceChange,
    volumeVsAvg:  snapshot.ohlcv?.volumeVsAvg,
    sentiment:    snapshot.sentiment?.sentiment,
    buyPressure:  snapshot.sentiment?.buyPressurePct,
    whaleRisk:    snapshot.onChain?.whaleRisk,
  };
}

// ─── Get Instincts Context ────────────────────────────────────────
// Dari Meridian: sort AVOID/bad duluan, supaya AI belajar menghindari
// kerugian sebelum belajar mengejar profit.

export function getInstinctsContext() {
  const memory = loadMemory();
  if (!memory.instincts || memory.instincts.length === 0) return '';

  // Priority: avoid → exit → enter/hold (bad lessons dulu biar AI waspada)
  const typePriority = { avoid: 0, exit: 1, enter: 2, hold: 3 };
  const sorted = [...memory.instincts]
    .sort((a, b) => {
      const pa = typePriority[a.type] ?? 2;
      const pb = typePriority[b.type] ?? 2;
      if (pa !== pb) return pa - pb;
      return (b.confidence || 0) - (a.confidence || 0);
    })
    .slice(0, 10);

  return `\n\n🧠 INSTINCTS (dari ${memory.closedTrades.length} posisi — hindari dulu, baru kejar profit):\n` +
    sorted.map((inst, i) => {
      const badge = inst.type === 'avoid' ? '🚫' : inst.type === 'exit' ? '🚪' : '✅';
      return `${i + 1}. ${badge} [${(inst.confidence * 100).toFixed(0)}%] ${inst.pattern}`;
    }).join('\n');
}

// ─── Evolve: Generate Instincts dari Closed Trades ────────────────

export async function evolveFromTrades() {
  const memory = loadMemory();
  const trades = memory.closedTrades;

  if (trades.length < 10) {
    throw new Error(`Butuh minimal 10 posisi closed untuk evolve. Sekarang: ${trades.length}`);
  }

  const cfg = getConfig();

  const profitable = trades.filter(t => t.profitable);
  const losers     = trades.filter(t => !t.profitable);
  const winRate    = (profitable.length / trades.length * 100).toFixed(1);
  const avgPnl     = (trades.reduce((s, t) => s + (t.pnlUsd || 0), 0) / trades.length).toFixed(2);

  const withAnalysis = trades.filter(t => t.analystWasRight !== null);
  const analystAccuracy = withAnalysis.length > 0
    ? (withAnalysis.filter(t => t.analystWasRight).length / withAnalysis.length * 100).toFixed(1)
    : 'N/A';

  // Performance bucketing — dari Meridian: analisa per durasi & close reason
  const buckets = {
    shortHold:  trades.filter(t => (t.holdDurationMinutes || 0) < 60),
    mediumHold: trades.filter(t => (t.holdDurationMinutes || 0) >= 60 && (t.holdDurationMinutes || 0) < 240),
    longHold:   trades.filter(t => (t.holdDurationMinutes || 0) >= 240),
    byCloseReason: {},
    byRangeEfficiency: {
      poor:   trades.filter(t => t.rangeEfficiencyPct != null && t.rangeEfficiencyPct < 40),
      medium: trades.filter(t => t.rangeEfficiencyPct != null && t.rangeEfficiencyPct >= 40 && t.rangeEfficiencyPct < 75),
      high:   trades.filter(t => t.rangeEfficiencyPct != null && t.rangeEfficiencyPct >= 75),
    },
  };

  for (const t of trades) {
    const r = t.closeReason || 'unknown';
    if (!buckets.byCloseReason[r]) buckets.byCloseReason[r] = [];
    buckets.byCloseReason[r].push(t);
  }

  function bucketSummary(arr) {
    if (!arr.length) return null;
    const wins = arr.filter(t => t.profitable).length;
    const avg  = (arr.reduce((s, t) => s + (t.pnlUsd || 0), 0) / arr.length).toFixed(2);
    return { count: arr.length, winRate: ((wins / arr.length) * 100).toFixed(0) + '%', avgPnl: '$' + avg };
  }

  const prompt = `Kamu adalah sistem evolusi untuk AI trading agent Meteora DLMM.

Analisa history trading berikut dan ekstrak "instincts" — pattern konkret yang bisa dipakai agent di masa depan.

STATISTIK:
- Total trades: ${trades.length}
- Win rate: ${winRate}%
- Avg PnL: $${avgPnl}
- Analyst accuracy: ${analystAccuracy}%

PERFORMANCE BUCKETING:
- Hold < 1 jam: ${JSON.stringify(bucketSummary(buckets.shortHold))}
- Hold 1-4 jam: ${JSON.stringify(bucketSummary(buckets.mediumHold))}
- Hold > 4 jam: ${JSON.stringify(bucketSummary(buckets.longHold))}
- Range efficiency rendah (<40%): ${JSON.stringify(bucketSummary(buckets.byRangeEfficiency.poor))}
- Range efficiency tinggi (>75%): ${JSON.stringify(bucketSummary(buckets.byRangeEfficiency.high))}
- Per alasan close: ${JSON.stringify(Object.fromEntries(Object.entries(buckets.byCloseReason).map(([k, v]) => [k, bucketSummary(v)])))}

PROFITABLE TRADES (${profitable.length}):
${JSON.stringify(profitable.slice(-10).map(t => ({
  reason: t.closeReason, pnl: t.pnlPct, duration: t.holdDurationMinutes,
  rangeEff: t.rangeEfficiencyPct, strategy: t.strategy, volatility: t.volatility,
  marketAtEntry: t.marketAtEntry, analystSignal: t.analystSignalAtClose,
})), null, 2)}

LOSING TRADES (${losers.length}):
${JSON.stringify(losers.slice(-10).map(t => ({
  reason: t.closeReason, pnl: t.pnlPct, duration: t.holdDurationMinutes,
  rangeEff: t.rangeEfficiencyPct, strategy: t.strategy, volatility: t.volatility,
  marketAtEntry: t.marketAtEntry, analystSignal: t.analystSignalAtClose,
})), null, 2)}

DARWIN WEIGHTS SAAT INI (pool screening ranker):
  mcap=2.5 (TVL proxy), feeActiveTvlRatio=2.3, volume=0.36, holderCount=0.3
  Formula: score += ratioScore*feeActiveTvlRatio + volScore*volume + mcapScore*mcap + 0.3*holderCount
  Dari data marketAtEntry: volumeVsAvg tersedia. Korelasikan dengan profitabilitas.
  Kalau volume tidak prediktif → turunkan weight. Kalau TVL selalu korelasi positif → pertahankan/naikkan.
  Range: 0.0 – 5.0 per weight.

Tugasmu:
1. Identifikasi pattern yang konsisten menghasilkan profit
2. Identifikasi pattern yang harus DIHINDARI (type: "avoid") — ini paling penting!
3. Rekomendasi kapan harus exit lebih cepat vs hold (type: "exit")
4. Evaluasi apakah Market Analyst perlu adjustment
5. Generate 6-10 instincts yang actionable — prioritaskan "avoid" duluan
6. Sarankan Darwin weights baru berdasarkan data — weights harus antara 0.0 dan 5.0

Respond HANYA dengan JSON:
{
  "instincts": [
    {
      "pattern": "deskripsi pattern konkret dalam Bahasa Indonesia",
      "type": "avoid" | "exit" | "enter" | "hold",
      "confidence": 0.0-1.0,
      "basedOn": "berapa trade yang support ini",
      "example": "contoh konkret dari data di atas"
    }
  ],
  "darwinWeights": {
    "mcap": 2.5,
    "feeActiveTvlRatio": 2.3,
    "volume": 0.36,
    "holderCount": 0.3
  },
  "analystAdjustments": "saran untuk improve Market Analyst (atau null)",
  "summary": "ringkasan temuan dalam 2-3 kalimat"
}`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const result = safeParseAI(extractText(response));

  const newInstincts = (result.instincts || []).map(inst => ({
    ...inst,
    generatedAt: new Date().toISOString(),
    evolutionRound: (memory.evolutionCount || 0) + 1,
  }));

  // ── Darwin weight hints (internal memory only) ───────────────
  let appliedWeights = null;
  if (result.darwinWeights && typeof result.darwinWeights === 'object') {
    const WEIGHT_KEYS = ['mcap', 'feeActiveTvlRatio', 'volume', 'holderCount'];
    const validated = {};
    for (const key of WEIGHT_KEYS) {
      const val = result.darwinWeights[key];
      if (typeof val === 'number' && val >= 0 && val <= 5) {
        validated[key] = parseFloat(val.toFixed(3));
      }
    }
    if (Object.keys(validated).length === WEIGHT_KEYS.length) {
      memory.llmWeightHints = validated;
      appliedWeights = validated;
    }
  }

  // Sort: avoid duluan, lalu by confidence
  const typePriority = { avoid: 0, exit: 1, enter: 2, hold: 3 };
  const allInstincts = [...(memory.instincts || []), ...newInstincts]
    .sort((a, b) => {
      const pa = typePriority[a.type] ?? 2;
      const pb = typePriority[b.type] ?? 2;
      if (pa !== pb) return pa - pb;
      return (b.confidence || 0) - (a.confidence || 0);
    })
    .slice(0, 20);

  memory.instincts    = allInstincts;
  memory.lastEvolution = new Date().toISOString();
  memory.evolutionCount = (memory.evolutionCount || 0) + 1;
  saveMemory(memory);

  return {
    newInstincts: result.instincts || [],
    analystAdjustments: result.analystAdjustments,
    summary: result.summary,
    appliedWeights,
    stats: { winRate, avgPnl, analystAccuracy, totalTrades: trades.length },
  };
}

// ─── Memory Stats ──────────────────────────────────────────────────

export function getMemoryStats() {
  const memory = loadMemory();
  const trades = memory.closedTrades || [];
  const profitable = trades.filter(t => t.profitable);

  const withEff = trades.filter(t => t.rangeEfficiencyPct != null);
  const avgRangeEff = withEff.length > 0
    ? (withEff.reduce((s, t) => s + t.rangeEfficiencyPct, 0) / withEff.length).toFixed(1) + '%'
    : 'N/A';

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0
      ? (profitable.length / trades.length * 100).toFixed(1) + '%'
      : 'N/A',
    avgRangeEfficiency: avgRangeEff,
    instinctCount: (memory.instincts || []).length,
    lastEvolution: memory.lastEvolution,
    evolutionCount: memory.evolutionCount || 0,
    lastAutoEvolution: memory.lastAutoEvolution || null,
  };
}

export function getStrategyRegimeGuard({ strategyName, snapshot, minTrades = 3 } = {}) {
  if (!strategyName || !snapshot) return { blocked: false, reason: null, sampleSize: 0 };

  const memory = loadMemory();
  const currentTrend = snapshot.ohlcv?.trend || null;
  const currentVolatility = snapshot.ohlcv?.volatilityCategory || null;

  const candidates = (memory.closedTrades || [])
    .filter(t => t.strategy === strategyName)
    .filter(t => {
      const sameTrend = currentTrend && t.marketAtEntry?.trend === currentTrend;
      const sameVolatility = currentVolatility && t.volatility === currentVolatility;
      return sameTrend || sameVolatility;
    })
    .slice(-10);

  if (candidates.length < minTrades) {
    return { blocked: false, reason: null, sampleSize: candidates.length };
  }

  const losses = candidates.filter(t => !t.profitable);
  const lossRate = losses.length / candidates.length;
  const avgPnlPct = candidates.reduce((sum, t) => sum + (t.pnlPct || 0), 0) / candidates.length;

  if (lossRate >= 0.67 && avgPnlPct <= -2.0) {
    return {
      blocked: true,
      reason: `Regime memory menolak setup Panda: ${losses.length}/${candidates.length} trade serupa berakhir loss (avg ${avgPnlPct.toFixed(2)}%).`,
      sampleSize: candidates.length,
      avgPnlPct: Number(avgPnlPct.toFixed(2)),
      lossRate: Number((lossRate * 100).toFixed(1)),
    };
  }

  return {
    blocked: false,
    reason: null,
    sampleSize: candidates.length,
    avgPnlPct: Number(avgPnlPct.toFixed(2)),
    lossRate: Number((lossRate * 100).toFixed(1)),
  };
}
