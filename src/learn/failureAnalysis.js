import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { loadLessons, saveLessons } from './lessons.js';
import { safeParseAI } from '../utils/safeJson.js';
import { getPoolMemory } from '../market/poolMemory.js';

/**
 * Perform a post-mortem analysis of a closed trade.
 * Extracts "Failure Fingerprints" or "Success Patterns" to improve future decision-making.
 */
export async function analyzeTradeResult(position, notifyFn = null) {
  const cfg = getConfig();
  if (!cfg.autoPostMortemEnabled) return null;

  console.log(`🧠 Post-Mortem: Analyzing trade for ${position.pool_address}...`);

  const poolMem = getPoolMemory(position.pool_address);
  const isLoss = (position.pnl_pct || 0) < 0;

  const prompt = `Kamu adalah AI Forensic Analyst untuk bot trading Meteora DLMM.
Tugas kamu adalah melakukan "Post-Mortem" (analisa setelah kejadian) pada sebuah trade yang baru saja ditutup.

DATA TRADE:
- Pool: ${position.pool_address}
- Strategi: ${position.strategy_used}
- Entry: ${position.entry_price || 'Unknown'}
- Hasil: ${position.pnl_pct}% (${position.pnl_usd} USD)
- Alasan Tutup: ${position.close_reason}
- Efisiensi Range: ${position.range_efficiency_pct}%
- Riwayat Pool: ${poolMem ? `Wins: ${poolMem.wins}, Losses: ${poolMem.losses}` : 'Data baru'}

DETAIL KEGAGALAN/KEBERHASILAN:
Jika PnL negatif, identifikasi "Fingerprint Kegagalan" (misal: entry saat momentum terlalu volatil, slippage merusak range, atau dev melakukan dump).
Jika PnL positif, identifikasi "Success Pattern" yang bisa diulangi.

TUGAS:
Ekstrak 1-2 "Lessons Learned" yang sangat spesifik dan ACTIONABLE untuk Hunter Alpha agar tidak mengulangi kesalahan yang sama atau mengulangi keberhasilan yang sama.

Respond HANYA dengan JSON array, format:
[
  {
    "lesson": "Teks lesson dalam Bahasa Indonesia (singkat, padat, teknis)",
    "confidence": 0.0-1.0,
    "crossPool": true/false (apakah ini berlaku umum di pool lain?)
  }
]`;

  try {
    const cfg = getConfig();
    const response = await createMessage({
      model: resolveModel(cfg.generalModel),
      maxTokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = extractText(response).trim();
    
    // Cleaning: LLM often wraps JSON in markdown blocks
    if (text.includes('```')) {
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    }

    let newLessons = [];
    try {
      newLessons = JSON.parse(text);
    } catch {
      newLessons = safeParseAI(text, []);
    }
    
    // Fallback: If parsing fails but we have text, try to extract a single sentence as a lesson
    if ((!Array.isArray(newLessons) || newLessons.length === 0) && text.length > 20) {
      console.log('⚠️ Post-Mortem: Failed to parse JSON, using fallback text.');
      newLessons = [{
        lesson: text.split('\n')[0].slice(0, 150),
        confidence: 0.5,
        crossPool: false
      }];
    }
    
    if (Array.isArray(newLessons) && newLessons.length > 0) {
      const existing = loadLessons();
      const enriched = newLessons.filter(l => l.lesson).map(l => ({
        ...l,
        id: `pm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        learnedAt: new Date().toISOString(),
        source: 'post-mortem',
        poolAddress: position.pool_address,
        pinned: isLoss 
      }));

      if (enriched.length > 0) {
        const merged = [...existing, ...enriched];
        saveLessons(merged.slice(-1000)); // Simpan hingga 1000 pelajaran (efektif selamanya)

        if (notifyFn && isLoss) {
          const lessonStr = enriched.map(l => `• ${l.lesson}`).join('\n');
          await notifyFn(`🧠 *Auto-Correction Initiated*\n\nAnalisa trade ${position.pool_address.slice(0, 8)}:\n${lessonStr}\n\n_Pelajaran ini telah disimpan di "Instinct" bot._`);
        }
      }
      
      return enriched;
    }
  } catch (e) {
    console.error('⚠️ Post-Mortem analysis failed:', e.message);
  }
  return null;
}
