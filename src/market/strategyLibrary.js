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

/**
 * Eval readiness based on technical indicators and market snapshot.
 * Integrated for Technical Sniper upgrade.
 */
export async function evaluateStrategyReadiness({ strategyName, poolAddress, snapshot }) {
  const ta = snapshot?.ta || {};
  const o   = snapshot?.ohlcv || {};
  const vol = snapshot?.ohlcv?.range24hPct || 0;

  if (strategyName === 'Evil Panda') {
    const currentPrice = snapshot.ohlcv?.currentPrice || 0;
    const st = ta.supertrend || { trend: 'NEUTRAL', value: currentPrice };
    
    // ── Hard Guard: Supertrend Entry ──────────────────────────────
    if (st.trend !== 'BULLISH') {
      return {
        ok: false,
        blockers: ['Supertrend is BEARISH/NEUTRAL (15m)'],
        notes: 'Evil Panda memerlukan konfirmasi UPTREND pada Supertrend 15m sebelum entry. Standby.',
      };
    }

    // ── Warp Panda: Contextual Adaptive Discovery ──────────────────
    const rsi = ta.rsi14 || 50;
    const bb = ta.bb || { middle: currentPrice, lower: currentPrice, upper: currentPrice };

    // --- Intelligence Matrix: SNIPER vs DEEP JARING ---
    const bbWidePct = ((bb.upper - bb.lower) / currentPrice) * 100;
    const distFromSupportPct = ((st.value - currentPrice) / currentPrice) * 100;

    // Detect Capitulation (Panic Selling)
    const isCapitulation = rsi < 30 || distFromSupportPct > 15;
    
    // Multiplier scaling: Sniper (1.2x) to Deep Jaring (3.0x)
    let rangeMultiplier = isCapitulation ? 3.0 : (bbWidePct < 2.5 ? 1.2 : (bbWidePct < 5.0 ? 1.5 : 2.0));
    
    // Hard scale range width based on Volatility + Capitulation
    // Goal: Sniper (10-30%) vs Deep Jaring (60-90%)
    let targetRangePct = Math.max(8.0, bbWidePct * rangeMultiplier);
    if (isCapitulation) {
      targetRangePct = Math.max(60.0, targetRangePct); // Floor 60% if crashing
    }
    targetRangePct = Math.min(95.0, targetRangePct); // Hard cap 95%

    // --- Technical Anchoring ---
    // If momentum: Anchor to Supertrend. If crash: Anchor even deeper.
    const technicalFloor = isCapitulation ? (currentPrice * (1 - (targetRangePct / 100))) : Math.max(st.value, bb.lower);
    
    const offsetMin = isCapitulation ? (targetRangePct * 0.8) : 0; // Much deeper jaring for crashes
    const offsetMax = Math.max(targetRangePct, ((currentPrice - technicalFloor) / currentPrice) * 100);
    
    // 5. Calculate Dynamic Headroom (Padding)
    // We want enough bins above price to survive 2.5x ATR of movement
    const binStepPct = (snapshot?.pool?.binStep || 100) / 10000;
    const paddingBins = Math.max(5, Math.ceil(((ta.atr * 2.5) / currentPrice) / binStepPct));
    
    // 6. Suggested Slippage
    const suggestedSlippage = vol > 50 ? 2.5 : 1.0;

    const modeText = isCapitulation ? 'DEEP_JARING' : 'SNIPER_MODE';
    const technicalReasoning = isCapitulation
      ? `🚨 ${modeText}: Capitulation detected (RSI ${rsi.toFixed(0)}), deploying WIDE range ${targetRangePct.toFixed(1)}% to catch bottom.`
      : `🎯 ${modeText}: Momentum active, range ${targetRangePct.toFixed(1)}% anchored to technical floor.`;

    return {
      ok: true,
      blockers: [],
      notes: technicalReasoning,
      deployOptions: {
        priceRangePct: targetRangePct,
        entryPriceOffsetMin: offsetMin,
        entryPriceOffsetMax: offsetMax,
        binPadding: paddingBins,
        slippagePct: suggestedSlippage,
        technicalReasoning
      }
    };
  }

  // Fallback for other strategies
  return { ok: true, blockers: [], notes: 'Ready to deploy.' };
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
