import { safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, updateConfig, getThresholds } from '../config.js';
import { getClosedPositions, getPositionStats } from '../db/database.js';


export async function evolveThresholds() {
  const closedPositions = getClosedPositions();

  if (closedPositions.length < 5) {
    throw new Error(`Butuh minimal 5 posisi closed untuk evolve. Sekarang baru ${closedPositions.length}.`);
  }

  const stats = getPositionStats();
  const currentThresholds = getThresholds();
  const cfg = getConfig();

  const prompt = `Kamu adalah optimizer untuk strategi LP di Meteora DLMM.

Data performa posisi yang sudah ditutup:
${JSON.stringify(closedPositions.slice(-20), null, 2)}

Statistik keseluruhan:
${JSON.stringify(stats, null, 2)}

Threshold screening saat ini:
${JSON.stringify(currentThresholds, null, 2)}

Tugas kamu:
1. Analisa korelasi antara threshold saat screening dengan hasil PnL
2. Identifikasi threshold mana yang perlu diperketat atau dilonggarkan
3. Berikan rekomendasi perubahan yang spesifik dan berbasis data
4. Jangan ubah lebih dari 3 threshold sekaligus
5. Perubahan maksimal ±30% dari nilai saat ini

Respond HANYA dengan JSON format:
{
  "changes": {
    "thresholdName": newValue,
    ...
  },
  "rationale": {
    "thresholdName": "alasan perubahan dalam Bahasa Indonesia",
    ...
  },
  "summary": "ringkasan analisa dalam 2-3 kalimat Bahasa Indonesia"
}`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  
  const result = safeParseAI(text);

  // Apply changes
  const before = { ...currentThresholds };
  updateConfig(result.changes);
  const after = getThresholds();

  return {
    summary: result.summary,
    changes: result.changes,
    rationale: result.rationale,
    before,
    after,
  };
}
