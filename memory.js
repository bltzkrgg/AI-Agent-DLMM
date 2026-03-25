import { safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
/**
 * Memory & Evolution Layer
 * 
 * Menyimpan pengalaman agent dan menghasilkan "instincts" —
 * pattern yang terbukti profitable, di-inject ke agent berikutnya.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = join(__dirname, '../../memory.json');

const DEFAULT_MEMORY = {
  instincts: [],        // Pattern yang terbukti profitable
  closedTrades: [],     // History semua posisi yang ditutup + context market waktu itu
  marketEvents: [],     // Snapshot market + keputusan agent
  lastEvolution: null,  // Timestamp evolusi terakhir
  evolutionCount: 0,
};

// ─── Load / Save ─────────────────────────────────────────────────

export function loadMemory() {
  if (!existsSync(MEMORY_PATH)) return { ...DEFAULT_MEMORY };
  try {
    return { ...DEFAULT_MEMORY, ...JSON.parse(readFileSync(MEMORY_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export function saveMemory(memory) {
  writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

// ─── Record closed trade dengan market context ───────────────────

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
  closeReason,       // 'stop_loss' | 'take_profit' | 'out_of_range' | 'manual' | 'market_signal'
  marketAnalysis,    // analysis dari analyst.js saat close
  marketAtEntry,     // snapshot market saat posisi dibuka
  marketAtExit,      // snapshot market saat posisi ditutup
}) {
  const memory = loadMemory();

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
    closeReason,
    profitable: pnlUsd > 0,
    marketAtEntry: marketAtEntry ? summarizeSnapshot(marketAtEntry) : null,
    marketAtExit: marketAtExit ? summarizeSnapshot(marketAtExit) : null,
    analystSignalAtClose: marketAnalysis?.signal,
    analystConfidenceAtClose: marketAnalysis?.confidence,
    analystWasRight: marketAnalysis
      ? (marketAnalysis.holdRecommendation && pnlUsd > 0) ||
        (!marketAnalysis.holdRecommendation && pnlUsd < 0) // analyst benar kalau prediksinya sesuai hasil
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
    trend: snapshot.ohlcv?.trend,
    priceChange: snapshot.ohlcv?.priceChange,
    volumeVsAvg: snapshot.ohlcv?.volumeVsAvg,
    sentiment: snapshot.sentiment?.sentiment,
    buyPressure: snapshot.sentiment?.buyPressurePct,
    whaleRisk: snapshot.onChain?.whaleRisk,
  };
}

// ─── Get Instincts Context ───────────────────────────────────────

export function getInstinctsContext() {
  const memory = loadMemory();
  if (!memory.instincts || memory.instincts.length === 0) return '';

  const top = memory.instincts
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 8);

  return `\n\n🧠 INSTINCTS (dari pengalaman ${memory.closedTrades.length} posisi):\n` +
    top.map((inst, i) => `${i + 1}. [${(inst.confidence * 100).toFixed(0)}%] ${inst.pattern}`).join('\n');
}

// ─── Evolve: Generate Instincts dari Closed Trades ───────────────

export async function evolveFromTrades() {
  const memory = loadMemory();
  const trades = memory.closedTrades;

  if (trades.length < 3) {
    throw new Error(`Butuh minimal 3 posisi closed untuk evolve. Sekarang: ${trades.length}`);
  }

  const cfg = getConfig();

  // Statistik dasar
  const profitable = trades.filter(t => t.profitable);
  const losers = trades.filter(t => !t.profitable);
  const winRate = (profitable.length / trades.length * 100).toFixed(1);
  const avgPnl = (trades.reduce((s, t) => s + (t.pnlUsd || 0), 0) / trades.length).toFixed(2);

  // Analyst accuracy
  const withAnalysis = trades.filter(t => t.analystWasRight !== null);
  const analystAccuracy = withAnalysis.length > 0
    ? (withAnalysis.filter(t => t.analystWasRight).length / withAnalysis.length * 100).toFixed(1)
    : 'N/A';

  const prompt = `Kamu adalah sistem evolusi untuk AI trading agent Meteora DLMM.

Analisa history trading berikut dan ekstrak "instincts" — pattern konkret yang bisa dipakai agent di masa depan.

STATISTIK:
- Total trades: ${trades.length}
- Win rate: ${winRate}%
- Avg PnL: $${avgPnl}
- Analyst accuracy: ${analystAccuracy}%

PROFITABLE TRADES (${profitable.length}):
${JSON.stringify(profitable.slice(-10).map(t => ({
  reason: t.closeReason,
  pnl: t.pnlPct,
  duration: t.holdDurationMinutes,
  marketAtEntry: t.marketAtEntry,
  analystSignal: t.analystSignalAtClose,
})), null, 2)}

LOSING TRADES (${losers.length}):
${JSON.stringify(losers.slice(-10).map(t => ({
  reason: t.closeReason,
  pnl: t.pnlPct,
  duration: t.holdDurationMinutes,
  marketAtEntry: t.marketAtEntry,
  analystSignal: t.analystSignalAtClose,
})), null, 2)}

Tugasmu:
1. Identifikasi pattern yang konsisten menghasilkan profit
2. Identifikasi pattern yang konsisten menghasilkan kerugian (untuk dihindari)
3. Evaluasi apakah Market Analyst perlu adjustment
4. Generate 5-10 instincts yang actionable

Respond HANYA dengan JSON:
{
  "instincts": [
    {
      "pattern": "deskripsi pattern konkret dalam Bahasa Indonesia",
      "type": "enter" | "exit" | "avoid" | "hold",
      "confidence": 0.0-1.0,
      "basedOn": "berapa trade yang support ini",
      "example": "contoh konkret dari data di atas"
    }
  ],
  "analystAdjustments": "saran untuk improve Market Analyst (atau null)",
  "summary": "ringkasan temuan dalam 2-3 kalimat"
}`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  
  const result = safeParseAI(text);

  // Merge instincts baru dengan yang lama
  const newInstincts = result.instincts.map(inst => ({
    ...inst,
    generatedAt: new Date().toISOString(),
    evolutionRound: (memory.evolutionCount || 0) + 1,
  }));

  // Keep top 20 instincts by confidence
  const allInstincts = [...(memory.instincts || []), ...newInstincts]
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 20);

  memory.instincts = allInstincts;
  memory.lastEvolution = new Date().toISOString();
  memory.evolutionCount = (memory.evolutionCount || 0) + 1;
  saveMemory(memory);

  return {
    newInstincts: result.instincts,
    analystAdjustments: result.analystAdjustments,
    summary: result.summary,
    stats: { winRate, avgPnl, analystAccuracy, totalTrades: trades.length },
  };
}

// ─── Memory Stats ─────────────────────────────────────────────────

export function getMemoryStats() {
  const memory = loadMemory();
  const trades = memory.closedTrades || [];
  const profitable = trades.filter(t => t.profitable);

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0
      ? (profitable.length / trades.length * 100).toFixed(1) + '%'
      : 'N/A',
    instinctCount: (memory.instincts || []).length,
    lastEvolution: memory.lastEvolution,
    evolutionCount: memory.evolutionCount || 0,
  };
}
