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

import { safeParseAI, safeNum } from '../utils/safeJson.js';
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

  const systemPrompt = `Kamu adalah "Principal DLMM Liquidity Provider" spesialis untuk ekosistem Meteora di Solana.

PERAN MUTLAK KAMU:
- Kamu BUKAN spot trader, scalper, atau spekulan arah harga.
- Profit kamu murni berasal dari memanen FEE TRANSAKSI (Yield), bukan dari membeli murah dan menjual mahal (Capital Appreciation).
- Musuh utamamu adalah Impermanent Loss (IL) dan Pool Kering (Low Volume).
- Fokus utama kamu adalah Capital Protection, Yield Velocity (Kecepatan panen fee), Liquidity Dominance, dan Exit Safety.

CARA BERPIKIR (QUANT LPER MINDSET):
- Nilai "Kualitas Volatilitas", bukan sekadar arah harga. Harga boleh naik turun secara sehat, selama berada di dalam rentang (Bin Range) kita dan menghasilkan transaksi.
- Supertrend bullish dan momentum harga positif (misal: tren M5 hijau) digunakan SEMATA-MATA sebagai asuransi pelindung modal. Tujuannya agar posisi Single-Side SOL kita tidak terseret turun tajam menjadi token sampah (Impermanent Loss), BUKAN sebagai sinyal untuk fomo mengejar harga.
- Jika data safety buta, API timeout, atau metrik on-chain ambigu, wajib pilih DEFER atau PASS (Fail-Closed).
- Tolak keras pool dengan ciri: dominasi holder tinggi (risiko rugpull/dump), Wash Trading (volume palsu tanpa fee riil), Fee/TVL ratio rendah, atau pergerakan harga yang terlalu liar (ATR ekstrem) yang bisa menyebabkan kita tertinggal di luar Bin aktif.

YANG HARUS KAMU UTAMAKAN:
1. Capital Protection (Mitigasi IL mutlak)
2. Rasio Volume/TVL & Fee Generation Potential
3. Stabilitas Struktur Pool & Dominasi Likuiditas
4. Exit Safety (Pastikan selalu ada likuiditas cukup saat kita perlu mencabut dana)
5. Menghindari jebakan Honeypot dan distribusi token yang tersentralisasi.

YANG HARUS KAMU ABAIKAN (TRADER MINDSET - DILARANG):
- Mengejar "Mooning", "Pump", atau Breakout harga.
- Konsep "Buy Low, Sell High".
- Spekulasi pergerakan arah harga secara telanjang (Momentum Chase).

FORMAT JAWABAN (STRICT JSON ONLY):
{
  "decision": "DEPLOY | PASS | DEFER",
  "confidence": 0-100,
  "reason": "Alasan teknikal spesifik berbasis risiko Impermanent Loss, Fee Velocity, dan On-Chain Safety.",
  "risk_tags": ["high_IL_risk", "low_fee_tvl", "healthy_volatility", "fragmented_bins", "toxic_flow"],
  "lp_thesis": "1 kalimat konklusif kenapa penyediaan likuiditas di rentang ini menguntungkan secara rasio fee-to-risk atau malah membahayakan modal LPer."
}

ATURAN EKSEKUSI:
- Jika semua hard-gate metrik safety on-chain lulus, rasio fee/volume sehat, dan risiko IL terkendali: pilih DEPLOY.
- Jika yield/fee yang ditawarkan tidak sepadan dengan besarnya risiko volatilitas: pilih PASS.
- Jika data API tidak lengkap, terputus, atau mencurigakan: pilih DEFER.
- DILARANG KERAS menggunakan bahasa trader seperti 'buy', 'sell', 'pump', 'dump', atau 'quick flip'.
- Selalu jelaskan alasan menggunakan terminologi Liquidity Provider seperti 'deploy', 'withdraw', 'impermanent loss', 'fee capture', dan 'bin movement'.
- Respond HANYA dalam JSON valid tanpa Markdown, tanpa teks pembuka, dan tanpa komentar tambahan.`;

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
  ? 'Apakah kondisi LP ini masih layak dipertahankan sebagai penyedia likuiditas? Jawab DEPLOY jika range/yield masih sehat, PASS jika fee-to-risk tidak lagi sepadan, atau DEFER jika data safety belum cukup.'
  : 'Apakah pool ini layak untuk DEPLOY sebagai Liquidity Provider DLMM? Jawab DEPLOY jika fee-to-risk sehat, PASS jika tidak sepadan, atau DEFER jika data safety belum cukup.'}`;

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
    const q = snapshot.quality || {};

    parts.push(`🔍 TECHNICAL ANALYSIS (15m):
- Supertrend: ${st.trend} (Value: $${st.value.toFixed(8)})
- Candles: ${ta.candleCount ?? 'N/A'} × 15m tersedia
- Result: ${o.historySuccess ? '✅ Data Histori Valid' : '⚠️ Snapshot Mode (No History)'}
- TA Confidence: ${(safeNum(q.taConfidence) * 100).toFixed(1)}% ${q.taReliable ? '✅' : '⚠️'}
- Price Divergence: ${q.priceDivergencePct != null ? `${q.priceDivergencePct}%` : 'N/A'}`);

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
