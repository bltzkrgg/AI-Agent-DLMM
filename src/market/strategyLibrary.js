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

const __dirname = dirname(fileURLToPath(import.meta.url));
// Path absolut ke library strategi di folder yang sama (src/market)
const LIBRARY_PATH = join(__dirname, 'strategy-library.json');

import { getThresholds } from '../config.js';

const DEFAULT_LIBRARY = {
  strategies: [],
  lastUpdated: null,
  totalResearched: 0,
};

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
  if (!marketSnapshot) return { recommended: null, alternatives: [], currentConditions: {} };
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
export async function evaluateStrategyReadiness({ strategyName, snapshot, binStep = 100 }) {
  if (!snapshot) return { ok: false, blockers: ['Missing Snapshot data'] };
  const ta = snapshot.ta || {};
  
  if (strategyName === 'Evil Panda') {
    const st = ta.supertrend;
    const priceChangeM5 = snapshot.ohlcv?.priceChangeM5 || 0;
    const isGreen = priceChangeM5 > 0;
    
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

    // Dynamic range per binStep:
    //   binStep 100 → 90% range (~230 bins, 5 TX)
    //   binStep 125 → 94% range (~225 bins, 5 TX)
    const targetRangePct = binStep === 125 ? 94.0 : 90.0;
    const offsetMin = 0.0;         // Upper bound: mulai tepat di harga saat ini
    const offsetMax = targetRangePct; // Lower bound: turun targetRangePct%
    
    // Suggest 0.5% slippage as per master spec
    const suggestedSlippage = 0.5;

    return {
      ok: true,
      blockers: [],
      notes: `🎯 Evil Panda Master (v61) Active: Price is Bullish. Deploying Ultimate Wide Jaring (0% to -94%).`,
      deployOptions: {
        priceRangePct: targetRangePct,
        entryPriceOffsetMin: offsetMin,
        entryPriceOffsetMax: offsetMax,
        slippagePct: suggestedSlippage,
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
