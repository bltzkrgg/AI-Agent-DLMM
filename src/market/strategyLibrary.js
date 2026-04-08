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
const LIBRARY_PATH = join(__dirname, '../../strategy-library.json');

const DEFAULT_LIBRARY = {
  strategies: [],
  lastUpdated: null,
  totalResearched: 0,
};

// ─── Built-in baseline strategies ────────────────────────────────
const BUILTIN_STRATEGIES = [
  {
    id: 'builtin_spot',
    name: 'Spot Balanced',
    type: 'spot',
    source: 'builtin',
    description: 'Distribusi likuiditas merata di sekitar harga aktif.',
    marketConditions: {
      trend: ['SIDEWAYS'],
      volatility: ['LOW', 'MEDIUM'],
      sentiment: ['NEUTRAL', 'BULLISH'],
      volumeVsAvg: { min: 0.5, max: 2.0 },
    },
    parameters: {
      priceRangePercent: 5,
      binStep: 10,
      strategyType: 0,
      tokenXWeight: 50,
      tokenYWeight: 50,
    },
    entryConditions: 'Market sideways, volume normal, tidak ada trend kuat.',
    exitConditions: 'Kalau trend mulai terbentuk, switch ke bid-ask atau single-side.',
    confidence: 0.7,
    performanceHistory: [],
  },
  {
    id: 'builtin_curve',
    name: 'Curve Concentrated',
    type: 'curve',
    source: 'builtin',
    description: 'Likuiditas terkonsentrasi di dekat harga aktif. Fee maksimal tapi cepat out of range.',
    marketConditions: {
      trend: ['SIDEWAYS'],
      volatility: ['LOW'],
      sentiment: ['NEUTRAL'],
      volumeVsAvg: { min: 0.3, max: 1.5 },
    },
    parameters: {
      priceRangePercent: 2,
      binStep: 5,
      strategyType: 1,
      tokenXWeight: 50,
      tokenYWeight: 50,
    },
    entryConditions: 'Market sangat sideways, volatilitas rendah, stable pair.',
    exitConditions: 'Kalau ada breakout atau volatilitas naik, segera exit.',
    confidence: 0.65,
    performanceHistory: [],
  },
  {
    id: 'builtin_bidask',
    name: 'Bid-Ask Wide',
    type: 'bid_ask',
    source: 'builtin',
    description: 'Spread lebar di dua sisi. Tahan volatile, fee terkumpul dari swing.',
    marketConditions: {
      trend: ['UPTREND', 'DOWNTREND', 'SIDEWAYS'],
      volatility: ['HIGH', 'MEDIUM'],
      sentiment: ['BULLISH', 'BEARISH', 'NEUTRAL'],
      volumeVsAvg: { min: 1.0, max: 999 },
    },
    parameters: {
      priceRangePercent: 15,
      binStep: 20,
      strategyType: 2,
      tokenXWeight: 50,
      tokenYWeight: 50,
    },
    entryConditions: 'Volatilitas tinggi, volume di atas rata-rata, ada momentum.',
    exitConditions: 'Kalau market mulai stabil dan fee APR turun drastis.',
    confidence: 0.75,
    performanceHistory: [],
  },
  {
    id: 'builtin_singleside_x',
    name: 'Single-Side Token X',
    type: 'single_side_x',
    source: 'builtin',
    description: 'Hanya deposit token X (SOL/base token). Cocok kalau yakin harga naik.',
    marketConditions: {
      trend: ['UPTREND'],
      volatility: ['LOW', 'MEDIUM'],
      sentiment: ['BULLISH'],
      volumeVsAvg: { min: 1.2, max: 999 },
    },
    parameters: {
      priceRangePercent: 8,
      binStep: 10,
      strategyType: 0,
      tokenXWeight: 100,
      tokenYWeight: 0,
      singleSide: 'x',
    },
    entryConditions: 'Strong uptrend, buy pressure dominan > 65%, momentum kuat.',
    exitConditions: 'Kalau momentum melemah atau sentiment berubah bearish.',
    confidence: 0.7,
    performanceHistory: [],
  },
  {
    id: 'builtin_evil_panda',
    name: 'Evil Panda',
    type: 'single_side_y',
    source: 'builtin',
    description: 'Evil Panda — single-side SOL pada high-volume coins. Entry saat price break atas Supertrend 15m. Exit confluence RSI(2)>90 + BB upper atau RSI(2)>90 + MACD first green. Pilih pool bin step 80/100/125.',
    marketConditions: {
      trend: ['UPTREND'],
      volatility: ['MEDIUM', 'HIGH'],
      sentiment: ['BULLISH'],
      volumeVsAvg: { min: 2.0, max: 999 },
    },
    parameters: {
      fixedBinsBelow: 69,
      binStep: 100,
      strategyType: 0,
      tokenXWeight: 0,
      tokenYWeight: 100,
      singleSide: 'y',
      preferredBinSteps: [80, 100, 125],
      minMcap: 250000,
      minVolume24h: 1000000,
    },
    entryConditions: 'Price momentum align with UPTREND on 15m. Pool bin step 80/100/125. Narrative/token harus lolos Coin Filter.',
    exitConditions: 'Momentum reversal or fee velocity drop. Emergency stop-loss tetap aktif.',
    confidence: 0.82,
    performanceHistory: [],
  },
  {
    id: 'builtin_wave_enjoyer',
    name: 'Wave Enjoyer',
    type: 'single_side_y',
    source: 'builtin',
    description: 'Single-Side SOL saat price mendekati support 24h. Tangkap fee dari bounce volume. Clear invalidation: support broken = OOR kiri = close.',
    marketConditions: {
      trend: ['SIDEWAYS', 'DOWNTREND'],
      volatility: ['LOW', 'MEDIUM'],
      sentiment: ['NEUTRAL', 'BULLISH'],
      volumeVsAvg: { min: 0.7, max: 3.0 },
    },
    parameters: {
      fixedBinsBelow: 24,
      binStep: 80,
      strategyType: 0,
      tokenXWeight: 0,
      tokenYWeight: 100,
      singleSide: 'y',
      minVolume5mUsd: 100000,
      holdMinMinutes: 10,
      holdMaxMinutes: 20,
    },
    entryConditions: 'Price dekat latest support. Volume 5m >= $100k. Narrative/token harus lolos Coin Filter.',
    exitConditions: 'Support broken / OOR kiri → close. Fokus capture 1-2 wave retracement, hold 10-20 menit.',
    confidence: 0.75,
    performanceHistory: [],
  },
  {
    id: 'builtin_npc',
    name: 'NPC',
    type: 'single_side_y',
    source: 'builtin',
    description: 'Single-Side SOL setelah breakout besar. Price temukan level baru dan konsolidasi. Fee terkumpul dari high-frequency back-and-forth trading.',
    marketConditions: {
      trend: ['SIDEWAYS', 'UPTREND'],
      volatility: ['MEDIUM'],
      sentiment: ['NEUTRAL', 'BULLISH'],
      volumeVsAvg: { min: 1.0, max: 5.0 },
    },
    parameters: {
      fixedBinsBelow: 69,
      binStep: 80,
      strategyType: 0,
      tokenXWeight: 0,
      tokenYWeight: 100,
      singleSide: 'y',
      minVolume5mUsd: 50000,
      holdMinMinutes: 30,
      holdMaxMinutes: 360,
    },
    entryConditions: 'Setelah volume spike / ATH. Volume 5m >= $50k. Narrative/token harus lolos Coin Filter.',
    exitConditions: 'Hold 30 menit sampai 6 jam. Close saat reversal kuat, fee velocity drop, atau hold window habis.',
    confidence: 0.72,
    performanceHistory: [],
  },
  {
    id: 'builtin_fee_sniper',
    name: 'Fee Sniper',
    type: 'single_side_y',
    source: 'builtin',
    description: 'Ultra-tight range saat BB squeeze + fee APR sangat tinggi. Masuk saat market konsolidasi ketat, collect fee maksimal, exit saat BB expand.',
    marketConditions: {
      trend: ['SIDEWAYS'],
      volatility: ['LOW'],
      sentiment: ['NEUTRAL'],
      volumeVsAvg: { min: 0.6, max: 2.0 },
    },
    parameters: {
      priceRangePercent: 4,
      binStep: 5,
      strategyType: 0,
      tokenXWeight: 0,
      tokenYWeight: 100,
      singleSide: 'y',
    },
    entryConditions: 'Low volatility (ATR < 2%). Fee APR > 200%. Volume sustained ≥ 60% avg. Price sideways.',
    exitConditions: 'Volatility breakout or fee velocity drop → claim & close. Hold 1-4 jam.',
    confidence: 0.78,
    performanceHistory: [],
  },
  {
    id: 'builtin_singleside_y',
    name: 'Single-Side SOL',
    type: 'single_side_y',
    source: 'builtin',
    priority: 1,
    description: 'Hanya deposit SOL. Strategi utama — tidak perlu pegang token, risiko IL terbatas pada SOL.',
    marketConditions: {
      trend: ['SIDEWAYS', 'DOWNTREND', 'UPTREND'],
      volatility: ['LOW', 'MEDIUM', 'HIGH'],
      sentiment: ['NEUTRAL', 'BEARISH', 'BULLISH'],
      volumeVsAvg: { min: 0.5, max: 999 },
    },
    parameters: {
      priceRangePercent: 8,
      binStep: 10,
      strategyType: 0,
      tokenXWeight: 0,
      tokenYWeight: 100,
      singleSide: 'y',
    },
    entryConditions: 'DEFAULT STRATEGY. Hanya butuh SOL, tidak perlu beli token. Fee dikumpulkan saat harga ada di range.',
    exitConditions: 'Kalau range keluar terlalu lama atau fee APR turun drastis. Auto-swap fee ke SOL setelah claim.',
    confidence: 0.80,
    performanceHistory: [],
  },
];

// ─── Load / Save ─────────────────────────────────────────────────

export function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) {
    const initial = { ...DEFAULT_LIBRARY, strategies: [...BUILTIN_STRATEGIES] };
    saveLibrary(initial);
    return initial;
  }
  try {
    const data = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
    // Ensure builtins always present
    const existingIds = data.strategies.map(s => s.id);
    const missingBuiltins = BUILTIN_STRATEGIES.filter(b => !existingIds.includes(b.id));
    data.strategies = [...missingBuiltins, ...data.strategies];
    return data;
  } catch {
    return { ...DEFAULT_LIBRARY, strategies: [...BUILTIN_STRATEGIES] };
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
  const rsi14       = ta?.rsi14            ?? 50;
  const bb          = ta?.bb;
  const feeApr      = marketSnapshot.pool?.feeApr ?? 0;

  // Price proximity to 24h support (Wave Enjoyer signal)
  const priceVsSupportPct = support > 0 && currentPrice > 0
    ? ((currentPrice - support) / support) * 100 : null;
  const priceNearSupport = priceVsSupportPct !== null
    && priceVsSupportPct >= 0 && priceVsSupportPct <= 8;

  // Post-breakout consolidation (NPC signal)
  const postBreakout  = range24h >= 15;
  const consolidating = atrPct > 0 && atrPct < range24h * 0.12;

  // High fee (Fee Sniper signal)
  const highFeeApr = feeApr > 200;

  const currentConditions = {
    trend,
    volatility: classifyVolatility(ohlcv),
    sentiment: sentiment?.sentiment || 'NEUTRAL',
    volumeVsAvg: parseFloat(ohlcv?.volumeVsAvg || 1.0),
    buyPressure,
    // Fee Sniper
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
  if (strategy.id === 'builtin_evil_panda') {
    if (conditions.trend === 'UPTREND' && conditions.buyPressure > 60) {
      score += 0.35;
    } else {
      score -= 0.50;
    }
  }

  // Wave Enjoyer — price near support
  if (strategy.id === 'builtin_wave_enjoyer') {
    if (conditions.priceNearSupport) {
      score += 0.35;
    } else {
      score -= 0.40;
    }
  }

  // NPC — consolidation
  if (strategy.id === 'builtin_npc') {
    if (conditions.postBreakout && conditions.consolidating) {
      score += 0.40;
    } else {
      score -= 0.35;
    }
  }

  // Fee Sniper — high fee APR
  if (strategy.id === 'builtin_fee_sniper') {
    if (conditions.highFeeApr) {
      score += 0.45;
    } else {
      score -= 0.35;
    }
  }

  return Math.max(0, Math.min(1, score));
}

function classifyVolatility(ohlcv) {
  if (!ohlcv) return 'MEDIUM';
  const range = ohlcv.high24h && ohlcv.low24h
    ? ((ohlcv.high24h - ohlcv.low24h) / ohlcv.low24h * 100)
    : 0;
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
