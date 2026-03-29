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

import { safeParseAI } from '../utils/safeJson.js';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { getMarketSnapshot } from './oracle.js';
import { loadMemory, saveMemory } from './memory.js';

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
1. Single-Side SOL  → DEFAULT jika tidak ada sinyal kuat lain
2. Spot Balanced    → jika sideways + volume normal + tidak ada whale risk
3. Bid-Ask Wide     → jika volatilitas tinggi + volume di atas rata-rata
4. Single-Side Token X → HANYA jika uptrend kuat + SM buying + volume sangat tinggi
5. Curve Concentrated → HANYA jika pool sangat stabil + volatilitas rendah

Respond HANYA dalam JSON:
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
  "urgency": "immediate" | "next_cycle" | "monitor"
}`;

  const userPrompt = `Analisa kondisi LP untuk posisi ini:

${ctx}
${relevantMemory ? `\nPengalaman sebelumnya dengan token/kondisi serupa:\n${relevantMemory}` : ''}

${currentPosition
  ? `Status posisi aktif:
- In range: ${currentPosition.inRange ?? 'unknown'}
- PnL: ${currentPosition.pnlPct != null ? (currentPosition.pnlPct >= 0 ? '+' : '') + currentPosition.pnlPct.toFixed(2) + '%' : 'N/A'}
- Out-of-range selama: ${currentPosition.outOfRangeMins ?? 0} menit`
  : 'Evaluasi untuk posisi baru — apakah worth deploy?'}

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
    parts.push(`📦 POOL DLMM:
- Fee APR: ${p.feeApr}% (${p.feeAprCategory}) — trend: ${p.feeVelocity}
- Fee/TVL: ${(p.feeTvlRatio * 100).toFixed(3)}%/hari | TVL: $${p.tvl >= 1e6 ? (p.tvl/1e6).toFixed(2)+'M' : (p.tvl/1000).toFixed(1)+'K'}
- Volume 24h: $${p.volume24h >= 1e6 ? (p.volume24h/1e6).toFixed(2)+'M' : (p.volume24h/1000).toFixed(1)+'K'} | Fees 24h: $${p.fees24h?.toFixed(2)}
- Bin step: ${p.binStep}`);
  } else {
    parts.push('⚠️ Data pool DLMM tidak tersedia');
  }

  if (snapshot.ohlcv) {
    const o = snapshot.ohlcv;
    parts.push(`📊 PRICE ACTION (${o.timeframe}):
- Harga: $${o.currentPrice} | Trend: ${o.trend}
- Range 24h: ${o.range24hPct}% (${o.volatilityCategory}) | Vol vs avg: ${o.volumeVsAvg}x
- Support: $${o.support} | Resistance: $${o.resistance}
- LP Note: ${o.dlmmNote}`);
  }

  if (snapshot.onChain?.available) {
    const oc = snapshot.onChain;
    parts.push(`🐋 ON-CHAIN:
- Total holders: ${oc.holders != null ? oc.holders.toLocaleString() : 'N/A'} | Top 10: ${oc.top10HolderPct}% | Whale risk: ${oc.whaleRisk}
- Recent tx: ${oc.recentTxCount} | Token aktif: ${oc.tokenActive ? 'Ya' : 'Sepi'}
- LP Note: ${oc.dlmmNote}`);
  }

  if (snapshot.sentiment) {
    const s = snapshot.sentiment;
    parts.push(`💹 TEKANAN PASAR:
- Buy pressure: ${s.buyPressurePct}% (${s.sentiment})
- Change: 1h ${s.priceChange1h >= 0 ? '+' : ''}${s.priceChange1h}% | 6h ${s.priceChange6h >= 0 ? '+' : ''}${s.priceChange6h}% | 24h ${s.priceChange24h >= 0 ? '+' : ''}${s.priceChange24h}%
- LP Note: ${s.dlmmNote}`);
  }

  if (snapshot.okx?.available) {
    const ox = snapshot.okx;
    const riskFlags = [
      ox.isHoneypot   ? 'HONEYPOT' : null,
      ox.isMintable   ? 'Mintable' : null,
      ox.riskLevel    ? `Risk: ${ox.riskLevel}` : null,
    ].filter(Boolean);
    parts.push(`🧠 SMART MONEY (OKX):
- SM Signal: ${ox.smartMoneySignal || 'N/A'} | Buying: ${ox.smartMoneyBuying ?? 'N/A'} | Selling: ${ox.smartMoneySelling ?? 'N/A'}
- Token risk: ${riskFlags.length ? riskFlags.join(', ') : 'Aman'}
- LP Note: ${ox.dlmmNote}`);
  }

  if (snapshot.pool && snapshot.ohlcv) {
    const binOk = snapshot.pool.binStep >= snapshot.ohlcv.suggestedBinStepMin;
    parts.push(`🔍 BIN STEP FIT CHECK:
- Pool bin step: ${snapshot.pool.binStep} vs volatilitas 24h ${snapshot.ohlcv.range24hPct}%
- Fit: ${binOk ? '✅ Sesuai' : `⚠️ Butuh bin step ≥${snapshot.ohlcv.suggestedBinStepMin} — IL risk meningkat`}
- Health score: ${snapshot.healthScore}/100
- Data source: ${snapshot.dataSource || 'unknown'} (${snapshot.ohlcv.candleCount || 0} candles)`);
  }

  // TA indicators — hanya tersedia kalau Birdeye candles berhasil di-fetch
  if (snapshot.ta) {
    const ta = snapshot.ta;
    const stLine = ta.supertrend
      ? `ST ${ta.supertrend.isBullish ? '🟢 BULLISH' : '🔴 BEARISH'}${ta.supertrend.justCrossedAbove ? ' ← FRESH CROSS' : ''}`
      : 'N/A';
    const bbLine = ta.bb
      ? `BB upper ${ta.bb.aboveUpper ? '✅ HIT' : '❌'} | %B=${ta.bb.percentB}`
      : 'N/A';
    const macdLine = ta.macd
      ? `Histogram ${ta.macd.histogram?.toFixed(6)} | First green ${ta.macd.firstGreenAfterRed ? '✅' : '❌'}`
      : 'N/A';

    parts.push(`📐 TA INDICATORS (real candles, 15m):
- RSI(14): ${ta.rsi14 ?? 'N/A'} | RSI(2): ${ta.rsi2 ?? 'N/A'}
- ${stLine}
- BB: ${bbLine}
- MACD: ${macdLine}
${ta.evilPanda?.exit?.triggered ? `⚠️ Evil Panda EXIT signal: ${ta.evilPanda.exit.reason}` : ''}
${ta.evilPanda?.entry?.justCrossedAbove ? `🐼 Evil Panda ENTRY signal: ${ta.evilPanda.entry.reason}` : ''}`);
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
