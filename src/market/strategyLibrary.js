/**
 * Strategy Library
 * 
 * Menyimpan strategi DLMM yang di-extract dari artikel/research.
 * Setiap strategi punya:
 * - Kondisi market yang cocok
 * - Parameter teknis
 * - Kondisi kapan harus exit
 * - Performance history (diupdate dari actual trades)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeNum } from '../utils/safeJson.js';
import { updateRuntimeCollectionItem } from '../runtime/state.js';
import { getStrategyRegimeGuard } from './memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Source-of-truth library path (shared with strategyManager)
const LIBRARY_PATH = join(__dirname, '../../strategy-library.json');

import { getConfig } from '../config.js';

const DEFAULT_LIBRARY = {
  strategies: [],
  lastUpdated: null,
  totalResearched: 0,
};

const PANDA_ENTRY_PROBE_KEY = 'panda-entry-probes';

function recordLivePoolProbe(poolAddress, { activeBinId = null, feeTvlRatio = 0 }) {
  if (!poolAddress) {
    return { driftBinsPerMin: null, feeVelocityOk: true, sampleCount: 0 };
  }

  const nextSample = {
    ts: Date.now(),
    activeBinId: Number.isFinite(activeBinId) ? activeBinId : null,
    feeTvlRatio: safeNum(feeTvlRatio),
  };

  const samples = updateRuntimeCollectionItem(PANDA_ENTRY_PROBE_KEY, poolAddress, current => {
    const prev = Array.isArray(current?.samples) ? current.samples : [];
    const merged = [...prev, nextSample].slice(-6);
    return { samples: merged };
  })?.samples || [nextSample];

  let driftBinsPerMin = null;
  if (samples.length >= 2) {
    const prev = samples[samples.length - 2];
    const curr = samples[samples.length - 1];
    if (Number.isFinite(prev?.activeBinId) && Number.isFinite(curr?.activeBinId)) {
      const deltaBins = Math.abs(curr.activeBinId - prev.activeBinId);
      const deltaMin = Math.max((curr.ts - prev.ts) / 60000, 1 / 60);
      driftBinsPerMin = deltaBins / deltaMin;
    }
  }

  let feeVelocityOk = true;
  if (samples.length >= 2) {
    const last2 = samples.slice(-2).map(s => safeNum(s.feeTvlRatio));
    const strictlyDescending = last2[0] > last2[1];
    const meaningfulDrop = last2[1] < last2[0] * 0.8;
    if (strictlyDescending && meaningfulDrop) {
      feeVelocityOk = false;
    }
  }

  return {
    driftBinsPerMin: driftBinsPerMin != null ? Number(driftBinsPerMin.toFixed(2)) : null,
    feeVelocityOk,
    sampleCount: samples.length,
  };
}

// ─── Research Storage ──────────────────────────────────────────
// strategyLibrary.js kini hanya fokus menyimpan strategi hasil riset dinamis.
// Strategi baseline (Evil Panda dkk) sudah dipindah ke strategyManager.js.

// ─── Load / Save ─────────────────────────────────────────────────

export function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) {
    const initial = { ...DEFAULT_LIBRARY, strategies: [] };
    saveLibrary(initial);
    return initial;
  }
  try {
    const data = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
    return data;
  } catch {
    return { ...DEFAULT_LIBRARY, strategies: [] };
  }
}

export function saveLibrary(library) {
  writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2));
}

// ─── Add strategy from research ──────────────────────────────────

export function addResearchedStrategy(strategy) {
  const library = loadLibrary();
  const id = `research_${Date.now()}`;

  const newStrategy = {
    id,
    ...strategy,
    source: 'research',
    addedAt: new Date().toISOString(),
    performanceHistory: [],
    confidence: strategy.confidence || 0.6,
  };

  library.strategies.push(newStrategy);
  library.lastUpdated = new Date().toISOString();
  library.totalResearched = (library.totalResearched || 0) + 1;
  saveLibrary(library);
  return newStrategy;
}

// ─── Match strategy to market conditions ─────────────────────────

export function matchStrategyToMarket(marketSnapshot) {
  if (!marketSnapshot) return { recommended: null, alternatives: [], currentConditions: {}, regime: null };
  const library = loadLibrary();
  const strategies = library.strategies;

  const ohlcv = marketSnapshot.ohlcv;
  const sentiment = marketSnapshot.sentiment;
  const onChain = marketSnapshot.onChain;

  const trend    = ohlcv?.trend || 'SIDEWAYS';
  const buyPressure = sentiment?.buyPressurePct || 50;

  // Determine current market state
  const atrPct      = ohlcv?.atr14?.atrPct ?? 0;
  const range24h    = ohlcv?.range24hPct   ?? 0;
  const currentPrice = ohlcv?.currentPrice ?? 0;
  const support     = ohlcv?.support       ?? 0;
  const ta          = marketSnapshot.ta    ?? {};
  const feeApr      = marketSnapshot.pool?.feeApr ?? 0;

  // High fee potential
  const highFeeApr = feeApr > 200;

  const currentConditions = {
    trend,
    volatility: classifyVolatility(ohlcv),
    sentiment: sentiment?.sentiment || 'NEUTRAL',
    volumeVsAvg: parseFloat(ohlcv?.volumeVsAvg || 1.0),
    buyPressure,
    highFeeApr,
  };

  // Get market regime classification
  const regimeInfo = classifyMarketRegime(marketSnapshot);

  // Score each strategy against current conditions
  const scored = strategies.map(strategy => {
    const score = scoreStrategy(strategy, currentConditions);
    return { ...strategy, matchScore: score, currentConditions };
  });

  // Sort by match score
  const sorted = scored
    .filter(s => s.matchScore > 0.3)
    .sort((a, b) => b.matchScore - a.matchScore);

  return {
    recommended: sorted[0] || null,
    alternatives: sorted.slice(1, 3),
    currentConditions,
    regime: regimeInfo,
    allScored: sorted,
  };
}

function scoreStrategy(strategy, conditions) {
  const mc = strategy.marketConditions;
  if (!mc) return 0.5;

  let score = 0;

  // ── Priority bonus — Single-Side SOL selalu dapat base score lebih tinggi ──
  if (strategy.type === 'single_side_y') {
    score += 0.30; // default priority bonus
  }

  // Trend match
  if (mc.trend && mc.trend.includes(conditions.trend)) {
    score += 0.25;
  } else if (mc.trend && !mc.trend.includes(conditions.trend)) {
    score -= 0.05; // penalti kecil, bukan eliminasi
  }

  // Volatility match
  if (mc.volatility && mc.volatility.includes(conditions.volatility)) {
    score += 0.20;
  }

  // Sentiment match
  if (mc.sentiment && mc.sentiment.includes(conditions.sentiment)) {
    score += 0.15;
  }

  // Volume match
  if (mc.volumeVsAvg) {
    const vol = conditions.volumeVsAvg;
    if (vol >= mc.volumeVsAvg.min && vol <= mc.volumeVsAvg.max) {
      score += 0.15;
    }
  }

  // Performance history boost
  if (strategy.performanceHistory?.length > 0) {
    const wins = strategy.performanceHistory.filter(p => p.profitable).length;
    const winRate = wins / strategy.performanceHistory.length;
    score += winRate * 0.10;
  }

  // Whale risk penalty — HANYA untuk single_side_x (token side),
  // bukan untuk single_side_y (SOL) karena whale sell justru bagus untuk SOL range
  if (conditions.whaleRisk === 'HIGH' && strategy.type === 'single_side_x') {
    score -= 0.20;
  }

  // Kondisi khusus: kalau whale risk HIGH, single-side SOL justru dapat bonus
  // karena whale menjual token ke SOL range kamu = fee terkumpul stabil
  if (conditions.whaleRisk === 'HIGH' && strategy.type === 'single_side_y') {
    score += 0.10;
  }

  // Evil Panda momentum bonus
  if (strategy.id === 'evil_panda') {
    if (conditions.trend === 'UPTREND' && conditions.buyPressure > 60) {
      score += 0.35;
    } else {
      score -= 0.50;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Eval readiness based on technical indicators and market snapshot.
 * Integrated for Technical Sniper upgrade.
 */
export async function evaluateStrategyReadiness({ strategyName, snapshot, binStep = 100, activeBinId = null }) {
  if (!snapshot) return { ok: false, blockers: ['Missing Snapshot data'] };
  const cfg = getConfig();
  const minFeeYieldRatio = Math.max(0, Number(cfg.minDailyFeeYieldPct ?? 1.0)) / 100;
  const minAtrPct = Math.max(0, Number(cfg.minAtrPctForEntry ?? 2.0));
  const maxH1StaleMin = Math.max(15, Number(cfg.maxOhlcvStaleMinutes1h ?? 180));
  const ta = snapshot.ta || {};
  
  if (strategyName === 'Evil Panda') {
    const st = ta.supertrend;
    const priceChangeM5 = snapshot.ohlcv?.priceChangeM5 || 0;
    const priceChangeH1 = snapshot.ohlcv?.priceChangeH1 || 0;
    const isGreen = priceChangeM5 > 0;
    const pool = snapshot.pool || {};
    const feeTvlRatio = safeNum(pool.feeTvlRatio);
    const volumeTvlRatio = pool.tvl > 0 ? safeNum(pool.volume24h) / safeNum(pool.tvl) : 0;
    const liveProbe = recordLivePoolProbe(snapshot.poolAddress, { activeBinId, feeTvlRatio });
    const regimeGuard = getStrategyRegimeGuard({ strategyName, snapshot });
    
    // ── Hard Guard: Supertrend Bullish State (15m) AND Green Momentum ──
    if (st && (st.trend !== 'BULLISH' || !isGreen)) {
      const reason = st.trend !== 'BULLISH' ? 'Supertrend 15m is ' + st.trend : '15m Candle is RED (No Momentum)';
      return {
        ok: false,
        blockers: [reason],
        notes: `Tactical Panda requires 15m BULLISH Trend AND 15m Green Candle confirmation. Current Change: ${priceChangeM5}%`,
      };
    } else if (!st) {
      // Data Supertrend 15m belum tersedia — koin terlalu baru secara teknikal.
      // Supertrend butuh min. 10 candle × 15m = 150 menit (~2.5 jam) untuk initialize.
      // [Berbeda dari safety filter 1 jam di coinfilter — ini murni syarat data TA.]
      return {
        ok: false,
        blockers: ['Data TA Supertrend 15m belum tersedia — koin perlu ~2.5 jam data candle'],
        notes: 'Evil Panda butuh konfirmasi Supertrend 15m (min. 10 candle = ~150 menit). Safety filter coinfilter = 1 jam; TA data filter = ~2.5 jam — keduanya INDEPENDENT.',
      };
    }

    if (feeTvlRatio > 0 && feeTvlRatio < minFeeYieldRatio) {
      return {
        ok: false,
        blockers: [`Fee/TVL harian terlalu rendah untuk Evil Panda (${(feeTvlRatio * 100).toFixed(2)}%)`],
        notes: `Evil Panda butuh pool yang benar-benar produktif. Fee yield harian di bawah ${(minFeeYieldRatio * 100).toFixed(2)}% biasanya terlalu lemah untuk membayar directional risk.`,
      };
    }

    if (volumeTvlRatio > 0 && volumeTvlRatio < 0.75) {
      return {
        ok: false,
        blockers: [`Volume/TVL terlalu lemah (${volumeTvlRatio.toFixed(2)}x)`],
        notes: 'Flow trader belum cukup aktif. Untuk LP single-side SOL, volume/TVL lemah berarti fee bisa kalah oleh drift harga.',
      };
    }

    if (liveProbe.driftBinsPerMin != null && liveProbe.driftBinsPerMin > 10.0) {
      return {
        ok: false,
        blockers: [`Active-bin drift live terlalu cepat (${liveProbe.driftBinsPerMin.toFixed(2)} bins/min)`],
        notes: 'Drift bin on-chain bergerak terlalu cepat antar sample. Tunggu pasar lebih tenang agar jaring Panda tidak langsung keseret.',
      };
    }

    const atrPctNow = Number(snapshot?.ohlcv?.atrPct);
    if (Number.isFinite(atrPctNow) && atrPctNow < minAtrPct) {
      return {
        ok: false,
        blockers: [`ATR terlalu rendah (${atrPctNow.toFixed(2)}% < ${minAtrPct.toFixed(2)}%)`],
        notes: 'Volatilitas belum cukup untuk masuk LP aktif. Tunggu ATR menguat dulu.',
      };
    }

    const historyAgeMinutes = Number(snapshot?.ohlcv?.historyAgeMinutes);
    if (Number.isFinite(historyAgeMinutes) && historyAgeMinutes > maxH1StaleMin) {
      return {
        ok: false,
        blockers: [`Data candle stale (${historyAgeMinutes.toFixed(1)}m > ${maxH1StaleMin}m)`],
        notes: 'Data 1h terlalu lama untuk menilai momentum. Skip entry sampai feed segar kembali.',
      };
    }

    if (priceChangeH1 > 12) {
      return {
        ok: false,
        blockers: [`Momentum 1h terlalu panas (${priceChangeH1.toFixed(2)}%)`],
        notes: 'Evil Panda tidak mengejar candle vertikal. Tunggu euforia 1h mereda sebelum deploy.',
      };
    }

    if (liveProbe.sampleCount >= 2 && !liveProbe.feeVelocityOk) {
      return {
        ok: false,
        blockers: ['Fee velocity multi-cycle melemah'],
        notes: 'Dua sample terakhir menunjukkan fee/TVL menurun cukup tajam. Evil Panda menunggu aliran fee stabil sebelum entry.',
      };
    }

    if (regimeGuard.blocked) {
      return {
        ok: false,
        blockers: ['Regime memory block'],
        notes: regimeGuard.reason,
      };
    }

    // Range: 1% below price as upper bound, -94% as lower bound.
    // Pure Y-only (SOL) net — starts 1 bin below active price, no X exposure.
    // distributionType SPOT ensures even SOL spread across all bins.
    const offsetMin = 1.0;  // Upper bound: 1% below current price (strictly Y-only)
    const offsetMax = 94.0; // Lower bound: -94% below current price

    return {
      ok: true,
      blockers: [],
      notes: `🎯 Evil Panda Master (v61) Active: Price is Bullish. Deploying Ultimate Wide Jaring (1% to -94%), SPOT distribution.`,
      deployOptions: {
        priceRangePct: offsetMax,
        entryPriceOffsetMin: offsetMin,
        entryPriceOffsetMax: offsetMax,
        distributionType: 'SPOT',
        slippagePct: 0.5,
      }
    };
  }

  return { ok: false, blockers: [`Strategy ${strategyName} is currently disabled or unrecognized.`] };
}

export function getRecommendedStrategies(snapshot) {
  const ohlcv = snapshot.ohlcv;
  if (!ohlcv) return 'MEDIUM';
  const range = ohlcv.high24h && ohlcv.low24h
    ? ((ohlcv.high24h - ohlcv.low24h) / ohlcv.low24h * 100)
    : 0;
  if (range > 15) return 'HIGH';
  if (range < 5) return 'LOW';
  return 'MEDIUM';
}

function classifyVolatility(ohlcv) {
  if (!ohlcv) return 'MEDIUM';
  const range = ohlcv.range24hPct || 0;
  if (range > 15) return 'HIGH';
  if (range < 5) return 'LOW';
  return 'MEDIUM';
}

/**
 * Classify market regime based on technical and sentiment snapshot.
 * Returns actionable regime classification with blockers and strategy recommendations.
 */
export function classifyMarketRegime(snapshot) {
  if (!snapshot) {
    return {
      regime: 'LOW_LIQ_HIGH_RISK',
      confidence: 0.0,
      blockers: ['No snapshot data available'],
      recommendation: 'WAIT',
      reasonCodes: [],
      notes: 'Insufficient data for regime classification',
    };
  }

  const ta = snapshot.ta || {};
  const ohlcv = snapshot.ohlcv || {};
  const pool = snapshot.pool || {};
  const sentiment = snapshot.sentiment || {};

  const cfg = getConfig();
  const minAtrPct = Math.max(0, Number(cfg.minAtrPctForEntry ?? 2.0));
  const minFeeYieldRatio = Math.max(0, Number(cfg.minDailyFeeYieldPct ?? 1.0)) / 100;
  const maxH1StaleMin = Math.max(15, Number(cfg.maxOhlcvStaleMinutes1h ?? 180));
  const supertrend = ta.supertrend;
  const priceChangeH1 = ohlcv.priceChangeH1 || 0;
  const priceChangeM5 = ohlcv.priceChangeM5 || 0;
  const atrPct = ohlcv.atrPct || 0;
  const historyAgeMinutes = Number(ohlcv.historyAgeMinutes);
  const h1Stale = Number.isFinite(historyAgeMinutes) && historyAgeMinutes > maxH1StaleMin;
  const range24hPct = ohlcv.range24hPct || 0;
  const tvl = pool.tvl || 0;
  const volume24h = pool.volume24h || 0;
  const volumeTvlRatio = tvl > 0 ? volume24h / tvl : 0;

  const reasonCodes = [];
  const blockers = [];
  let regime = 'SIDEWAYS_CHOP';
  let confidence = 0.5;
  let recommendation = 'WAIT';

  // ─── BULL_TREND Detection ──────────────────────────────────────────
  if (
    !h1Stale &&
    supertrend &&
    supertrend.trend === 'BULLISH' &&
    priceChangeH1 > 2 &&
    volumeTvlRatio > 1.5
  ) {
    regime = 'BULL_TREND';
    confidence = 0.85;
    recommendation = 'evil_panda';
    reasonCodes.push('TREND_BULL', 'PRICE_UP_H1', 'VOL_HIGH');
  }
  // ─── BEAR_DEFENSE Detection ──────────────────────────────────────────
  else if (supertrend && supertrend.trend === 'BEARISH') {
    regime = 'BEAR_DEFENSE';
    confidence = 0.8;
    recommendation = 'AVOID';
    blockers.push('Bearish trend — entry forbidden');
    reasonCodes.push('TREND_BEAR');
  } else if (priceChangeH1 < -5) {
    regime = 'BEAR_DEFENSE';
    confidence = 0.75;
    recommendation = 'AVOID';
    blockers.push('Strong downtrend (H1 < -5%) — entry forbidden');
    reasonCodes.push('PRICE_DOWN_SEVERE');
  }
  // ─── LOW_LIQ_HIGH_RISK Detection ──────────────────────────────────────
  else if (tvl < 50000 || volumeTvlRatio < 0.3) {
    regime = 'LOW_LIQ_HIGH_RISK';
    confidence = 0.65;
    recommendation = 'AVOID';
    blockers.push('Insufficient liquidity or trader flow');
    reasonCodes.push('LOW_LIQUIDITY');
  }
  // ─── SIDEWAYS_CHOP Detection ──────────────────────────────────────────
  else if (Math.abs(priceChangeH1) < 2 && atrPct < Math.max(minAtrPct, 3) && range24hPct < 8) {
    regime = 'SIDEWAYS_CHOP';
    confidence = 0.6;
    recommendation = 'WAIT';
    blockers.push('Low volatility — IL risk without fee compensation');
    reasonCodes.push('LOW_VOL', 'TIGHT_RANGE');
  }

  // Add additional reason codes if not yet set
  if (reasonCodes.length === 0) {
    reasonCodes.push('NEUTRAL');
  }

  // Add fee assessment
  const feeTvlRatio = pool.feeTvlRatio || 0;
  if (feeTvlRatio > minFeeYieldRatio) {
    reasonCodes.push('FEE_OK');
  } else if (feeTvlRatio > 0) {
    reasonCodes.push('FEE_LOW');
  }

  if (h1Stale) {
    reasonCodes.push('H1_STALE');
    blockers.push(`Data 1h stale (${historyAgeMinutes.toFixed(1)}m > ${maxH1StaleMin}m)`);
    if (recommendation === 'evil_panda') {
      recommendation = 'WAIT';
      regime = 'SIDEWAYS_CHOP';
      confidence = Math.min(confidence, 0.55);
    }
  }

  const notes =
    recommendation === 'evil_panda'
      ? 'Bullish confluence detected. Evil Panda conditions met.'
      : recommendation === 'AVOID'
        ? `Market regime ${regime}. Deploy forbidden.`
        : recommendation === 'WAIT'
          ? `Market regime ${regime}. Hold and monitor.`
          : 'Market conditions insufficient for confident entry.';

  return {
    regime,
    confidence,
    blockers,
    recommendation,
    reasonCodes,
    notes,
  };
}

// ─── Update performance history ──────────────────────────────────

export function recordStrategyPerformance(strategyId, result) {
  const library = loadLibrary();
  const strategy = library.strategies.find(s => s.id === strategyId);
  if (!strategy) return;

  strategy.performanceHistory = strategy.performanceHistory || [];
  strategy.performanceHistory.push({
    ...result,
    timestamp: new Date().toISOString(),
  });

  // Keep last 50 performance records
  if (strategy.performanceHistory.length > 50) {
    strategy.performanceHistory = strategy.performanceHistory.slice(-50);
  }

  // Recalculate confidence based on performance
  const wins = strategy.performanceHistory.filter(p => p.profitable).length;
  if (strategy.performanceHistory.length >= 3) {
    const winRate = wins / strategy.performanceHistory.length;
    // Blend original confidence with performance
    strategy.confidence = (strategy.confidence * 0.3) + (winRate * 0.7);
  }

  saveLibrary(library);
}

// ─── Get library stats ───────────────────────────────────────────

export function getLibraryStats() {
  const library = loadLibrary();
  return {
    totalStrategies: library.strategies.length,
    builtinCount: library.strategies.filter(s => s.source === 'builtin').length,
    researchedCount: library.strategies.filter(s => s.source === 'research').length,
    lastUpdated: library.lastUpdated,
    totalResearched: library.totalResearched || 0,
    topStrategies: library.strategies
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 3)
      .map(s => ({ name: s.name, confidence: s.confidence, type: s.type })),
  };
}
