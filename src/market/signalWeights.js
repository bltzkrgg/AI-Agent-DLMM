/**
 * Signal Weights — Darwinian adaptive weighting
 *
 * Cara kerja:
 * 1. Saat deploy: captureSignals(pool) → simpan snapshot sinyal ke signals.json
 * 2. Saat posisi close: recalibrateWeights() dipanggil otomatis
 * 3. Setiap 5 posisi closed: hitung "lift" tiap sinyal (perbedaan antara
 *    rata-rata sinyal winners vs losers) → update bobot
 * 4. getDarwinWeights() dipakai oleh calculateDarwinScore di hunterAlpha
 *
 * Bounds: min 0.3x, max 2.5x per sinyal
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getClosedPositions } from '../db/database.js';
import { getConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const WEIGHTS_PATH = join(ROOT, 'signal-weights.json');
const SIGNALS_PATH = join(ROOT, 'signals.json'); // sinyal per posisi saat deploy

const WEIGHT_MIN  = 0.3;
const WEIGHT_MAX  = 2.5;
const BOOST       = 0.05;   // +5% untuk top quartile
const DECAY       = 0.95;   // ×0.95 untuk bottom quartile

// Bobot default — selaras dengan harcode hunterAlpha lama
const DEFAULT_WEIGHTS = {
  feeActiveTvlRatio: 2.3,
  mcap:              2.5,
  volume:            0.36,
  holderCount:       0.3,
  multiTFScore:      1.5,
  socialSignal:      1.5,  // baru — discord/social impact
};

// ─── Load / Save ──────────────────────────────────────────────────

function loadWeights() {
  if (!existsSync(WEIGHTS_PATH)) return { ...DEFAULT_WEIGHTS };
  try {
    const w = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf-8'));
    return { ...DEFAULT_WEIGHTS, ...w.weights };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

function saveWeights(weights, meta = {}) {
  const data = {
    updatedAt: new Date().toISOString(),
    weights,
    ...meta,
  };
  try {
    writeFileSync(WEIGHTS_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save signal-weights.json:', e.message);
  }
}

// ─── Signals store — snapshot sinyal per posisi saat deploy ───────

function loadSignals() {
  if (!existsSync(SIGNALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SIGNALS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSignals(signals) {
  try {
    writeFileSync(SIGNALS_PATH, JSON.stringify(signals, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save signals.json:', e.message);
  }
}

// ─── Public: ambil bobot aktual ───────────────────────────────────

export function getDarwinWeights() {
  const weights = loadWeights();
  const cfg = getConfig();
  const hints = cfg.llmWeightHints;
  if (hints && typeof hints === 'object' && !Array.isArray(hints)) {
    // Blend LLM hints (0–5 scale) into statistical weights (0.3–2.5 scale)
    // Soft blend: 70% statistical, 30% LLM hint — LLM never dominates
    for (const [key, rawVal] of Object.entries(hints)) {
      if (key in weights && Number.isFinite(rawVal) && rawVal > 0) {
        const normalized = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, (rawVal / 5) * WEIGHT_MAX));
        weights[key] = +(weights[key] * 0.7 + normalized * 0.3).toFixed(4);
      }
    }
  }
  return weights;
}

// ─── Public: capture sinyal saat deploy ──────────────────────────
// Dipanggil dari hunterAlpha setelah position berhasil dibuka.
// poolData = objek pool dari getTopPools / screen_pools

export function captureSignals(positionAddress, poolData) {
  if (!positionAddress || !poolData) return;

  const tvl  = poolData.liquidityRaw || poolData.tvl || 0;
  const fees = poolData.fees24hRaw   || 0;
  const vol  = poolData.volume24hRaw || 0;

  const snapshot = {
    capturedAt:        new Date().toISOString(),
    feeActiveTvlRatio: tvl > 0 && fees > 0 ? fees / tvl : 0,
    volume:            vol,
    tvl,
    holderCount:       poolData.holderCount || 0,
    multiTFScore:      poolData.multiTFScore || 0, // di-inject oleh hunter sebelum deploy
    socialSignal:      poolData.socialSignal ? (poolData.socialSignal.intensity || 5) / 10 : 0,
    darwinScore:       poolData.darwinScore  || 0,
  };

  const signals = loadSignals();
  signals[positionAddress] = snapshot;

  // Bersih: keep max 200 sinyal terbaru
  const keys = Object.keys(signals);
  if (keys.length > 200) {
    const oldest = keys.slice(0, keys.length - 200);
    oldest.forEach(k => delete signals[k]);
  }

  saveSignals(signals);
}

// ─── Public: recalibrate weights dari closed positions ────────────
// Dipanggil otomatis setiap 5 posisi closed.
// Returns { weights, changes, liftReport } atau null jika data kurang.

export function recalibrateWeights() {
  const cfg           = getConfig();
  const windowDays    = cfg.darwinWindowDays  ?? 60;
  const recalcEvery   = cfg.darwinRecalcEvery ?? 5;

  const allClosed = getClosedPositions();
  if (allClosed.length < 10) return null;

  // Sliding window filter: only positions closed in last windowDays days
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const closed = allClosed.filter(pos => {
    if (!pos.closed_at) return true; // include if no timestamp
    return new Date(pos.closed_at) >= cutoff;
  });

  if (closed.length < 10) return null; // butuh minimal 10 untuk statistik bermakna

  // Check if we've closed enough new positions since last recalibration
  const currentWeightsData = existsSync(WEIGHTS_PATH)
    ? JSON.parse(readFileSync(WEIGHTS_PATH, 'utf-8')).sampleSize || 0
    : 0;
  if (closed.length - currentWeightsData < recalcEvery && currentWeightsData > 0) {
    return null; // not enough new data since last recalibration
  }

  const signals = loadSignals();
  const current = loadWeights();

  // Pasangkan closed positions dengan sinyal mereka
  const paired = closed
    .map(pos => ({
      pnlPct:  pos.pnl_pct || 0,
      signals: signals[pos.position_address] || null,
    }))
    .filter(p => p.signals !== null);

  if (paired.length < 8) return null;

  const winners = paired.filter(p => p.pnlPct > 0);
  const losers  = paired.filter(p => p.pnlPct < -3);

  // Anomaly guard: require minimum balanced samples to prevent weight hijacking
  // by a small extreme batch (e.g. 1 winner / 40 losers during a market crash).
  if (winners.length < 5 || losers.length < 3) return null;
  const imbalanceRatio = Math.max(winners.length, losers.length) / Math.min(winners.length, losers.length);
  if (imbalanceRatio > 5) {
    console.warn(`[signalWeights] Recalibration skipped: sample imbalance ${winners.length}W / ${losers.length}L (ratio ${imbalanceRatio.toFixed(1)}x) — data too skewed`);
    return null;
  }

  const signalKeys = ['feeActiveTvlRatio', 'volume', 'tvl', 'holderCount', 'multiTFScore', 'socialSignal'];
  const liftReport = {};
  const newWeights = { ...current };

  for (const key of signalKeys) {
    const winVals  = winners.map(p => p.signals[key] || 0);
    const loseVals = losers.map(p => p.signals[key] || 0);

    const winMean  = winVals.reduce((s, v) => s + v, 0) / winVals.length;
    const loseMean = loseVals.reduce((s, v) => s + v, 0) / loseVals.length;

    // Lift = normalized mean difference
    const denom = Math.max(winMean, loseMean, 0.0001);
    const lift  = (winMean - loseMean) / denom;

    liftReport[key] = parseFloat(lift.toFixed(4));

    // Quartile-based adjustment:
    // Top quartile (lift > 0.5) → boost
    // Bottom quartile (lift < -0.2) → decay
    if (lift > 0.5) {
      newWeights[key] = Math.min(WEIGHT_MAX, (current[key] || 1) * (1 + BOOST));
    } else if (lift < -0.2) {
      newWeights[key] = Math.max(WEIGHT_MIN, (current[key] || 1) * DECAY);
    }
    // Round to 3 decimals
    newWeights[key] = parseFloat((newWeights[key] || 1).toFixed(3));

    // Anomaly guard: cap single-cycle drift to ±30% of prior weight to prevent
    // one bad batch from overwriting long-run signal memory.
    const prior = current[key] || 1;
    const maxAllowed = parseFloat((prior * 1.30).toFixed(3));
    const minAllowed = parseFloat((prior * 0.70).toFixed(3));
    if (newWeights[key] > maxAllowed) newWeights[key] = maxAllowed;
    if (newWeights[key] < minAllowed) newWeights[key] = minAllowed;
  }

  saveWeights(newWeights, {
    liftReport,
    sampleSize: paired.length,
    winners: winners.length,
    losers: losers.length,
  });

  return { weights: newWeights, liftReport, sampleSize: paired.length };
}

// ─── Public: format untuk Telegram ───────────────────────────────

export function formatWeightsReport(result) {
  if (!result) return '📊 <i>Data belum cukup untuk kalibrasi (butuh min 10 posisi berpasangan).</i>';

  const { weights, liftReport, sampleSize } = result;
  let text = `🧬 <b>Signal Weights Recalibrated</b>\n\nSample: <code>${sampleSize}</code> posisi\n\n`;
  text += '<pre><code>';
  for (const [k, w] of Object.entries(weights)) {
    const lift = liftReport[k] !== undefined ? ` (lift: ${liftReport[k] > 0 ? '+' : ''}${liftReport[k]})` : '';
    text += `${k.padEnd(20)} ${String(w.toFixed(3)).padStart(5)}x${lift}\n`;
  }
  text += '</code></pre>';
  return text;
}
