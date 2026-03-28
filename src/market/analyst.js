/**
 * DLMM Position Analyst
 *
 * Menganalisa kondisi pool DLMM dan posisi LP untuk memutuskan
 * HOLD, CLOSE, atau perlu rebalance.
 *
 * BUKAN untuk analisa futures/trading. Fokus ke LP economics:
 * - Apakah fee APR masih worth it?
 * - Apakah range masih valid?
 * - Apakah ada IL risk yang melebihi fee income?
 * - Apakah pool masih sehat (volume, TVL)?
 */

import { safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { getMarketSnapshot } from './oracle.js';
import { loadMemory, saveMemory } from './memory.js';

export async function analyzeMarket(tokenMint, poolAddress, currentPosition = null) {
  const cfg = getConfig();

  const snapshot = await getMarketSnapshot(tokenMint, poolAddress);

  // Memory — hanya ambil lesson yang relevan untuk posisi aktif
  const memory = loadMemory();
  const relevantMemory = memory.instincts
    .filter(m => m.tokenMint === tokenMint || m.pattern)
    .slice(-3)
    .map(m => `- ${m.lesson}`)
    .join('\n');

  const ctx = buildDLMMContext(snapshot, currentPosition);

  const systemPrompt = `Kamu adalah spesialis DLMM (Concentrated Liquidity Market Maker) untuk Meteora di Solana.

PRINSIP DASAR DLMM LP:
- Kamu hanya earn fees saat harga aktif berada di DALAM range posisimu
- Saat harga keluar range: tidak ada fee tapi posisi masih ada (perlu close + redeploy)
- Impermanent Loss (IL) terjadi saat harga bergerak jauh dari range entry
- Fee harus > IL agar posisi profitable secara keseluruhan

FRAMEWORK KEPUTUSAN (khusus DLMM — bukan futures trading):

1. FEE APR & VELOCITY
   - APR > 100% = excellent, HOLD selama masih in range
   - APR 30-100% = acceptable, tergantung kondisi lain
   - APR < 30% = pool kurang aktif, pertimbangkan CLOSE
   - Fee makin turun (DECREASING) = trader pindah ke pool lain → CLOSE

2. STATUS RANGE
   - In range = posisi aktif menghasilkan fee → cenderung HOLD
   - Out of range = tidak ada fee, hitung berapa lama keluar
   - Lama out of range tapi fee/TVL masih tinggi = harga mungkin kembali → wait
   - Lama out of range + fee/TVL turun = CLOSE, redeploy di range baru

3. BIN STEP vs VOLATILITAS
   - Volatilitas 24h >> bin step pool → IL terlalu besar → CLOSE atau REBALANCE
   - Volatilitas 24h sesuai bin step → range masih valid → HOLD

4. TVL & POOL HEALTH
   - TVL naik = banyak LP masuk = fee diluted → fee per posisi turun
   - TVL turun drastis = LP lari = pool mati → CLOSE segera
   - Volume turun tapi TVL stabil = trader sepi → fee turun

5. UNTUK OPEN POSISI (hunter):
   - Pool eligible kalau feeApr > 50%, feeTvlRatio > 2%, volume aktif
   - Pilih strategi berdasarkan volatilitas dan arah harga:
     * Sideways + low vol → Spot Balanced
     * Sideways + low vol, pool stabil → Curve Concentrated
     * Volatile/momentum → Bid-Ask Wide
     * Uptrend kuat → Single-Side Token X
     * Downtrend + expect reversal → Single-Side USDC

Respond HANYA dalam JSON:
{
  "signal": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": 0.0-1.0,
  "holdRecommendation": true | false,
  "action": "HOLD" | "CLOSE" | "REBALANCE",
  "dlmmReason": "alasan spesifik berdasarkan fee APR, range status, IL risk — 1-2 kalimat",
  "thesis": "ringkasan 1 kalimat",
  "keyRisks": ["risk 1", "risk 2"],
  "urgency": "immediate" | "next_cycle" | "monitor"
}`;

  const userPrompt = `Analisa kondisi DLMM pool ini:

${ctx}
${relevantMemory ? `\nPengalaman sebelumnya:\n${relevantMemory}` : ''}

${currentPosition
  ? `Status posisi aktif:
- In range: ${currentPosition.inRange ?? 'unknown'}
- PnL saat ini: ${currentPosition.pnlPct != null ? currentPosition.pnlPct.toFixed(2) + '%' : 'N/A'}
- Out-of-range selama: ${currentPosition.outOfRangeMins ?? 0} menit`
  : 'Evaluasi untuk entry posisi baru.'}

Keputusan: apakah ${currentPosition ? 'posisi ini HOLD atau CLOSE?' : 'pool ini layak untuk deploy?'}
Fokus pada DLMM LP economics — bukan price prediction atau futures logic.`;

  try {
    const response = await createMessage({
      model: resolveModel(cfg.generalModel),
      maxTokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const analysis = safeParseAI(extractText(response));

    saveMarketEvent({ tokenMint, poolAddress, snapshot, analysis, positionContext: currentPosition });

    return { ...analysis, snapshot };
  } catch (e) {
    return {
      signal: 'NEUTRAL',
      confidence: 0.3,
      holdRecommendation: true,
      action: 'HOLD',
      dlmmReason: `Analisa tidak tersedia: ${e.message}`,
      thesis: 'Data analisa tidak tersedia',
      keyRisks: [],
      urgency: 'monitor',
      snapshot,
    };
  }
}

// ─── Build DLMM-specific context ────────────────────────────────

function buildDLMMContext(snapshot, position) {
  const parts = [];

  if (snapshot.pool) {
    const p = snapshot.pool;
    parts.push(`📊 POOL DLMM:
- Fee APR: ${p.feeApr}% (${p.feeAprCategory}) — ${p.feeVelocity}
- Fee/TVL ratio: ${(p.feeTvlRatio * 100).toFixed(3)}% per hari
- TVL: $${p.tvl >= 1e6 ? (p.tvl / 1e6).toFixed(2) + 'M' : (p.tvl / 1000).toFixed(1) + 'K'}
- Volume 24h: $${p.volume24h >= 1e6 ? (p.volume24h / 1e6).toFixed(2) + 'M' : (p.volume24h / 1000).toFixed(1) + 'K'}
- Fees 24h: $${p.fees24h?.toFixed(2) ?? 'N/A'}
- Bin step: ${p.binStep}`);
  } else {
    parts.push('⚠️ Data pool DLMM tidak tersedia');
  }

  if (snapshot.price) {
    const pr = snapshot.price;
    parts.push(`💹 HARGA & VOLATILITAS:
- Trend: ${pr.trend} | Volatilitas 24h: ${pr.volatility24h}% (${pr.volatilityCategory})
- Perubahan: 1h ${pr.priceChange1h >= 0 ? '+' : ''}${pr.priceChange1h}% | 6h ${pr.priceChange6h >= 0 ? '+' : ''}${pr.priceChange6h}% | 24h ${pr.priceChange24h >= 0 ? '+' : ''}${pr.priceChange24h}%
- Buy pressure: ${pr.buyPressurePct}% (${pr.sentiment})
- Bin step minimum yang cocok: ${pr.suggestedBinStepMin}`);
  }

  if (snapshot.pool && snapshot.price) {
    const binOk = snapshot.pool.binStep >= snapshot.price.suggestedBinStepMin;
    parts.push(`🔍 DLMM FIT CHECK:
- Volatilitas ${snapshot.price.volatilityCategory} vs bin step ${snapshot.pool.binStep}: ${binOk ? '✅ sesuai' : '⚠️ volatilitas terlalu tinggi untuk bin step ini — IL risk meningkat'}
- Health score pool: ${snapshot.healthScore}/100`);
  }

  return parts.join('\n\n') || 'Data tidak tersedia.';
}

function saveMarketEvent(event) {
  try {
    const memory = loadMemory();
    memory.marketEvents = memory.marketEvents || [];
    memory.marketEvents.push({ ...event, timestamp: new Date().toISOString() });
    if (memory.marketEvents.length > 200) {
      memory.marketEvents = memory.marketEvents.slice(-200);
    }
    saveMemory(memory);
  } catch { /* non-critical */ }
}
