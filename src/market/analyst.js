import { safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
/**
 * Market Analyst Agent
 * 
 * Reasoning layer yang menganalisa semua data market
 * dan menghasilkan "market thesis" per token/posisi.
 * 
 * Output: { signal, confidence, thesis, reasoning, holdRecommendation }
 */

import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { getMarketSnapshot } from './oracle.js';
import { loadMemory, saveMemory } from './memory.js';

export async function analyzeMarket(tokenMint, poolAddress, currentPosition = null) {
  const cfg = getConfig();

  // 1. Kumpulkan data market
  const snapshot = await getMarketSnapshot(tokenMint, poolAddress);

  // 2. Load memory/instinct dari pengalaman sebelumnya
  const memory = loadMemory();
  const relevantMemory = memory.instincts
    .filter(m => m.tokenMint === tokenMint || m.pattern)
    .slice(-5);

  // 3. Build context untuk analyst
  const marketContext = buildMarketContext(snapshot, currentPosition);
  const memoryContext = relevantMemory.length > 0
    ? `\n\nPengalaman sebelumnya dengan token/kondisi serupa:\n${relevantMemory.map(m => `- ${m.lesson}`).join('\n')}`
    : '';

  const systemPrompt = `Kamu adalah Market Analyst untuk Meteora DLMM liquidity providing di Solana.

Tugasmu: analisa data market yang diberikan dan buat keputusan apakah posisi LP harus HOLD atau CLOSE.

Pertimbangkan:
1. Price action & trend — apakah harga berpotensi balik ke range posisi?
2. Volume & liquidity flow — apakah ada interest dari trader?
3. On-chain signals — apakah whale accumulate atau distribute?
4. Sentiment — apakah buy pressure dominan?
5. Pengalaman sebelumnya — pattern apa yang terbukti profitable?

Respond HANYA dalam JSON format:
{
  "signal": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": 0.0-1.0,
  "holdRecommendation": true | false,
  "priceTarget": number | null,
  "timeHorizon": "short" | "medium" | "long",
  "thesis": "ringkasan 1 kalimat",
  "reasoning": "penjelasan detail 3-5 kalimat",
  "keyRisks": ["risk 1", "risk 2"],
  "keyOpportunities": ["opp 1", "opp 2"]
}`;

  const userPrompt = `Analisa market untuk posisi LP ini:

${marketContext}
${memoryContext}

${currentPosition
  ? `Status posisi saat ini:
- In range: ${currentPosition.inRange}
- PnL: ${currentPosition.pnlPct ?? 'N/A'}%
- Sudah hold: ${currentPosition.ageMinutes ?? 'N/A'} menit`
  : 'Ini untuk evaluasi pool baru sebelum deploy.'}

Buat keputusan: apakah ${currentPosition ? 'posisi ini harus di-HOLD atau di-CLOSE?' : 'pool ini layak untuk di-deploy?'}`;

  try {
    const response = await createMessage({
      model: resolveModel(cfg.generalModel),
      maxTokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    
    const analysis = safeParseAI(response.content[0].text);

    // Simpan snapshot + analysis ke memory untuk evolusi
    saveMarketEvent({
      tokenMint,
      poolAddress,
      snapshot,
      analysis,
      positionContext: currentPosition,
      timestamp: new Date().toISOString(),
    });

    return { ...analysis, snapshot };
  } catch (e) {
    // Fallback kalau AI gagal parse
    return {
      signal: 'NEUTRAL',
      confidence: 0.3,
      holdRecommendation: true,
      thesis: 'Analisa market tidak tersedia',
      reasoning: `Error: ${e.message}`,
      keyRisks: [],
      keyOpportunities: [],
      snapshot,
    };
  }
}

function buildMarketContext(snapshot, position) {
  const parts = [];

  if (snapshot.ohlcv) {
    const o = snapshot.ohlcv;
    parts.push(`📊 PRICE ACTION (${o.timeframe}):
- Harga saat ini: $${o.currentPrice}
- Perubahan: ${o.priceChange}%
- Trend: ${o.trend}
- High 24h: $${o.high24h} | Low 24h: $${o.low24h}
- Support: $${o.support} | Resistance: $${o.resistance}
- Volume vs rata-rata: ${o.volumeVsAvg}x`);
  }

  if (snapshot.liquidity) {
    const l = snapshot.liquidity;
    parts.push(`💧 LIQUIDITY:
- TVL pool: $${(l.tvl / 1e6).toFixed(2)}M
- Volume 24h: $${(l.volume24h / 1e6).toFixed(2)}M
- Fee APR: ${l.feeApr?.toFixed(2)}%
- Liquidity change 24h: ${l.liquidityChange24h ?? 'N/A'}`);
  }

  if (snapshot.onChain?.available) {
    const oc = snapshot.onChain;
    parts.push(`🔗 ON-CHAIN:
- Holders: ${oc.holders?.toLocaleString() ?? 'N/A'}
- Market cap: $${oc.marketCap ? (oc.marketCap / 1e6).toFixed(2) + 'M' : 'N/A'}
- Top 10 holder concentration: ${oc.top10HolderPct}%
- Whale risk: ${oc.whaleRisk}
- Recent tx (20 latest): ${oc.recentTxCount}`);
  }

  if (snapshot.sentiment) {
    const s = snapshot.sentiment;
    parts.push(`💬 SENTIMENT:
- Buy pressure: ${s.buyPressurePct}% (${s.sentiment})
- Buys 24h: ${s.buys24h} | Sells 24h: ${s.sells24h}
- Price change 1h: ${s.priceChange1h}% | 6h: ${s.priceChange6h}% | 24h: ${s.priceChange24h}%`);
  }

  return parts.join('\n\n') || 'Data market tidak tersedia.';
}

function saveMarketEvent(event) {
  const memory = loadMemory();
  memory.marketEvents = memory.marketEvents || [];
  memory.marketEvents.push(event);
  // Keep last 200 events
  if (memory.marketEvents.length > 200) {
    memory.marketEvents = memory.marketEvents.slice(-200);
  }
  saveMemory(memory);
}
