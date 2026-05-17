'use strict';

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeExitReason } from '../utils/exitReasons.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATTERN_LOG_PATH = process.env.BOT_POOL_PATTERN_LEARNING_PATH || join(__dirname, '../../data/pool-pattern-learning.jsonl');
const DATA_DIR = dirname(PATTERN_LOG_PATH);
const MAX_MATCHED_PATTERNS = 5;
const EVENT_CACHE = [];
let CACHE_LOADED = false;

function nowMs() {
  return Date.now();
}

function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bucket(value, ranges = []) {
  const n = safeNum(value, null);
  if (n === null) return 'UNKNOWN';
  for (const [limit, label] of ranges) {
    if (n < limit) return label;
  }
  return ranges[ranges.length - 1]?.[1] || 'UNKNOWN';
}

function normalizeTrend(value) {
  const t = String(value || '').trim().toUpperCase();
  if (t === 'BULLISH' || t === 'BEARISH') return t;
  return 'UNKNOWN';
}

function classifyExitReason(reason = '') {
  const normalized = normalizeExitReason(reason);
  const text = normalized.toUpperCase();
  return {
    wasTakeProfit: text === 'TAKE_PROFIT',
    wasStopLoss: text === 'STOP_LOSS',
    wasOor: text === 'OUT_OF_RANGE',
    wasPoolImpactExit: text === 'POOL_IMPACT_GUARD',
    wasManual: text === 'MANUAL_EXIT' || text === 'MANUAL_STOP',
  };
}

function appendEvent(event = {}) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(PATTERN_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[pool-pattern-learning] append skipped: ${e.message}`);
  }
}

function ensureCacheLoaded() {
  if (CACHE_LOADED) return;
  CACHE_LOADED = true;
  if (!existsSync(PATTERN_LOG_PATH)) return;
  try {
    const raw = readFileSync(PATTERN_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.type === 'OUTCOME') EVENT_CACHE.push(parsed);
      } catch {
        // ignore invalid legacy line
      }
    }
  } catch (e) {
    console.warn(`[pool-pattern-learning] cache load skipped: ${e.message}`);
  }
}

export function extractPoolPatternFeatures({
  pool = {},
  entrySignals = {},
  cfg = {},
  tokenMint = '',
  poolAddress = '',
  symbol = '',
  entryReason = '',
} = {}) {
  const tvl = safeNum(pool.totalTvl ?? pool.activeTvl, null);
  const volume24h = safeNum(
    pool.volume24h ?? pool.volume_24h ?? pool.trade_volume_24h ?? pool.tradeVolume24h ?? pool.volume ?? pool.v24h,
    null
  );
  const ratio = tvl && tvl > 0 && volume24h !== null ? volume24h / tvl : null;
  const feeRatio = safeNum(pool.feeActiveTvlRatio, null);
  const mcap = safeNum(pool.mcap, null);
  const holders = safeNum(pool.holderCount ?? pool.holders, null);
  const rangeWidthBins = safeNum(cfg.deployRangeMaxBins, null);
  const supertrend15m = normalizeTrend(entrySignals.taTrend ?? pool._watchTaTrend ?? pool.taTrend);
  const entryActiveBin = safeNum(pool._entryActiveBin ?? pool.activeBinId ?? entrySignals.activeBinId, null);
  const binStep = safeNum(pool.binStep, null);

  return {
    tokenMint: String(tokenMint || pool.tokenXMint || pool.mint || ''),
    poolAddress: String(poolAddress || pool.address || pool.poolAddress || pool.pool || ''),
    symbol: String(symbol || pool.tokenXSymbol || pool.name || ''),
    binStep,
    tvl,
    volume24h,
    volumeTvlRatio: ratio,
    mcap,
    holderCount: holders,
    supertrend15m,
    feeActiveTvlRatio: feeRatio,
    rangeWidthBins,
    entryActiveBin,
    entryReason: String(entryReason || ''),
    entryAt: nowMs(),
  };
}

export function buildPoolPatternFingerprint(features = {}) {
  const tvlBucket = bucket(features.tvl, [
    [50_000, 'TVL_LT_50K'],
    [250_000, 'TVL_50K_250K'],
    [1_000_000, 'TVL_250K_1M'],
    [Number.POSITIVE_INFINITY, 'TVL_GE_1M'],
  ]);
  const volumeTvlBucket = bucket(features.volumeTvlRatio, [
    [0.5, 'VT_LT_0_5'],
    [2, 'VT_0_5_2'],
    [5, 'VT_2_5'],
    [Number.POSITIVE_INFINITY, 'VT_GE_5'],
  ]);
  const mcapBucket = bucket(features.mcap, [
    [250_000, 'MCAP_LT_250K'],
    [1_000_000, 'MCAP_250K_1M'],
    [10_000_000, 'MCAP_1M_10M'],
    [Number.POSITIVE_INFINITY, 'MCAP_GE_10M'],
  ]);
  const holderBucket = bucket(features.holderCount, [
    [100, 'HOLD_LT_100'],
    [500, 'HOLD_100_500'],
    [2_000, 'HOLD_500_2K'],
    [Number.POSITIVE_INFINITY, 'HOLD_GE_2K'],
  ]);
  const feeTvlBucket = bucket(features.feeActiveTvlRatio, [
    [0.001, 'FEE_TVL_LT_0_1PCT'],
    [0.003, 'FEE_TVL_0_1_0_3PCT'],
    [0.007, 'FEE_TVL_0_3_0_7PCT'],
    [Number.POSITIVE_INFINITY, 'FEE_TVL_GE_0_7PCT'],
  ]);
  const rangeWidthBucket = bucket(features.rangeWidthBins, [
    [24, 'RANGE_LT_24'],
    [48, 'RANGE_24_48'],
    [68, 'RANGE_48_68'],
    [Number.POSITIVE_INFINITY, 'RANGE_GE_68'],
  ]);
  const binStepBucket = Number.isFinite(Number(features.binStep)) ? `BIN_${Number(features.binStep)}` : 'BIN_UNKNOWN';
  const trendBucket = normalizeTrend(features.supertrend15m);

  const fingerprintParts = [
    binStepBucket,
    tvlBucket,
    volumeTvlBucket,
    mcapBucket,
    holderBucket,
    feeTvlBucket,
    trendBucket,
    rangeWidthBucket,
  ];
  return {
    fingerprint: fingerprintParts.join('|'),
    buckets: {
      binStepBucket,
      tvlBucket,
      volumeTvlBucket,
      mcapBucket,
      holderBucket,
      feeTvlBucket,
      trendBucket,
      rangeWidthBucket,
    },
  };
}

export function recordPoolPatternEntry({
  positionPubkey = '',
  features = {},
  cfg = {},
} = {}) {
  if (cfg.poolPatternLearningEnabled !== true) return { recorded: false, reason: 'DISABLED' };
  const { fingerprint, buckets } = buildPoolPatternFingerprint(features);
  const event = {
    type: 'ENTRY',
    at: nowMs(),
    positionPubkey: String(positionPubkey || ''),
    tokenMint: String(features.tokenMint || ''),
    poolAddress: String(features.poolAddress || ''),
    symbol: String(features.symbol || ''),
    fingerprint,
    buckets,
    features,
  };
  appendEvent(event);
  console.log(
    `[PATTERN_LEARNING_ENTRY_SNAPSHOT] ${event.symbol || event.tokenMint || 'UNKNOWN'} ` +
    `fingerprint=${fingerprint} pos=${String(positionPubkey || '').slice(0, 8)}`
  );
  return { recorded: true, event };
}

export function recordPoolPatternOutcome({
  positionPubkey = '',
  features = {},
  outcome = {},
  cfg = {},
} = {}) {
  if (cfg.poolPatternLearningEnabled !== true) return { recorded: false, reason: 'DISABLED' };
  ensureCacheLoaded();
  const { fingerprint, buckets } = buildPoolPatternFingerprint(features);
  const rawReason = String(outcome.rawExitReason || outcome.exitReason || outcome.reason || '');
  const reason = normalizeExitReason(outcome.exitReason || outcome.reason || rawReason);
  const reasonFlags = classifyExitReason(reason);
  const event = {
    type: 'OUTCOME',
    at: nowMs(),
    positionPubkey: String(positionPubkey || ''),
    tokenMint: String(features.tokenMint || ''),
    poolAddress: String(features.poolAddress || ''),
    symbol: String(features.symbol || ''),
    fingerprint,
    buckets,
    features,
    feePnlPct: safeNum(outcome.feePnlPct, 0) || 0,
    feePnlSol: safeNum(outcome.feePnlSol, 0) || 0,
    totalPnlPct: safeNum(outcome.totalPnlPct ?? outcome.pnlPct, 0) || 0,
    pnlSol: safeNum(outcome.pnlSol ?? outcome.pnlTotalSol, 0) || 0,
    holdDurationMs: Math.max(0, safeNum(outcome.holdDurationMs, 0) || 0),
    exitReason: reason,
    rawExitReason: rawReason,
    ...reasonFlags,
  };
  appendEvent(event);
  EVENT_CACHE.push(event);
  console.log(
    `[PATTERN_LEARNING_OUTCOME] ${event.symbol || event.tokenMint || 'UNKNOWN'} ` +
    `fingerprint=${fingerprint} feePnlPct=${event.feePnlPct.toFixed(2)} totalPnlPct=${event.totalPnlPct.toFixed(2)} ` +
    `reason=${event.exitReason || 'UNKNOWN'}`
  );
  return { recorded: true, event };
}

function scoreOutcome(event = {}) {
  const fee = safeNum(event.feePnlPct, 0) || 0;
  const total = safeNum(event.totalPnlPct, 0) || 0;
  let score = 0;

  if (event.wasStopLoss || event.wasOor || event.wasPoolImpactExit) score -= 2.5;
  if (event.wasTakeProfit) score += 1.5;

  if (total >= 2) score += 1.2;
  else if (total > 0) score += 0.6;
  else if (total <= -8) score -= 1.6;
  else if (total < 0) score -= 0.8;

  if (fee > 0) {
    if (total >= 0) score += 0.8;
    else if (total <= -8) score += 0.1;
    else score += 0.35;
  }

  if (event.wasManual && Math.abs(total) < 1) score *= 0.5;
  if (event.wasManual && total <= -4) score -= 0.4;

  return Math.max(-4, Math.min(4, score));
}

function filterByLookback(records = [], lookbackDays = 14, now = nowMs()) {
  const lookbackMs = Math.max(1, Number(lookbackDays) || 14) * 24 * 60 * 60 * 1000;
  const minTs = now - lookbackMs;
  return records.filter((r) => (Number(r.at) || 0) >= minTs);
}

export function applyPoolPatternLearningDelta(baseScore = 0, decision = {}) {
  const safeBase = Number.isFinite(Number(baseScore)) ? Number(baseScore) : 0;
  const delta = Number.isFinite(Number(decision?.appliedDelta)) ? Number(decision.appliedDelta) : 0;
  return safeBase + delta;
}

export function applyPoolPatternLearningToScore({
  baseScore = 0,
  candidate = {},
  config = {},
  now = nowMs(),
} = {}) {
  const safeBaseScore = Number.isFinite(Number(baseScore)) ? Number(baseScore) : 0;
  const pool = candidate?.pool || candidate || {};
  const entrySignals = candidate?.entrySignals || candidate?._entrySignals || {};
  const row = candidate?.row || {};
  const candidateFeatures = candidate?.features && typeof candidate.features === 'object'
    ? candidate.features
    : extractPoolPatternFeatures({
        pool,
        entrySignals,
        cfg: config,
        tokenMint: candidate?.tokenMint || pool?.tokenXMint || pool?.tokenX || pool?.mint || '',
        poolAddress: candidate?.poolAddress || pool?.address || pool?.poolAddress || pool?.pool || '',
        symbol: candidate?.symbol || pool?.tokenXSymbol || pool?.name || '',
        entryReason: candidate?.entryReason || row?.lastReason || '',
      });
  const learningDecision = evaluatePoolPatternLearning(candidateFeatures, config);
  const shadowScore = safeBaseScore + Number(learningDecision.delta || 0);
  const score = learningDecision.enabled && learningDecision.shadowMode === false
    ? applyPoolPatternLearningDelta(safeBaseScore, learningDecision)
    : safeBaseScore;
  const mode = !learningDecision.enabled ? 'disabled' : (learningDecision.shadowMode ? 'shadow' : 'active');

  return {
    score,
    baseScore: safeBaseScore,
    shadowScore,
    learningDecision,
    appliedDelta: Number(learningDecision.appliedDelta || 0),
    mode,
    candidateFeatures,
    now,
  };
}

export function applyPoolPatternLearningToCandidates(candidates = [], config = {}, { now = nowMs() } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rows = list.map((entry, index) => {
    const item = entry && typeof entry === 'object' && 'item' in entry ? entry.item : entry;
    const rawBase = entry && typeof entry === 'object' && 'baseScore' in entry ? entry.baseScore : null;
    const baseScore = Number.isFinite(Number(rawBase)) ? Number(rawBase) : (list.length - index);
    const candidatePayload = entry && typeof entry === 'object' && entry.candidate && typeof entry.candidate === 'object'
      ? entry.candidate
      : item;
    const scored = applyPoolPatternLearningToScore({
      baseScore,
      candidate: candidatePayload,
      config,
      now,
    });
    const symbol = scored.candidateFeatures?.symbol || candidatePayload?.symbol || item?.symbol || '';
    const tokenMint = scored.candidateFeatures?.tokenMint || candidatePayload?.tokenMint || item?.tokenMint || '';
    return {
      index,
      item,
      scored,
      symbol,
      tokenMint,
    };
  });

  const mode = rows[0]?.scored?.mode || 'disabled';
  const shouldReorder = mode === 'active';
  const sorted = shouldReorder
    ? rows.slice().sort((a, b) => {
        if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
        return a.index - b.index;
      })
    : rows;

  const diagnostics = rows.map((row) => ({
    index: row.index,
    symbol: row.symbol,
    tokenMint: row.tokenMint,
    baseScore: row.scored.baseScore,
    score: row.scored.score,
    shadowScore: row.scored.shadowScore,
    appliedDelta: row.scored.appliedDelta,
    delta: Number(row.scored.learningDecision?.delta || 0),
    sampleCount: Number(row.scored.learningDecision?.sampleCount || 0),
    reasons: Array.isArray(row.scored.learningDecision?.reasons) ? row.scored.learningDecision.reasons : [],
    mode: row.scored.mode,
    learningDecision: row.scored.learningDecision,
  }));

  return {
    candidates: sorted.map((row) => row.item),
    diagnostics,
    mode,
  };
}

export function evaluatePoolPatternLearning(candidateFeatures = {}, cfg = {}) {
  const enabled = cfg.poolPatternLearningEnabled === true;
  const shadowMode = cfg.poolPatternLearningShadowMode !== false;
  const minSamples = Math.max(1, Number(cfg.poolPatternLearningMinSamples) || 10);
  const maxScoreDelta = Math.max(0, Number(cfg.poolPatternLearningMaxScoreDelta) || 8);
  const lookbackDays = Math.max(1, Number(cfg.poolPatternLearningLookbackDays) || 14);

  const base = {
    enabled,
    shadowMode,
    delta: 0,
    appliedDelta: 0,
    sampleCount: 0,
    confidence: 0,
    reasons: [],
    matchedPatterns: [],
  };
  if (!enabled) {
    base.reasons.push('LEARNING_DISABLED');
    return base;
  }

  ensureCacheLoaded();
  const { fingerprint } = buildPoolPatternFingerprint(candidateFeatures);
  const recentOutcomes = filterByLookback(EVENT_CACHE, lookbackDays);
  const matched = recentOutcomes.filter((r) => r.fingerprint === fingerprint);
  base.sampleCount = matched.length;

  if (matched.length < minSamples) {
    base.reasons.push(`INSUFFICIENT_SAMPLES_${matched.length}/${minSamples}`);
    base.matchedPatterns = matched.slice(-MAX_MATCHED_PATTERNS).map((r) => ({
      at: r.at,
      totalPnlPct: r.totalPnlPct,
      feePnlPct: r.feePnlPct,
      exitReason: r.exitReason,
    }));
    return base;
  }

  let sum = 0;
  for (const row of matched) sum += scoreOutcome(row);
  const avg = sum / matched.length;
  const confidence = Math.max(0, Math.min(1, matched.length / (minSamples * 2)));
  const delta = avg * 4 * confidence;
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  const appliedDelta = shadowMode ? 0 : Math.max(-maxScoreDelta, Math.min(maxScoreDelta, safeDelta));

  base.delta = safeDelta;
  base.appliedDelta = appliedDelta;
  base.confidence = confidence;
  base.reasons.push(`FINGERPRINT_MATCH_${fingerprint}`);
  base.reasons.push(`AVG_SCORE_${avg.toFixed(2)}`);
  if (shadowMode) base.reasons.push('SHADOW_MODE_ONLY');
  if (!shadowMode) base.reasons.push('ACTIVE_MODE_APPLIED');
  base.matchedPatterns = matched.slice(-MAX_MATCHED_PATTERNS).map((r) => ({
    at: r.at,
    totalPnlPct: r.totalPnlPct,
    feePnlPct: r.feePnlPct,
    exitReason: r.exitReason,
  }));

  return base;
}
