/**
 * DLMM Position Analyst — multi-lens, LP-focused
 *
 * Mengintegrasikan semua signal (OHLCV, on-chain, smart money, pool metrics)
 * tapi semua diinterpretasi dalam konteks DLMM LP, bukan futures trading.
 *
 * Pertanyaan yang dijawab:
 *   1. Apakah pool ini masih menghasilkan fee yang cukup?
 *   2. Apakah range SOL kamu masih aktif atau sudah keluar range?
 *   3. Apakah ada risiko SOL kamu ter-absorb terlalu cepat (whale/SM buying)?
 *   4. Apakah strategi saat ini masih cocok dengan kondisi?
 *   5. Kalau harus pilih: HOLD, CLOSE, atau REBALANCE?
 */

'use strict';

import { safeParseAI } from '../utils/safeJson.js';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';

import { getConfig } from '../config.js';
import { getMarketSnapshot } from './oracle.js';
import { loadMemory, saveMemory } from './memory.js';
import { getLessonsContext } from '../learn/lessons.js';

export async function analyzeMarket(tokenMint, poolAddress, currentPosition = null) {
  const cfg = getConfig();
  const snapshot = await getMarketSnapshot(tokenMint, poolAddress);

  const memory = loadMemory();
  const relevantMemory = memory.instincts
    .filter(m => m.tokenMint === tokenMint || m.pattern)
    .slice(-3)
    .map(m => `- ${m.pattern}`)
    .join('\n');

  const ctx = buildDLMMContext(snapshot, currentPosition);
  const lessons = getLessonsContext();

  const systemPrompt = `Kamu adalah DLMM LP specialist untuk Meteora di Solana.

PERAN KAMU: LP (Liquidity Provider), bukan trader.
Profit kamu berasal dari FEE — kamu tidak perlu prediksi harga naik/turun.
Kamu hanya perlu tahu: apakah range SOL kamu aktif dan apakah fee-nya cukup?

═══════════════════════════════════════════════════════════
CARA BACA SETIAP SIGNAL DALAM KONTEKS DLMM LP:
═══════════════════════════════════════════════════════════

📊 OHLCV / PRICE ACTION:
  Bukan untuk prediksi arah, tapi untuk:
  • Volatilitas tinggi → perlu range lebih lebar (bin step lebih besar) atau Bid-Ask Wide
  • Trend UPTREND → single-side SOL akan cepat ter-convert ke token (range habis duluan)
  • Trend SIDEWAYS → single-side SOL ideal, range aktif lama, fee terkumpul stabil
  • Support/Resistance → batas range atas/bawah yang natural
  • Volume tinggi vs rata-rata → lebih banyak trader → lebih banyak fee terkumpul

🐋 ON-CHAIN (Whale/Holder):
  Bukan untuk "whale accumulate = harga naik", tapi:
  • Whale selling → orang jual token dapat SOL dari range kamu → SOL range aktif lama → fee stabil
  • Whale buying → orang beli token pakai SOL → SOL range kamu habis cepat → keluar range duluan
  • Top 10 holder tinggi → dump risk → kalau dump, semua orang jual ke range SOL kamu sekaligus

🧠 SMART MONEY (OKX):
  Bukan untuk follow SM trading, tapi untuk:
  • SM buying token → demand tinggi → single-side SOL akan habis cepat, range singkat
  • SM selling token → supply tinggi → range SOL tetap aktif lama, fee terkumpul banyak
  • SM neutral → single-side SOL atau spot balanced sama-sama viable

📦 POOL DLMM METRICS (PALING PENTING):
  • Fee APR > 100% = sangat bagus, HOLD selama in range
  • Fee APR 30-100% = acceptable tergantung kondisi lain
  • Fee APR < 30% = pertimbangkan CLOSE, pool kurang aktif
  • Fee INCREASING → pool semakin aktif → HOLD
  • Fee DECREASING → trader pindah → pertimbangkan CLOSE
  • Fee/TVL ratio harian > 2% = pool sangat aktif = target utama

═══════════════════════════════════════════════════════════
STRATEGI PRIORITAS (default: Single-Side SOL):
═══════════════════════════════════════════════════════════
1. Single-Side SOL  → DEFAULT. Posisikan sebagai JARING untuk menyerap fee saat harga drop.
2. Spot Balanced    → Gunakan jika market benar-benar sideways.
3. Bid-Ask Wide     → Gunakan jika volatilitas tinggi.
4. LP IDENTITY      → CORE: Jangan kabur saat pullback di market bullish. Dip = Pendapatan.
5. REVERSAL DANGER  → CLOSE jika trend 24 jam berubah dari Bullish ke Bearish secara total.

}
  }
}

═══════════════════════════════════════════════════════════
ADAPTIVE OOR (OUT OF RANGE) RESPONSE:
═══════════════════════════════════════════════════════════
Jika currentPosition.inRange === false:
1. BULLISH OOR (Price > Upper Range):
   - Jika Confidence > 0.7 & Volume Spike: Usulkan EXTEND/REBALANCE. Jangan buru-buru close.
   - Jika Confidence < 0.5: Ikuti timer OOR standar (CLOSE).
2. BEARISH OOR (Price < Lower Range):
   - Jika Confidence > 0.8: Trigger PANIC EXIT (Action: CLOSE, Urgency: immediate).
   - Jika Confidence < 0.6: HOLD sebentar (monitor retrace) s/d timer habis.

Respond HANYA dalam JSON.
PENTING: JANGAN gunakan formatting Markdown (seperti **bintang** atau _underscore_) pada field teks. Gunakan teks bersih.

{
  "signal": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": 0.0-1.0,
  "holdRecommendation": true | false,
  "action": "HOLD" | "CLOSE" | "REBALANCE",
  "recommendedStrategy": "Single-Side SOL" | "Spot Balanced" | "Bid-Ask Wide" | "Single-Side Token X" | "Curve Concentrated",
  "strategyReason": "kenapa strategi itu cocok dalam konteks LP saat ini",
  "thesis": "1 kalimat ringkasan kondisi LP",
  "dlmmReason": "alasan spesifik DLMM: fee APR, range status, IL risk — 2-3 kalimat",
  "keyRisks": ["risk LP 1", "risk LP 2"],
  "urgency": "immediate" | "next_cycle" | "monitor",
  "oorDecision": "EXTEND" | "PANIC_EXIT" | "NORMAL_TIMER" | null
}`;

  const userPrompt = `Analisa kondisi LP untuk posisi ini:

${ctx}
${lessons ? `\n${lessons}` : ''}
${relevantMemory ? `\nPengalaman sebelumnya dengan token/kondisi serupa:\n${relevantMemory}` : ''}

${currentPosition
  ? `Status posisi aktif:
- In range: ${currentPosition.inRange ?? 'unknown'}
- PnL: ${currentPosition.pnlPct != null ? (currentPosition.pnlPct >= 0 ? '+' : '') + currentPosition.pnlPct.toFixed(2) + '%' : 'N/A'}
- Out-of-range selama: ${currentPosition.outOfRangeMins ?? 0} menit`
  : `Evaluasi untuk posisi baru @ Mcap $${snapshot.pool?.mcap || 'Unknown'} — apakah worth deploy? (INGAT: minMcap $250k adalah syarat mutlak)`}

Pertanyaan: ${currentPosition
  ? 'Apakah posisi ini HOLD, CLOSE, atau REBALANCE? Lihat dari sudut pandang LP, bukan trader.'
  : 'Apakah pool ini layak? Strategi apa yang paling cocok? Utamakan Single-Side SOL jika tidak ada sinyal kuat lain.'}`;

  try {
    const response = await createMessage({
      model: resolveModel(cfg.generalModel),
      maxTokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const analysis = safeParseAI(extractText(response));
    saveMarketEvent({ tokenMint, poolAddress, snapshot, analysis, positionContext: currentPosition });
    return { ...analysis, snapshot };
  } catch (e) {
    return {
      signal: 'NEUTRAL', confidence: 0.3,
      holdRecommendation: true, action: 'HOLD',
      recommendedStrategy: 'Single-Side SOL',
      strategyReason: 'Default ke Single-Side SOL karena data tidak tersedia',
      thesis: 'Analisa tidak tersedia', dlmmReason: `Error: ${e.message}`,
      keyRisks: [], urgency: 'monitor', snapshot,
    };
  }
}

// ─── Context builder — semua signal, dibingkai DLMM ──────────────

function buildDLMMContext(snapshot, position) {
  const parts = [];

  if (snapshot.pool) {
    const p = snapshot.pool;
    parts.push(`📦 POOL DLMM (Meteora):
- Fee APR: ${p.feeApr}% (${p.feeAprCategory})
- Fee/TVL: ${(p.feeTvlRatio * 100).toFixed(3)}%/hari | TVL: $${p.tvl >= 1e6 ? (p.tvl/1e6).toFixed(2)+'M' : (p.tvl/1000).toFixed(1)+'K'}
- Volume 24h: $${p.volume24h >= 1e6 ? (p.volume24h/1e6).toFixed(2)+'M' : (p.volume24h/1000).toFixed(1)+'K'} | Fees 24h: $${p.fees24h?.toFixed(2)}
- Bin step: ${p.binStep}${snapshot.smartMoney?.skewPct ? `\n- Whale Skew: ${snapshot.smartMoney.skewPct}% (${snapshot.smartMoney.skewPct > 25 ? '⚠️ HIGH' : 'SAFE'})` : ''}`);
  } else {
    parts.push('⚠️ Data pool DLMM tidak tersedia');
  }

  if (snapshot.ohlcv) {
    const o = snapshot.ohlcv;
    parts.push(`📊 PRICE & MOMENTUM (DexScreener):
- Harga: $${o.currentPrice} | Trend: ${o.trend}
- Volatilitas 24h: ${o.range24hPct}% (${o.volatilityCategory})
- Support: $${o.low24h} | Resistance: $${o.high24h}`);
  }

  if (snapshot.onChain?.available) {
    const oc = snapshot.onChain;
    parts.push(`🐋 ON-CHAIN (Helius):
- Holders: ${oc.holders != null ? oc.holders.toLocaleString() : 'N/A'} | Whale risk: ${oc.whaleRisk}
- Token aktif: ${oc.tokenActive ? 'Ya' : 'Sepi'}`);
  }

  if (snapshot.sentiment) {
    const s = snapshot.sentiment;
    parts.push(`💹 MARKET PRESSURE (DexScreener):
- Buy pressure: ${s.buyPressurePct}% (${s.sentiment})
- Change: 1h ${s.priceChange1h >= 0 ? '+' : ''}${s.priceChange1h}% | 24h ${s.priceChange24h >= 0 ? '+' : ''}${s.priceChange24h}%`);
  }

  if (snapshot.pool && snapshot.ohlcv) {
    const ta = snapshot.ta || {};
    const o = snapshot.ohlcv;
    const st = ta.supertrend || { trend: 'NEUTRAL', value: 0 };

    parts.push(`🔍 TECHNICAL ANALYSIS (15m):
- Supertrend: ${st.trend} (Value: $${st.value.toFixed(8)})
- Candles: ${ta.candleCount ?? 'N/A'} × 15m tersedia
- Result: ${o.historySuccess ? '✅ Data Histori Valid' : '⚠️ Snapshot Mode (No History)'}`);

    if (ta.evilPanda?.exit?.triggered) {
      parts.push(`⚠️ EVIL PANDA EXIT SIGNAL: ${ta.evilPanda.exit.reason}`);
    }
    if (ta.evilPanda?.entry?.justCrossedAbove) {
      parts.push(`🐼 EVIL PANDA ENTRY SIGNAL: ${ta.evilPanda.entry.reason}`);
    }
  }

  if (position && !position.inRange) {
    parts.push(`⚠️ OOR CONTEXT:
- Out-of-range selama: ${position.outOfRangeMins ?? 0} menit
- Bin Distance: ${position.outOfRangeBins ?? 'Unknown'} bins
- Current PnL: ${position.pnlPct?.toFixed(2)}%`);
  }

  return parts.join('\n\n') || 'Data tidak tersedia.';
}

function saveMarketEvent(event) {
  try {
    const memory = loadMemory();
    memory.marketEvents = memory.marketEvents || [];
    memory.marketEvents.push({ ...event, timestamp: new Date().toISOString() });
    if (memory.marketEvents.length > 200) memory.marketEvents = memory.marketEvents.slice(-200);
    saveMemory(memory);
  } catch { /* non-critical */ }
}
