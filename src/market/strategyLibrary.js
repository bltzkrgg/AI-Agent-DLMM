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

  const smBuying = marketSnapshot.okx?.smartMoneyBuying ?? null;
  const trend    = ohlcv?.trend || 'SIDEWAYS';
  const buyPressure = sentiment?.buyPressurePct || 50;

  // Determine current market state
  const currentConditions = {
    trend,
    volatility: classifyVolatility(ohlcv),
    sentiment: sentiment?.sentiment || 'NEUTRAL',
    volumeVsAvg: parseFloat(ohlcv?.volumeVsAvg || 1.0),
    buyPressure,
    whaleRisk: marketSnapshot.onChain?.whaleRisk || onChain?.whaleRisk || 'LOW',
    // Sinyal kuat uptrend: trend UP + SM buying + buy pressure tinggi
    strongUptrend: trend === 'UPTREND' && smBuying === true && buyPressure > 65,
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

  // Override: kalau uptrend SANGAT kuat (SM buying), kurangi score single_side_y
  // karena SOL range akan habis terlalu cepat
  if (conditions.strongUptrend && strategy.type === 'single_side_y') {
    score -= 0.15;
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
