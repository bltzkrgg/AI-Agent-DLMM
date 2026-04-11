import { safeParseAI } from '../utils/safeJson.js';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig, updateConfig, getThresholds } from '../config.js';
import { getClosedPositions, getPositionStats } from '../db/database.js';
import { loadMemory, saveMemory } from '../market/memory.js';
import { refreshAdaptiveStrategyOverrides } from '../strategies/adaptive.js';

// ─── Percentile helper ────────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ─── Data-driven threshold evolution (no AI needed) ──────────────
// Terinspirasi dari Meridian: pakai percentile analysis, bukan rata-rata,
// supaya outlier tidak merusak threshold. Max shift 20% per evolution step.

export function percentileEvolveThresholds() {
  const closed = getClosedPositions();
  if (closed.length < 5) return null;

  const winners = closed.filter(p => (p.pnl_pct || 0) > 0);
  const losers  = closed.filter(p => (p.pnl_pct || 0) < -3);

  if (winners.length < 2 && losers.length < 2) return null;

  const cfg = getConfig();
  const changes  = {};
  const rationale = {};
  const MAX_SHIFT = 0.20; // Max 20% shift per evolution step

  function clampShift(oldVal, newVal) {
    const maxChange = Math.abs(oldVal) * MAX_SHIFT;
    return Math.max(oldVal - maxChange, Math.min(oldVal + maxChange, newVal));
  }

  // 1. Take profit % — jika winners P25 jauh di bawah TP, turunkan TP
  if (winners.length >= 3) {
    const winnerP25 = percentile(winners.map(p => p.pnl_pct || 0), 25);
    const currentTP = cfg.takeProfitFeePct;
    if (winnerP25 < currentTP * 0.75 && winnerP25 > 0) {
      const newTP = parseFloat(clampShift(currentTP, winnerP25 * 1.15).toFixed(1));
      if (Math.abs(newTP - currentTP) >= 0.2) {
        changes.takeProfitFeePct = newTP;
        rationale.takeProfitFeePct = `Win P25=${winnerP25.toFixed(1)}% di bawah TP (${currentTP}%). Turunkan untuk lock profit lebih cepat.`;
      }
    }
  }

  // 2. Stop loss — jika avg loss jauh melebihi stop loss, perketat
  if (losers.length >= 2) {
    const loserAvgLoss = losers.reduce((s, p) => s + Math.abs(p.pnl_pct || 0), 0) / losers.length;
    const currentSL = cfg.stopLossPct;
    if (loserAvgLoss > currentSL * 1.4) {
      const newSL = parseFloat(clampShift(currentSL, currentSL * 0.85).toFixed(1));
      if (Math.abs(newSL - currentSL) >= 0.1) {
        changes.stopLossPct = newSL;
        rationale.stopLossPct = `Avg loss ${loserAvgLoss.toFixed(1)}% > stop-loss ${currentSL}%. Perketat agar cut loss lebih cepat.`;
      }
    }
  }

  // 3. Out-of-range wait — jika posisi OOR yang loss > posisi OOR yang profit, persingkat
  const oorLosers  = losers.filter(p => p.close_reason === 'out_of_range');
  const oorWinners = winners.filter(p => p.close_reason === 'out_of_range');
  if (oorLosers.length > oorWinners.length && oorLosers.length >= 2) {
    const currentOOR = cfg.outOfRangeWaitMinutes;
    const newOOR = Math.round(clampShift(currentOOR, currentOOR * 0.8));
    if (Math.abs(newOOR - currentOOR) >= 1) {
      changes.outOfRangeWaitMinutes = newOOR;
      rationale.outOfRangeWaitMinutes = `${oorLosers.length} posisi OOR berakhir rugi vs ${oorWinners.length} profit. Persingkat wait time.`;
    }
  }

  // 4. Range efficiency — jika rata-rata range efficiency rendah, pertimbangkan pelebaran range
  const withEfficiency = closed.filter(p => p.range_efficiency_pct > 0);
  if (withEfficiency.length >= 5) {
    const avgEff = withEfficiency.reduce((s, p) => s + (p.range_efficiency_pct || 0), 0) / withEfficiency.length;
    if (avgEff < 40 && cfg.takeProfitFeePct > 2) {
      const currentTP = cfg.takeProfitFeePct;
      const newTP = parseFloat(clampShift(currentTP, currentTP * 1.1).toFixed(1));
      if (!changes.takeProfitFeePct && Math.abs(newTP - currentTP) >= 0.2) {
        changes.takeProfitFeePct = newTP;
        rationale.takeProfitFeePct = `Range efficiency rata-rata ${avgEff.toFixed(0)}% — rendah. Naikkan TP untuk kompensasi OOR yang sering.`;
      }
    }
  }

  // 5. minFeeActiveTvlRatio — jika banyak losing positions punya range efficiency rendah,
  //    artinya pool yang dipilih kurang aktif → perketat threshold fee/TVL
  const lowEffLosers = losers.filter(p => (p.range_efficiency_pct || 0) < 30 && p.range_efficiency_pct > 0);
  if (lowEffLosers.length >= 2 && winners.length > 0) {
    const loserLowEffRate = lowEffLosers.length / losers.length;
    const winnerAvgEff = winners.filter(p => p.range_efficiency_pct > 0)
      .reduce((s, p) => s + p.range_efficiency_pct, 0) / (winners.filter(p => p.range_efficiency_pct > 0).length || 1);
    // Jika loser dominan punya range eff rendah DAN winner avg eff jauh lebih tinggi → pool selection buruk
    if (loserLowEffRate >= 0.5 && winnerAvgEff > 50) {
      const currentRatio = cfg.minFeeActiveTvlRatio;
      const newRatio = parseFloat(clampShift(currentRatio, currentRatio * 1.15).toFixed(4));
      if (Math.abs(newRatio - currentRatio) >= 0.002) {
        changes.minFeeActiveTvlRatio = newRatio;
        rationale.minFeeActiveTvlRatio = `${lowEffLosers.length} posisi rugi punya range efficiency <30% — pool kurang aktif. Naikkan threshold fee/TVL dari ${currentRatio} ke ${newRatio}.`;
      }
    }
  }

  // 6. outOfRangeWaitMinutes — jika winner avg eff sangat tinggi (>70%), pool stabil,
  //    bisa perpanjang wait time sedikit untuk beri kesempatan rebound
  if (!changes.outOfRangeWaitMinutes && winners.length >= 3) {
    const winnerWithEff = winners.filter(p => p.range_efficiency_pct > 0);
    if (winnerWithEff.length >= 2) {
      const winnerAvgEff = winnerWithEff.reduce((s, p) => s + p.range_efficiency_pct, 0) / winnerWithEff.length;
      if (winnerAvgEff > 70 && oorLosers.length === 0) {
        const currentOOR = cfg.outOfRangeWaitMinutes;
        const newOOR = Math.round(clampShift(currentOOR, currentOOR * 1.1));
        if (Math.abs(newOOR - currentOOR) >= 1) {
          changes.outOfRangeWaitMinutes = newOOR;
          rationale.outOfRangeWaitMinutes = `Winner avg range efficiency ${winnerAvgEff.toFixed(0)}% tinggi, tidak ada OOR loss — pool stabil, perpanjang wait time sedikit.`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return null;
  return { changes, rationale };
}

// ─── AI-powered threshold evolution ──────────────────────────────

export async function evolveThresholds() {
  const closedPositions = getClosedPositions();

  if (closedPositions.length < 5) {
    throw new Error(`Butuh minimal 5 posisi closed untuk evolve. Sekarang baru ${closedPositions.length}.`);
  }

  const stats = getPositionStats();
  const currentThresholds = getThresholds();
  const cfg = getConfig();

  // 1. Jalankan percentile evolution dulu (data-driven, cepat)
  const dataEvolution = percentileEvolveThresholds();
  if (dataEvolution) {
    updateConfig(dataEvolution.changes);
    console.log('📊 Percentile evolution applied:', dataEvolution.changes);
  }

  // 2. AI refinement di atasnya
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
5. Perubahan maksimal ±20% dari nilai saat ini

Respond HANYA dengan JSON format:
{
  "changes": {
    "thresholdName": newValue
  },
  "rationale": {
    "thresholdName": "alasan perubahan dalam Bahasa Indonesia"
  },
  "summary": "ringkasan analisa dalam 2-3 kalimat Bahasa Indonesia"
}`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const result = safeParseAI(extractText(response));

  const before = { ...currentThresholds };
  updateConfig(result.changes);
  const after = getThresholds();

  const adaptive = refreshAdaptiveStrategyOverrides({ persist: true });

  return {
    summary: result.summary,
    changes: result.changes,
    rationale: result.rationale,
    dataEvolution: dataEvolution || null,
    adaptiveEvolution: adaptive || null,
    before,
    after,
  };
}

// ─── Auto-evolve: trigger tiap 5 posisi closed (tanpa AI call) ───
// Dipanggil otomatis setelah setiap siklus Healer Alpha.

export async function autoEvolveIfReady(notifyFn = null) {
  const memory = loadMemory();
  const closed = getClosedPositions();
  const currentCount = closed.length;
  const lastCount = memory.lastEvolvedAtCount || 0;

  if (currentCount < 5) return null;
  if (currentCount - lastCount < 5) return null;

  try {
    const result = percentileEvolveThresholds();
    if (!result) {
      // Tandai tetap supaya tidak terus-terusan cek
      memory.lastEvolvedAtCount = currentCount;
      saveMemory(memory);
      return null;
    }

    updateConfig(result.changes);
    const adaptive = refreshAdaptiveStrategyOverrides({ persist: true });

    memory.lastEvolvedAtCount = currentCount;
    memory.lastAutoEvolution = new Date().toISOString();
    memory.evolutionCount = (memory.evolutionCount || 0) + 1;
    saveMemory(memory);

    const changedKeys = Object.keys(result.changes);
    const msg = `🧬 *Auto-Evolution #${memory.evolutionCount}*\n\n` +
      `Triggered setelah ${currentCount} posisi closed.\n\n` +
      changedKeys.map(k => `• \`${k}\`: ${result.changes[k]} — ${result.rationale[k]}`).join('\n');

    if (notifyFn) await notifyFn(msg);
    console.log('🧬 Auto-evolution applied:', result.changes);
    if (adaptive?.updated) {
      console.log('🧬 Adaptive strategy tuning updated:', Object.keys(adaptive.strategies || {}));
    }
    return result;
  } catch (e) {
    console.error('Auto-evolve error:', e.message);
    return null;
  }
}
