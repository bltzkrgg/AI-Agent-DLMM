'use strict';

import { getConfig } from '../config.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { checkSupertrendVeto, isSupportedQuoteToken, getQuoteTokenLabel } from '../market/meridianVeto.js';
import { getPoolMemorySignal, recordPoolDeploy } from '../market/poolMemory.js';
import { getRuntimeState } from '../runtime/state.js';
import { reserveDeploySlot, releaseDeploySlot } from './deploySlotGuard.js';
import { evaluateEntryCandleSanity } from './entryCandleSanity.js';

/**
 * src/utils/pendingDeployQueue.js
 * Real-time Deploy Queue — token yang lolos Scout Agent masuk sini,
 * watcher memeriksa setiap 30-60 detik, jika kondisi pasar terpenuhi
 * maka eksekusi deployPosition() langsung tanpa menunggu siklus 15 menit.
 */

let _notifyFn  = null;
let _deployFn  = null;
let _monitorFn = null;
let _watcherTimer = null;
const _queue   = new Map(); // mint -> entry
const _snapshotCache = new Map(); // key -> { at, snapshot }
const _snapshotInflight = new Map(); // key -> Promise
const _holdNotifyDedup = new Map(); // key(candidate|reason) -> lastSentAtMs
const _holdNotifyKeysByCandidate = new Map(); // candidate -> Set(keys)
const SNAPSHOT_CACHE_TTL_MS = 12_000;
const FINAL_ST_CACHE_TTL_MS = 15_000;
const OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused';
let _snapshotCacheHits = 0;
let _snapshotCacheMisses = 0;

function formatPct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : 'UNKNOWN';
}

function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildDeployTriggeredTelegramMessage({
  symbol = '',
  poolAddress = '',
  check = {},
  decision = 'DEPLOY',
  entry = {},
  solAmount = 0,
  cfg = getConfig(),
  finalCandle = null,
} = {}) {
  const lpSimpleM15Mode = String(cfg.entryDecisionMode || 'strict').trim().toLowerCase() === 'lp_simple_m15';
  const finalCandleDiagnostics = finalCandle?.diagnostics || finalCandle || null;
  const hasM15Signal =
    finalCandleDiagnostics &&
    Number.isFinite(finalCandleDiagnostics?.m15Open) &&
    Number.isFinite(finalCandleDiagnostics?.m15Close);
  let m15Signal = 'unavailable';
  if (hasM15Signal) {
    m15Signal = finalCandleDiagnostics?.m15Green === false ? 'RED' : 'GREEN';
  }
  const m15Line = lpSimpleM15Mode
    ? `M15: <code>${m15Signal}</code> | ` +
      `VolRatio: <code>${Number.isFinite(finalCandleDiagnostics?.m15VolumeRatio) ? `${Number(finalCandleDiagnostics.m15VolumeRatio).toFixed(2)}x` : 'na'}</code> | ` +
      `Age: <code>${Number.isFinite(finalCandleDiagnostics?.m15AgeSec) ? `${Math.round(finalCandleDiagnostics.m15AgeSec)}s` : 'na'}</code> | ` +
      `Source: <code>${escapeHTML(finalCandleDiagnostics?.source || finalCandle?.source || 'unknown')}</code>\n`
    : '';
  const m5Line = lpSimpleM15Mode
    ? `M5: <code>${formatPct(check.liveM5)}</code> (<code>${check.m5Source || 'unknown'}</code>) <i>diagnostic/live</i>\n`
    : `M5: <code>${formatPct(check.liveM5)}</code> (<code>${check.m5Source || 'unknown'}</code>)\n`;

  return (
    `🚀 <b>Real-time Deploy Triggered!</b>\n` +
    `Token: <b>${symbol}</b>\n` +
    `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
    `Trend: <code>${check.liveTrend || 'UNKNOWN'}</code> (<code>${check.trendSource || 'unknown'}</code>)\n` +
    m15Line +
    m5Line +
    `Decision: <code>${decision}</code>\n` +
    `BinStep: <code>${entry?.pool?.binStep || entry?.binStep || '?'}</code>\n` +
    `Entry: <code>${entry?.meta?.entryReadiness || 'N/A'}</code> | ` +
    `Breakout: <code>${entry?.meta?.breakoutQuality || 'N/A'}</code> | ` +
    `Timing: <code>${entry?.meta?.entryTimingState || 'N/A'}</code>\n` +
    `⏳ <i>Membuka posisi ${solAmount} SOL...</i>`
  );
}

export function setDeployQueueNotifyFn(fn) { _notifyFn  = fn; }
export function setDeployQueueDeployFn(fn) { _deployFn  = fn; }
export function setDeployQueueMonitorFn(fn) { _monitorFn = fn; }

function isOperatorDiscoveryPaused() {
  const state = getRuntimeState(OPERATOR_DISCOVERY_PAUSED_KEY, null);
  return state === true || state?.paused === true;
}

async function safeSend(msg) {
  if (_notifyFn) {
    try { await _notifyFn(msg); } catch (e) { console.error('[QUEUE] notify error:', e.message); }
  }
}

function getSnapshotCacheKey(mint = '', poolAddress = '', options = {}) {
  const entry5mSuffix = options?.includeEntryCandles5m === true ? ':entry5m' : '';
  return `${mint || 'unknown'}:${poolAddress || 'nopool'}${entry5mSuffix}`;
}

function normalizeHoldReason(reason = '') {
  const clean = String(reason || '')
    .replace(/\(attempt\s+\d+\/\d+\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'HOLD_UNKNOWN';
}

function getHoldNotifyCandidateKey({ poolAddress = '', mint = '' } = {}) {
  const pool = String(poolAddress || '').trim();
  const tokenMint = String(mint || '').trim();
  return pool || tokenMint || 'unknown';
}

function deleteHoldNotifyKey(key = '') {
  if (!key) return;
  _holdNotifyDedup.delete(key);
  const delimiter = key.indexOf('|');
  if (delimiter <= 0) return;
  const candidate = key.slice(0, delimiter);
  const known = _holdNotifyKeysByCandidate.get(candidate);
  if (!known) return;
  known.delete(key);
  if (known.size === 0) {
    _holdNotifyKeysByCandidate.delete(candidate);
  }
}

function pruneHoldNotifyState({
  now = Date.now(),
  staleAfterMs = 1_800_000,
} = {}) {
  for (const [key, lastAt] of _holdNotifyDedup.entries()) {
    if (!Number.isFinite(lastAt) || (now - lastAt) > staleAfterMs) {
      deleteHoldNotifyKey(key);
    }
  }
}

function clearDeployQueueHoldNotifyState({
  poolAddress = '',
  mint = '',
} = {}) {
  const candidates = [String(poolAddress || '').trim(), String(mint || '').trim()].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    const keys = _holdNotifyKeysByCandidate.get(candidate);
    if (!keys) continue;
    for (const key of keys) {
      _holdNotifyDedup.delete(key);
    }
    _holdNotifyKeysByCandidate.delete(candidate);
  }
}

function getPoolAddress(pool = {}) {
  return pool.address || pool.pool_address || pool.pool || pool.poolAddress || pool.pubkey || '';
}

function removeQueueCandidate(mint = '', entry = null) {
  _queue.delete(mint);
  clearDeployQueueHoldNotifyState({
    poolAddress: getPoolAddress(entry?.pool || {}),
    mint,
  });
}

export function shouldSendDeployQueueHoldNotification({
  poolAddress = '',
  mint = '',
  reason = '',
  now = Date.now(),
  cooldownMs = 180_000,
} = {}) {
  const candidateKey = getHoldNotifyCandidateKey({ poolAddress, mint });
  const normalizedReason = normalizeHoldReason(reason);
  const reasonKey = normalizedReason.toLowerCase();
  const key = `${candidateKey}|${reasonKey}`;
  const effectiveCooldownMs = Math.max(0, Number(cooldownMs) || 0);
  pruneHoldNotifyState({
    now,
    staleAfterMs: Math.max(300_000, effectiveCooldownMs * 4, 1_800_000),
  });

  const lastSentAt = _holdNotifyDedup.get(key);
  if (Number.isFinite(lastSentAt) && effectiveCooldownMs > 0 && (now - lastSentAt) < effectiveCooldownMs) {
    return { shouldSend: false, key, candidateKey, normalizedReason };
  }

  _holdNotifyDedup.set(key, now);
  const knownKeys = _holdNotifyKeysByCandidate.get(candidateKey) || new Set();
  knownKeys.add(key);
  _holdNotifyKeysByCandidate.set(candidateKey, knownKeys);
  return { shouldSend: true, key, candidateKey, normalizedReason };
}

export function __resetDeployQueueHoldNotifyState() {
  _holdNotifyDedup.clear();
  _holdNotifyKeysByCandidate.clear();
}

export function getLiveSnapshotReliability(snapshot = null) {
  if (!snapshot) return { reliable: false, reason: 'SNAPSHOT_NULL' };
  const source = String(snapshot.dataSource || snapshot.ohlcv?.source || '').toLowerCase();
  const historySuccess = snapshot.ohlcv?.historySuccess === true;
  const fallbackReliable = snapshot?.ohlcv?.fallbackReliable === true ||
    snapshot?.quality?.fallbackReliable === true ||
    snapshot?.fallbackReliable === true;
  const isMeridianFallback = source.includes('meridian-fallback') || source.includes('meridian');

  if (fallbackReliable && isMeridianFallback) {
    return { reliable: true, reason: 'MERIDIAN_FALLBACK_RELIABLE' };
  }
  if (source.includes('momentum-proxy')) {
    return { reliable: false, reason: 'MOMENTUM_PROXY_ONLY' };
  }
  if (!historySuccess) {
    return { reliable: false, reason: 'OHLCV_HISTORY_UNAVAILABLE' };
  }
  return { reliable: true, reason: fallbackReliable ? 'FALLBACK_RELIABLE' : 'OHLCV_HISTORY_OK' };
}

export function isReliableLiveSnapshot(snapshot = null) {
  return getLiveSnapshotReliability(snapshot).reliable;
}

export function buildUnreliableLiveSnapshotLog({
  symbol = '',
  mint = '',
  poolAddress = '',
  snapshot = null,
  poolAddressPassed = false,
} = {}) {
  const reliability = getLiveSnapshotReliability(snapshot);
  const issues = Array.isArray(snapshot?.quality?.issues)
    ? snapshot.quality.issues.slice(0, 3).join('|')
    : '';
  const fallbackReliable = snapshot?.ohlcv?.fallbackReliable === true ||
    snapshot?.quality?.fallbackReliable === true ||
    snapshot?.fallbackReliable === true;
  const candlesLen = Array.isArray(snapshot?.ohlcv?.candles)
    ? snapshot.ohlcv.candles.length
    : (Number(snapshot?.ohlcv?.ta?.candleCount) || 0);
  return (
    `[QUEUE] 🧊 Ignored unreliable live snapshot ${symbol || mint?.slice(0, 8) || 'UNKNOWN'} ` +
    `mint=${mint || 'unknown'} pool=${poolAddress || 'unknown'} ` +
    `source=${String(snapshot?.dataSource || 'unknown')} ` +
    `ohlcvSource=${String(snapshot?.ohlcv?.source || 'unknown')} ` +
    `historySuccess=${snapshot?.ohlcv?.historySuccess === true ? 'true' : 'false'} ` +
    `fallbackReliable=${fallbackReliable ? 'true' : 'false'} ` +
    `candles=${candlesLen} taSource=${String(snapshot?.quality?.taSource || 'unknown')} ` +
    `issues=[${issues || 'none'}] m5=${formatPct(snapshot?.ohlcv?.priceChangeM5)} ` +
    `poolAddressPassed=${poolAddressPassed ? 'yes' : 'no'} reason=${reliability.reason}`
  );
}

function logUnreliableLiveSnapshot({
  symbol = '',
  mint = '',
  poolAddress = '',
  snapshot = null,
  poolAddressPassed = false,
} = {}) {
  console.log(buildUnreliableLiveSnapshotLog({
    symbol,
    mint,
    poolAddress,
    snapshot,
    poolAddressPassed,
  }));
}

async function getCachedMarketSnapshot(mint, poolAddress = null, symbol = '', options = {}) {
  if (!mint) return null;
  const includeEntryCandles5m = options?.includeEntryCandles5m === true;
  const key = getSnapshotCacheKey(mint, poolAddress || '', { includeEntryCandles5m });
  const now = Date.now();
  const cached = _snapshotCache.get(key);
  if (cached && (now - cached.at) <= SNAPSHOT_CACHE_TTL_MS) {
    _snapshotCacheHits += 1;
    console.log(
      `[QUEUE] 🧠 Snapshot cache hit ${symbol || mint.slice(0, 8)} ` +
      `pool=${(poolAddress || '').slice(0, 8) || 'none'} ` +
      `entry5m=${includeEntryCandles5m ? 'yes' : 'no'} ` +
      `hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`
    );
    return cached.snapshot;
  }

  if (_snapshotInflight.has(key)) {
    _snapshotCacheHits += 1;
    console.log(
      `[QUEUE] 🧠 Snapshot inflight reuse ${symbol || mint.slice(0, 8)} ` +
      `pool=${(poolAddress || '').slice(0, 8) || 'none'} ` +
      `entry5m=${includeEntryCandles5m ? 'yes' : 'no'} ` +
      `hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`
    );
    return _snapshotInflight.get(key);
  }

  _snapshotCacheMisses += 1;
  console.log(
    `[QUEUE] 🧠 Snapshot cache miss ${symbol || mint.slice(0, 8)} ` +
    `pool=${(poolAddress || '').slice(0, 8) || 'none'} poolAddressPassed=${poolAddress ? 'yes' : 'no'} ` +
    `entry5m=${includeEntryCandles5m ? 'yes' : 'no'} ` +
    `hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`
  );
  const task = getMarketSnapshot(mint, poolAddress || null, {
    from: includeEntryCandles5m ? 'entry_candle_sanity' : 'deploy_queue',
    includeEntryCandles5m,
  })
    .catch(() => null)
    .then((snapshot) => {
      _snapshotCache.set(key, { at: Date.now(), snapshot });
      _snapshotInflight.delete(key);
      return snapshot;
    });
  _snapshotInflight.set(key, task);
  return task;
}

export function getSnapshotCacheStats() {
  return {
    hits: _snapshotCacheHits,
    misses: _snapshotCacheMisses,
    size: _snapshotCache.size,
  };
}

function resolveQueueSignalSources({ meta = {}, liveSnapshot = null } = {}) {
  const metaTrendRaw = String(meta.taTrend || meta.liveTrend || '').toUpperCase();
  const metaM5Raw = Number(meta.priceChangeM5 ?? meta.snapshotM5Change ?? 0);
  const liveTrendRaw = String(
    liveSnapshot?.quality?.taTrend ||
    liveSnapshot?.ta?.supertrend?.trend ||
    'UNKNOWN'
  ).toUpperCase();
  const liveM5Raw = Number(liveSnapshot?.ohlcv?.priceChangeM5 ?? 0);
  const liveSource = String(liveSnapshot?.ohlcv?.source || liveSnapshot?.dataSource || '').toLowerCase();
  const liveEntry5mHistory = liveSnapshot?.ohlcv?.entry5mHistorySuccess === true;
  const liveHistorySuccess = liveSnapshot?.ohlcv?.historySuccess === true;
  const liveTrendKnown = ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(liveTrendRaw);
  const liveM5Known = Number.isFinite(liveM5Raw) && (
    liveEntry5mHistory ||
    liveHistorySuccess ||
    liveSource.includes('meteora-dlmm-ohlcv')
  );

  return {
    trend: liveTrendKnown ? liveTrendRaw : (metaTrendRaw || 'UNKNOWN'),
    trendSource: liveTrendKnown ? 'live' : (metaTrendRaw ? 'queue' : 'unknown'),
    m5: liveM5Known ? liveM5Raw : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? metaM5Raw : 0),
    m5Source: liveM5Known ? 'live' : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? 'queue' : 'unknown'),
    liveTrendRaw,
    liveM5Raw,
    metaTrendRaw,
    metaM5Raw,
  };
}

function isTrustedLpWatchMeta(meta = {}) {
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  return meta.queueTrustedWatch === true &&
    timingState === 'LP_LIVE' &&
    readiness === 'HIGH' &&
    (breakoutQuality === 'VALID' || breakoutQuality === 'STRONG');
}

function normalizeSupertrendDirection(value = '') {
  const trend = String(value || '').toUpperCase();
  if (trend === 'BULLISH' || trend === 'BEARISH') return trend;
  return 'UNKNOWN';
}

function normalizeLiveTrend(value = '') {
  const trend = String(value || '').toUpperCase();
  if (trend === 'BULLISH' || trend === 'BEARISH' || trend === 'NEUTRAL') return trend;
  return 'UNKNOWN';
}

function readLiveSnapshotTrend(liveSnapshot = null) {
  return normalizeLiveTrend(
    liveSnapshot?.quality?.taTrend ||
    liveSnapshot?.ta?.supertrend?.trend ||
    'UNKNOWN'
  );
}

function clearBullishSupertrendCache(meta = {}, pool = {}) {
  const clearIfBullish = (obj, dirKey, atKey) => {
    if (!obj || typeof obj !== 'object') return;
    const dir = String(obj?.[dirKey] || '').toUpperCase();
    if (dir === 'BULLISH') {
      delete obj[dirKey];
      delete obj[atKey];
    }
  };

  clearIfBullish(meta, 'finalSupertrend15m', 'finalSupertrend15mAt');
  clearIfBullish(meta, 'supertrend15m', 'supertrend15mAt');
  clearIfBullish(pool, '_finalSupertrend15m', '_finalSupertrend15mAt');
  clearIfBullish(pool, '_supertrend15m', '_supertrend15mAt');
}

function readCachedSupertrend15m(meta = {}, pool = {}) {
  const direction = normalizeSupertrendDirection(
    meta.finalSupertrend15m ||
    meta.supertrend15m ||
    pool?._finalSupertrend15m ||
    pool?._supertrend15m
  );
  const at = Number(
    meta.finalSupertrend15mAt ||
    meta.supertrend15mAt ||
    pool?._finalSupertrend15mAt ||
    pool?._supertrend15mAt ||
    0
  );
  return { direction, at };
}

export function isFreshBullishSupertrend15m(meta = {}, pool = {}, now = Date.now(), ttlMs = FINAL_ST_CACHE_TTL_MS) {
  const cached = readCachedSupertrend15m(meta, pool);
  return cached.direction === 'BULLISH' && cached.at > 0 && (now - cached.at) <= ttlMs;
}

export async function getFinalSupertrendDeployDecision({
  mint = '',
  symbol = '',
  pool = {},
  meta = {},
  liveSnapshot = null,
  currentPrice = 0,
  now = Date.now(),
  ttlMs = FINAL_ST_CACHE_TTL_MS,
  checkFn = checkSupertrendVeto,
} = {}) {
  const label = symbol || mint?.slice?.(0, 8) || 'UNKNOWN';
  const liveTrend = readLiveSnapshotTrend(liveSnapshot);
  const liveReliable = isReliableLiveSnapshot(liveSnapshot);
  if (liveReliable && liveTrend === 'BEARISH') {
    clearBullishSupertrendCache(meta, pool);
    return {
      ok: false,
      action: 'VETO',
      reason: 'live Supertrend 15m bearish from reliable snapshot',
      source: 'live_snapshot',
      direction: 'BEARISH',
    };
  }
  if (liveReliable && liveTrend === 'BULLISH') {
    return {
      ok: true,
      action: 'ALLOW',
      reason: 'live Supertrend 15m bullish from reliable snapshot',
      source: 'live_snapshot',
      direction: 'BULLISH',
    };
  }

  const cached = readCachedSupertrend15m(meta, pool);
  const fresh = cached.at > 0 && (now - cached.at) <= ttlMs;

  if (fresh) {
    if (cached.direction === 'BULLISH') {
      return { ok: true, action: 'ALLOW', reason: 'fresh cached Supertrend 15m bullish', source: 'cache', direction: 'BULLISH' };
    }
    if (cached.direction === 'BEARISH') {
      return { ok: false, action: 'VETO', reason: 'fresh cached Supertrend 15m bearish', source: 'cache', direction: 'BEARISH' };
    }
  }

  if (!mint) {
    return { ok: false, action: 'HOLD', reason: 'missing mint for final Supertrend 15m check', source: 'unknown', direction: cached.direction || 'UNKNOWN' };
  }

  try {
    const result = await checkFn(mint, currentPrice);
    const direction = normalizeSupertrendDirection(result?.direction);
    if (!result?.veto && direction === 'BULLISH') {
      return { ok: true, action: 'ALLOW', reason: result.reason || 'fresh Supertrend 15m bullish', source: 'fresh_fetch', direction: 'BULLISH' };
    }
    if (direction === 'BEARISH' || String(result?.reason || '').toUpperCase().includes('BEARISH')) {
      clearBullishSupertrendCache(meta, pool);
      return { ok: false, action: 'VETO', reason: result?.reason || 'fresh Supertrend 15m bearish', source: 'fresh_fetch', direction: 'BEARISH' };
    }
    return { ok: false, action: 'HOLD', reason: result?.reason || 'Supertrend 15m unavailable', source: 'fresh_fetch', direction: direction || 'UNKNOWN' };
  } catch (e) {
    return { ok: false, action: 'HOLD', reason: e?.message || `Supertrend 15m check failed for ${label}`, source: 'unknown', direction: 'UNKNOWN' };
  }
}

export async function ensureFinalSupertrendBullish(args = {}) {
  const decision = await getFinalSupertrendDeployDecision(args);
  const label = args.symbol || args.mint?.slice?.(0, 8) || 'UNKNOWN';
  const mintShort = args.mint?.slice?.(0, 8) || 'UNKNOWN';
  if (decision.action === 'ALLOW') {
    console.log(`[QUEUE] FINAL_ST_GATE_PASS ${label}/${mintShort} source=${decision.source} reason=${decision.reason}`);
  } else if (decision.action === 'VETO') {
    console.log(`[QUEUE] FINAL_ST_GATE_VETO ${label}/${mintShort} source=${decision.source} direction=${decision.direction} reason=${decision.reason}`);
  } else if (decision.source === 'fresh_fetch' || decision.source === 'unknown') {
    console.log(`[QUEUE] FINAL_ST_GATE_HOLD_ERROR ${label}/${mintShort} source=${decision.source} reason=${decision.reason}`);
  } else {
    console.log(`[QUEUE] FINAL_ST_GATE_HOLD_STALE ${label}/${mintShort} source=${decision.source} reason=${decision.reason}`);
  }
  return decision;
}

function getCachedEntrySanitySnapshot({ pool = {}, meta = {}, liveSnapshot = null } = {}) {
  return liveSnapshot ||
    pool?._marketSnapshot ||
    meta?.marketSnapshot ||
    pool?._entryMarketSnapshot ||
    pool?._watchMarketSnapshot ||
    null;
}

export async function getFinalEntryCandleSanityDecision({
  mint = '',
  symbol = '',
  pool = {},
  meta = {},
  liveSnapshot = null,
  now = Date.now(),
  snapshotFn = getCachedMarketSnapshot,
  cfg = getConfig(),
} = {}) {
  if (cfg.entryCandleSanityEnabled === false) {
    return { ok: true, action: 'ALLOW', reason: 'entry candle sanity disabled', source: 'disabled' };
  }

  const label = symbol || mint?.slice?.(0, 8) || 'UNKNOWN';
  const poolAddress = pool.address || pool.pool_address || pool.pool || pool.poolAddress || pool.pubkey || '';
  const cachedSnapshot = getCachedEntrySanitySnapshot({ pool, meta, liveSnapshot });
  let decision = evaluateEntryCandleSanity({ snapshot: cachedSnapshot, cfg, now });
  if (decision.ok) {
    return { ...decision, source: decision.source || 'cache' };
  }

  if (
    decision.code !== 'UNAVAILABLE' &&
    decision.code !== 'STALE' &&
    decision.code !== 'VOLUME_LOOKBACK_UNAVAILABLE' &&
    decision.code !== 'M15_UNAVAILABLE' &&
    decision.code !== 'M15_STALE' &&
    decision.code !== 'M15_VOLUME_LOOKBACK_UNAVAILABLE'
  ) {
    return decision;
  }

  if (!mint || typeof snapshotFn !== 'function') {
    return decision;
  }

  const freshSnapshot = snapshotFn === getCachedMarketSnapshot
    ? await getCachedMarketSnapshot(mint, poolAddress || null, label, { includeEntryCandles5m: true })
    : await snapshotFn(mint, poolAddress || null, label);
  if (freshSnapshot && pool && typeof pool === 'object') {
    pool._marketSnapshot = freshSnapshot;
  }
  decision = evaluateEntryCandleSanity({ snapshot: freshSnapshot, cfg, now: Date.now() });
  return {
    ...decision,
    source: decision.ok ? 'fresh_fetch' : (decision.source || 'fresh_fetch'),
  };
}

export async function ensureFinalEntryCandleSanity(args = {}) {
  const decision = await getFinalEntryCandleSanityDecision(args);
  const label = args.symbol || args.mint?.slice?.(0, 8) || 'UNKNOWN';
  const mintShort = args.mint?.slice?.(0, 8) || 'UNKNOWN';
  const cfg = args.cfg && typeof args.cfg === 'object' ? args.cfg : getConfig();
  const mode = String(cfg.entryDecisionMode || 'strict').toLowerCase();
  if (decision.action === 'ALLOW') {
    console.log(`[QUEUE] FINAL_CANDLE_GATE_PASS ${label}/${mintShort} source=${decision.source || 'cache'} reason=${decision.reason}`);
  } else {
    if (mode === 'lp_simple_m15') {
      const diag = decision.diagnostics || {};
      console.log(
        `[QUEUE] FINAL_CANDLE_GATE_HOLD ${label}/${mintShort} ` +
        `mode=${mode} source=${decision.source || diag.source || 'unknown'} reason="${decision.reason}" ` +
        `raw5m=${Number(diag.raw5mCount ?? 0)} closed5m=${Number(diag.closed5mCount ?? 0)} m15=${Number(diag.derivedM15Count ?? 0)} ` +
        `lastM15Ts=${Number.isFinite(diag.lastM15Timestamp) ? Number(diag.lastM15Timestamp) : 'null'} ` +
        `ageSec=${Number.isFinite(diag.m15AgeSec) ? Number(diag.m15AgeSec).toFixed(1) : 'na'} ` +
        `maxAgeSec=${Number(diag.entryM15MaxAgeSec ?? cfg.entryM15MaxAgeSec ?? 1800)} ` +
        `droppedOpen=${Number(diag.droppedOpenCandleCount ?? 0)} ` +
        `m15Open=${Number.isFinite(diag.m15Open) ? Number(diag.m15Open).toFixed(8) : 'na'} ` +
        `m15Close=${Number.isFinite(diag.m15Close) ? Number(diag.m15Close).toFixed(8) : 'na'} ` +
        `m15Pct=${Number.isFinite(diag.m15Pct) ? `${Number(diag.m15Pct).toFixed(2)}%` : 'na'} ` +
        `m15Vol=${Number.isFinite(diag.m15Volume) ? Number(diag.m15Volume).toFixed(4) : 'na'} ` +
        `m15AvgVol=${Number.isFinite(diag.m15AvgVolume) ? Number(diag.m15AvgVolume).toFixed(4) : 'na'} ` +
        `m15VolRatio=${Number.isFinite(diag.m15VolumeRatio) ? Number(diag.m15VolumeRatio).toFixed(3) : 'na'} ` +
        `m15MinRatio=${Number(diag.entryM15MinVolumeRatio ?? cfg.entryM15MinVolumeRatio ?? 0.7).toFixed(3)}`
      );
    } else {
      const ageSec = Number.isFinite(decision.ageSec) ? Number(decision.ageSec).toFixed(1) : 'na';
      const lastVolume = Number.isFinite(decision.volume) ? Number(decision.volume).toFixed(4) : 'na';
      const avgVolume = Number.isFinite(decision.avgVolume) ? Number(decision.avgVolume).toFixed(4) : 'na';
      const volumeRatio = (Number.isFinite(decision.volume) && Number.isFinite(decision.avgVolume) && decision.avgVolume > 0)
        ? (Number(decision.volume) / Number(decision.avgVolume)).toFixed(3)
        : 'na';
      console.log(
        `[QUEUE] FINAL_CANDLE_GATE_HOLD ${label}/${mintShort} ` +
        `source=${decision.source || 'unknown'} reason=${decision.reason} ` +
        `cfg[maxAgeSec=${Number(cfg.entryCandleMaxAgeSec ?? 420)},minRatio=${Number(cfg.entryMinVolumeRatio ?? 1.5)},lookback=${Number(cfg.entryVolumeLookbackCandles ?? 12)},green=${cfg.entryRequireGreenCandle !== false},volConfirm=${cfg.entryRequireVolumeConfirm !== false}] ` +
        `obs[ageSec=${ageSec},lastVol=${lastVolume},avgVol=${avgVolume},volRatio=${volumeRatio}]`
      );
    }
  }
  return decision;
}

export function summarizeQueueDecision({ meta = {}, liveSnapshot = null, cfg = getConfig(), lpMode = false } = {}) {
  const signals = resolveQueueSignalSources({ meta, liveSnapshot });
  const decisionMode = String(cfg?.entryDecisionMode || 'strict').trim().toLowerCase();
  const lpSimpleM15Mode = decisionMode === 'lp_simple_m15';
  const m5HardGateEnabled = cfg?.entryM5HardGateEnabled !== false;
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const trustedLpWatch = isTrustedLpWatchMeta(meta);
  const hasFreshBullishFinalStCache = isFreshBullishSupertrend15m(meta, {}, Date.now(), FINAL_ST_CACHE_TTL_MS);
  const trendUnknown = signals.trend === 'UNKNOWN';
  const trendBearish = signals.trend === 'BEARISH';
  const trendFresh = signals.trendSource === 'live';
  const m5Finite = Number.isFinite(signals.m5);
  const m5Unknown = !m5Finite || signals.m5Source === 'unknown';
  const m5FreshPositive = signals.m5Source === 'live' && m5Finite && signals.m5 > 0;
  const bothUnknown = signals.trendSource === 'unknown' && signals.m5Source === 'unknown';

  let decision = 'DEPLOY';
  let reason = '';
  const liveTrend = readLiveSnapshotTrend(liveSnapshot);
  const liveReliable = isReliableLiveSnapshot(liveSnapshot);

  if (lpMode) {
    if ((liveReliable && liveTrend === 'BEARISH') || trendBearish) {
      decision = 'DROP';
      reason = liveReliable && liveTrend === 'BEARISH'
        ? 'Supertrend 15m bearish (live_snapshot)'
        : `Supertrend 15m bearish (${signals.trendSource})`;
    } else if (bothUnknown) {
      decision = 'HOLD';
      reason = 'HOLD: realtime trend/M5 unknown; waiting for fresh deploy signal';
    } else if (!lpSimpleM15Mode && m5Unknown) {
      decision = 'HOLD';
      reason = `HOLD: realtime M5 unknown/stale (${signals.m5Source}); waiting fresh signal`;
    } else if ((!lpSimpleM15Mode || m5HardGateEnabled) && !m5FreshPositive) {
      decision = 'HOLD';
      reason = `HOLD: realtime M5 non-positive (${formatPct(signals.m5)}); waiting positive momentum`;
    } else if (trendUnknown && !hasFreshBullishFinalStCache) {
      decision = 'HOLD';
      reason = 'HOLD: realtime trend unknown; waiting fresh trend or final ST 15m bullish cache';
    } else if (!trendFresh && !(trendUnknown && hasFreshBullishFinalStCache)) {
      decision = 'HOLD';
      reason = `HOLD: realtime trend stale (${signals.trendSource}); waiting fresh live trend`;
    } else if (signals.trend !== 'BULLISH' && !(trendUnknown && hasFreshBullishFinalStCache)) {
      decision = 'HOLD';
      reason = `Freshness hilang: trend=${signals.trend || 'UNKNOWN'} (${signals.trendSource}) m5=${formatPct(signals.m5)} (${signals.m5Source})`;
    } else if (trustedLpWatch) {
      reason = `Trusted WATCH prepared (${signals.trendSource}/${signals.m5Source})`;
    }
  } else if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') {
    decision = 'HOLD';
    reason = `Timing belum fresh: ${timingState || 'UNKNOWN'}`;
  }

  return {
    ...signals,
    lpMode,
    entryDecisionMode: decisionMode,
    m5HardGateEnabled,
    timingState,
    decision,
    reason,
    queueExpiryMin: Math.max(
      lpMode ? 1 : 5,
      Math.max(1, Number(cfg.deployQueueExpiryMin) || (lpMode ? 60 : 5))
    ),
  };
}

export function isFreshDeployMeta(meta = {}) {
  const cfg = getConfig();
  const lpMode = String(meta.entryGateMode || cfg.entryGateMode || '').toLowerCase().includes('lp');
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  const taTrend = String(meta.taTrend || meta.liveTrend || '').toUpperCase();
  const signalAthDistancePct = Number(meta.signalAthDistancePct);
  const signalStDistancePct = Number(meta.signalStDistancePct);
  const trustedLpWatch = isTrustedLpWatchMeta(meta);

  if (meta.isRetest || meta.isScoutDefer) return false;
  if (lpMode) {
    if (timingState !== 'LP_LIVE' && timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') return false;
    if (taTrend === 'BEARISH') return false;
    if (!trustedLpWatch && taTrend !== 'BULLISH') return false;
  } else if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') {
    return false;
  }
  if (readiness !== 'HIGH') return false;
  if (breakoutQuality !== 'VALID' && breakoutQuality !== 'STRONG') return false;
  if (taTrend === 'BEARISH') return false;
  if (taTrend && taTrend !== 'BULLISH' && !trustedLpWatch) return false;
  if (!lpMode) {
    const freshAthBreakPct = Number(cfg.entryFreshBreakoutMinAthDistancePct ?? 99.25);
    const breakoutMinStPct = Number(cfg.entrySupertrendBreakMinPct ?? 1.25);
    if (Number.isFinite(signalAthDistancePct) && signalAthDistancePct < freshAthBreakPct) return false;
    if (Number.isFinite(signalStDistancePct) && signalStDistancePct < breakoutMinStPct) return false;
  } else if (!trustedLpWatch && Number.isFinite(signalStDistancePct) && signalStDistancePct <= 0) {
    return false;
  }
  return true;
}

function isSupportedQuotePool(pool = {}) {
  return isSupportedQuoteToken(pool);
}

/**
 * Tambahkan token ke queue setelah lolos Scout Agent.
 * @param {Object} pool     - raw pool object dari pipeline
 * @param {string} symbol   - nama token
 * @param {Object} meta     - { scoutReason, entryReadiness, breakoutQuality }
 */
export function enqueueForDeploy(pool, symbol, meta = {}) {
  const mint = pool.tokenXMint || pool.mint || '';
  if (!mint || _queue.has(mint)) return;

  if (!isSupportedQuotePool(pool)) {
    console.log(`[QUEUE] ⛔ ${symbol} ditolak: unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`);
    return;
  }

  if (!isFreshDeployMeta(meta)) {
    console.log(
      `[QUEUE] ⏸️ ${symbol} tidak masuk queue deploy (DEFER / LP flow belum siap: ` +
      `Entry=${meta.entryReadiness || 'N/A'}, Breakout=${meta.breakoutQuality || 'N/A'}, ` +
      `Timing=${meta.entryTimingState || 'N/A'}, Trend=${meta.taTrend || meta.liveTrend || 'N/A'}, ` +
      `M5=${formatPct(meta.priceChangeM5 ?? meta.snapshotM5Change)}, ` +
      `STDist=${formatPct(meta.signalStDistancePct)}, TrustedWatch=${meta.queueTrustedWatch === true ? 'YES' : 'NO'})`
    );
    return;
  }

  _queue.set(mint, {
    pool,
    symbol,
    mint,
    meta,
    enqueuedAt: Date.now(),
    attempts: 0,
  });

  console.log(`[QUEUE] ✅ ${symbol} masuk antrian deploy real-time (Entry=${meta.entryReadiness}, Breakout=${meta.breakoutQuality})`);

  // Auto-start watcher jika belum jalan — token langsung dipantau setiap 30 detik
  if (!_watcherTimer) {
    console.log('[QUEUE] 👀 Auto-start watcher karena ada token baru masuk antrian');
    _watcherTimer = setTimeout(runWatcher, 30_000);
  }
}

/** Hapus token dari queue */
export function dequeueToken(mint) {
  const entry = _queue.get(mint);
  removeQueueCandidate(mint, entry);
}

/**
 * Cek kondisi pasar sebelum deploy.
 */
async function evaluateDeployConditions(entry) {
  const { pool, meta } = entry;
  const cfg = getConfig();
  if (!isSupportedQuotePool(pool)) {
    return {
      ok: false,
      decision: 'DROP',
      reason: `Unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`,
      trendSource: 'unknown',
      m5Source: 'unknown',
      liveTrend: 'UNKNOWN',
      liveM5: 0,
    };
  }
  const lpMode = String(meta.entryGateMode || cfg.entryGateMode || '').toLowerCase().includes('lp');
  const mint = pool.tokenXMint || pool.mint || '';
  const poolAddress = getPoolAddress(pool);
  const queueSignals = summarizeQueueDecision({ meta, liveSnapshot: null, cfg, lpMode });
  let activeSignals = queueSignals;
  let { trend: liveTrend, trendSource, m5: liveM5, m5Source, decision: freshnessDecision } = activeSignals;

  // Kondisi 1: Waktu expired di antrian
  // Token watch deploy: expiry mengikuti config deployQueueExpiryMin
  const ageMs  = Date.now() - entry.enqueuedAt;
  const maxAgeMinutes = queueSignals.queueExpiryMin;
  const maxAge = Math.max(60_000, Math.round(maxAgeMinutes * 60 * 1000));
  if (ageMs > maxAge) {
    return {
      ok: false,
      decision: 'DROP',
      reason: `Token expired dari antrian (> ${Math.round(maxAge / 60000)} menit)`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  if (lpMode) {
    const memorySignal = getPoolMemorySignal(pool);
    if (memorySignal.memory && Number(memorySignal.priorityDelta || 0) !== 0) {
      console.log(
        `[QUEUE] 🧠 Memory advisory ${mint.slice(0, 8)} ` +
        `delta=${memorySignal.priorityDelta} reason=${memorySignal.reason} lookup=${memorySignal.lookupMs || 0}ms`
      );
    }

    const tvl = Number(pool.totalTvl || pool.activeTvl || 0);
    if (tvl < 5000) {
      return {
        ok: false,
        decision: 'HOLD',
        reason: `TVL terlalu rendah: $${tvl.toLocaleString()}`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }

    const liveSnapshot = await getCachedMarketSnapshot(mint, poolAddress || null, entry.symbol || '', { includeEntryCandles5m: true });
    entry.lastLiveSnapshot = liveSnapshot || entry.lastLiveSnapshot || null;
    if (liveSnapshot) {
      const liveSignals = summarizeQueueDecision({ meta, liveSnapshot, cfg, lpMode });
      const liveSnapshotTrend = readLiveSnapshotTrend(liveSnapshot);
      const liveReliable = isReliableLiveSnapshot(liveSnapshot);
      if (liveSignals.trendSource === 'live' && liveSnapshotTrend === 'BEARISH') {
        return {
          ok: false,
          decision: 'DROP',
          reason: 'Supertrend 15m bearish (live_snapshot)',
          trendSource: 'live',
          m5Source: liveSignals.m5Source,
          liveTrend: 'BEARISH',
          liveM5: liveSignals.m5,
        };
      }
      if (!liveReliable) {
        logUnreliableLiveSnapshot({
          symbol: entry.symbol || '',
          mint,
          poolAddress,
          snapshot: liveSnapshot,
          poolAddressPassed: Boolean(poolAddress),
        });
      }
      activeSignals = liveReliable ? liveSignals : queueSignals;
      ({ trend: liveTrend, trendSource, m5: liveM5, m5Source, decision: freshnessDecision } = activeSignals);

      if (freshnessDecision !== 'DEPLOY') {
        return {
          ok: false,
          decision: freshnessDecision,
          reason: activeSignals.reason || `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
          trendSource,
          m5Source,
          liveTrend,
          liveM5,
        };
      }
    }

    if (freshnessDecision !== 'DEPLOY') {
      return {
        ok: false,
        decision: freshnessDecision,
        reason: activeSignals.reason || `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }

    return {
      ok: true,
      decision: 'DEPLOY',
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  const watchWindowSec = lpMode
    ? Math.max(180, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 180))
    : Math.max(5, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 90));
  const maxDriftPct = lpMode
    ? Math.max(8, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 8))
    : Math.max(0.1, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 2.5));
  const snapshotAt = Number(meta.snapshotAt || entry.enqueuedAt || 0);
  if (snapshotAt > 0 && (Date.now() - snapshotAt) > watchWindowSec * 1000) {
    return {
      ok: false,
      decision: 'HOLD',
      reason: `WATCH terlalu lama (${Math.round((Date.now() - snapshotAt) / 1000)}s > ${watchWindowSec}s)`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  const liveSnapshot = await getCachedMarketSnapshot(mint, poolAddress || null, entry.symbol || '', { includeEntryCandles5m: true });
  entry.lastLiveSnapshot = liveSnapshot || entry.lastLiveSnapshot || null;
  if (liveSnapshot) {
    const liveSignals = summarizeQueueDecision({ meta, liveSnapshot, cfg, lpMode });
    const liveSnapshotTrend = readLiveSnapshotTrend(liveSnapshot);
    if (liveSignals.trendSource === 'live' && liveSnapshotTrend === 'BEARISH') {
      ({ m5: liveM5, m5Source } = liveSignals);
      liveTrend = 'BEARISH';
      trendSource = 'live';
    }
    if (!isReliableLiveSnapshot(liveSnapshot)) {
      logUnreliableLiveSnapshot({
        symbol: entry.symbol || '',
        mint,
        poolAddress,
        snapshot: liveSnapshot,
        poolAddressPassed: Boolean(poolAddress),
      });
    }
    if (!(trendSource === 'live' && liveTrend === 'BEARISH')) {
      ({ trend: liveTrend, trendSource, m5: liveM5, m5Source } = liveSignals);
    }
  }

  const livePrice = Number(liveSnapshot?.ohlcv?.currentPrice || liveSnapshot?.price?.currentPrice || pool?.price || 0);
  const snapshotPrice = Number(meta.snapshotPrice || 0);
  if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && Number.isFinite(livePrice) && livePrice > 0) {
    const driftPct = Math.abs(((livePrice - snapshotPrice) / snapshotPrice) * 100);
    if (driftPct > maxDriftPct) {
      return {
        ok: false,
        decision: 'HOLD',
        reason: `Breakout bergeser ${driftPct.toFixed(2)}% dari snapshot (> ${maxDriftPct}%)`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }
  }

  if (liveSnapshot) {
    if (liveTrend !== 'BULLISH' || liveM5 <= 0) {
      return {
        ok: false,
        decision: liveTrend === 'BEARISH' ? 'DROP' : 'HOLD',
        reason: `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }
  }

  // Kondisi 3: TVL minimal (hindari rug liquidity)
  const tvl = Number(pool.totalTvl || pool.activeTvl || 0);
  if (tvl < 5000) {
    return {
      ok: false,
      decision: 'HOLD',
      reason: `TVL terlalu rendah: $${tvl.toLocaleString()}`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  return {
    ok: true,
    decision: 'DEPLOY',
    trendSource,
    m5Source,
    liveTrend,
    liveM5,
  };
}

/** Main watcher loop */
async function runWatcher() {
  if (isOperatorDiscoveryPaused()) {
    _watcherTimer = null;
    return;
  }

  // Snapshot entries SEBELUM iterasi agar modifikasi map di dalam loop aman
  const entries = Array.from(_queue.entries());

  for (const [mint, entry] of entries) {
    // Outer try-catch: satu token gagal tidak boleh crash loop keseluruhan
    try {
      // Re-check: mungkin sudah dihapus oleh caller lain
      if (!_queue.has(mint)) continue;

      const { symbol, pool, meta } = entry;
      const isRetest = meta?.isRetest || meta?.isScoutDefer;
      const queueType = isRetest ? 'RETEST' : 'DEPLOY';
      const deferUntil = Number(entry.nextEligibleAt || 0);
      if (deferUntil > Date.now()) {
        continue;
      }

      // Log real-time monitoring per token
      console.log(`[QUEUE] ⏳ Memantau TA untuk token ${symbol} secara real-time... [${queueType}] (attempt ${entry.attempts + 1})`);

      if (entry.attempts >= 3) {
        console.log(`[QUEUE] 🗑️ ${symbol} dihapus dari antrian (max attempts)`);
        removeQueueCandidate(mint, entry);
        await safeSend(
          `⏱️ <b>Deploy Queue Expired</b>\n` +
          `<b>${symbol}</b> dihapus setelah 3x gagal evaluate.`
        );
        continue;
      }

      const check = await evaluateDeployConditions(entry);
      const decision = String(check.decision || (check.ok ? 'DEPLOY' : 'HOLD')).toUpperCase();

      if (!check.ok) {
        console.log(
          `[QUEUE] ⏳ ${symbol} belum siap [${decision}] ` +
          `trend=${check.liveTrend || 'UNKNOWN'} (${check.trendSource || 'unknown'}) ` +
          `m5=${formatPct(check.liveM5)} (${check.m5Source || 'unknown'}) ` +
          `reason=${check.reason} (attempt ${entry.attempts}/3)`
        );
        if (check.deferUntil && Number(check.deferUntil) > Date.now()) {
          entry.nextEligibleAt = Number(check.deferUntil);
          entry.deferReason = check.reason;
          entry.deferNotifiedAt = entry.deferNotifiedAt || Date.now();
          entry.enqueuedAt = Date.now();
        }
        if (decision === 'DROP' || check.reason.includes('expired')) {
          removeQueueCandidate(mint, entry);
          await safeSend(
            `❌ <b>Deploy Queue ${decision === 'DROP' ? 'Drop' : 'Expired'}</b>\n` +
            `<b>${symbol}</b>\n` +
            `Trend: <code>${check.liveTrend || 'UNKNOWN'}</code> (<code>${check.trendSource || 'unknown'}</code>)\n` +
            `M5: <code>${formatPct(check.liveM5)}</code> (<code>${check.m5Source || 'unknown'}</code>)\n` +
            `<i>${check.reason}</i>`
          );
        }
        continue;
      }

      // Resolusi pool address — cek semua field yang mungkin dipakai Meteora API
      const poolAddress = getPoolAddress(pool);
      if (!poolAddress) {
        console.warn(`[QUEUE] ⚠️ Pool address tidak ditemukan untuk ${symbol} — fields: ${JSON.stringify(Object.keys(pool))}`);
        removeQueueCandidate(mint, entry);
        await safeSend(
          `⚠️ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${symbol}</b> — Pool address tidak valid.\n` +
          `<i>Tidak ada field address yang tersedia di objek pool.</i>`
        );
        continue;
      }

      // Validate poolAddress adalah Solana pubkey (base58, 32–44 chars)
      if (typeof poolAddress !== 'string' || poolAddress.length < 32 || poolAddress.length > 44) {
        console.error(`[QUEUE] ❌ Pool address tidak valid untuk ${symbol}: "${poolAddress}"`);
        removeQueueCandidate(mint, entry);
        await safeSend(
          `❌ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${symbol}</b> — Pool address bukan Solana pubkey yang valid.`
        );
        continue;
      }

      const currentPrice = Number(
        pool?._entrySignals?.currentPrice ||
        meta?.currentPrice ||
        pool?.price ||
        pool?.pool_price ||
        0
      );
      const finalSt = await ensureFinalSupertrendBullish({ mint, symbol, pool, meta, currentPrice });
      if (!finalSt.ok) {
        if (finalSt.action === 'VETO') {
          removeQueueCandidate(mint, entry);
          await safeSend(
            `❌ <b>Deploy Queue Drop</b>\n` +
            `<b>${symbol}</b>\n` +
            `ST 15m: <code>${finalSt.direction || 'UNKNOWN'}</code> (<code>${finalSt.source}</code>)\n` +
            `<i>${escapeHTML(finalSt.reason)}</i>`
          );
        } else {
          entry.nextEligibleAt = Date.now() + 15_000;
          entry.deferReason = finalSt.reason;
          console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: ${finalSt.reason}`);
        }
        continue;
      }

      const finalCandle = await ensureFinalEntryCandleSanity({
        mint,
        symbol,
        pool,
        meta,
        liveSnapshot: entry.lastLiveSnapshot || null,
      });
      if (!finalCandle.ok) {
        entry.nextEligibleAt = Date.now() + 15_000;
        entry.deferReason = finalCandle.reason;
        console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: ${finalCandle.reason}`);
        const cfg = getConfig();
        const cooldownSec = Math.max(30, Number(cfg.deployQueueHoldNotifyCooldownSec ?? 180) || 180);
        const notifyDecision = shouldSendDeployQueueHoldNotification({
          poolAddress,
          mint,
          reason: finalCandle.reason,
          now: Date.now(),
          cooldownMs: cooldownSec * 1000,
        });
        if (!notifyDecision.shouldSend) {
          console.log(
            `[QUEUE] 🔕 Suppressed duplicate HOLD Telegram for ${symbol || mint.slice(0, 8)} ` +
            `reason="${notifyDecision.normalizedReason}" cooldown=${cooldownSec}s`
          );
        } else {
          await safeSend(
            `⏸️ <b>Deploy Queue Hold</b>\n` +
            `<b>${symbol}</b>\n` +
            `Candle: <code>${escapeHTML(finalCandle.source || 'unknown')}</code>\n` +
            `<i>${escapeHTML(finalCandle.reason)}</i>`
          );
        }
        continue;
      }

      const cfg = getConfig();
      const solAmount = cfg.deployAmountSol || 0.1;
      recordPoolDeploy({
        pool,
        reason: meta?.scoutReason || 'QUEUE_DEPLOY',
        source: 'DEPLOY_QUEUE',
        snapshot: {
          ...meta,
          recentTrend: check.liveTrend,
          recentM5: check.liveM5,
        },
      });
      console.log(
        `[QUEUE] 🚀 Attempting deploy for ${symbol} ` +
        `decision=${decision} trend=${check.liveTrend || 'UNKNOWN'} (${check.trendSource || 'unknown'}) ` +
        `m5=${formatPct(check.liveM5)} (${check.m5Source || 'unknown'}) ` +
        `intent=${meta?.hasFrozenEntryIntent === true ? 'FROZEN' : 'LIVE'} ` +
        `amount=${solAmount} SOL (Pool: ${poolAddress.slice(0, 8)})`
      );
      const slotReservation = reserveDeploySlot({
        owner: 'deployQueueWatcher',
        mint,
        symbol,
        poolAddress,
        source: isRetest ? 'retestQueue' : 'deployQueue',
        ttlMs: Number(cfg.deployTimeoutMs || 180_000) + 60_000,
      });

      if (!slotReservation.ok) {
        console.log(`[QUEUE] ⏳ Slot penuh, ${symbol} tetap di queue (${slotReservation.reason})`);
        continue;
      }
      entry.attempts++;
      const reservationId = slotReservation.id;
      removeQueueCandidate(mint, entry); // Hapus sebelum deploy (idempoten)

      try {
        await safeSend(buildDeployTriggeredTelegramMessage({
          symbol,
          poolAddress,
          check,
          decision,
          entry: {
            pool,
            meta: entry.meta,
          },
          solAmount,
          cfg,
          finalCandle,
        }));

        if (!_deployFn) {
          throw new Error('deployFn belum di-set ke DeployQueue — panggil setDeployQueueDeployFn() dulu.');
        }

        const result = await _deployFn(poolAddress, {
          hasNonRefundableFees:
            pool?._marketSnapshot?.pool?.hasNonRefundableFees ??
            pool?.hasNonRefundableFees ??
            meta?.hasNonRefundableFees ??
            false,
          frozenEntryIntent: {
            entryActiveBin: Number.isFinite(Number(meta?.entryActiveBin)) ? Number(meta.entryActiveBin) : null,
            entryPrice: Number.isFinite(Number(meta?.entryPrice)) ? Number(meta.entryPrice) : null,
            snapshotAt: Number.isFinite(Number(meta?.snapshotAt)) ? Number(meta.snapshotAt) : null,
            enabled: meta?.hasFrozenEntryIntent === true,
          },
        });

        if (result && typeof result === 'object' && result.dryRun) {
          await safeSend(
            `🧪 <b>Dry-run (Queue Deploy)</b>\n` +
            `<b>${symbol}</b> — Simulasi selesai, tidak ada tx real.\n` +
            `Range: <code>${result.rangeMin}–${result.rangeMax}</code>`
          );
          continue;
        }
        if (result && typeof result === 'object' && result.blocked) {
          const blockedReason = String(result.reason || 'DEPLOY_BLOCKED');
          const blockedByRent = String(result.reason || '').includes('VETO_NON_REFUNDABLE_RENT');
          const blockedByBalance = blockedReason.includes('INSUFFICIENT_SOL_BALANCE');
          if (blockedByBalance) {
            const holdCooldownSec = Math.max(60, Number(cfg.deployQueueHoldNotifyCooldownSec) || 180);
            const holdNotice = shouldSendDeployQueueHoldNotification({
              poolAddress,
              mint,
              reason: blockedReason,
              now: Date.now(),
              cooldownMs: holdCooldownSec * 1000,
            });
            entry.attempts = Math.max(0, entry.attempts - 1);
            entry.nextEligibleAt = Date.now() + holdCooldownSec * 1000;
            _queue.set(mint, entry);
            if (holdNotice.shouldSend) {
              await safeSend(
                `⏸️ <b>Deploy Queue Hold</b>\n` +
                `<b>${symbol}</b> — <code>${blockedReason}</code>\n` +
                `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
                (result.detail ? `Detail: <code>${escapeHTML(String(result.detail).slice(0, 240))}</code>\n` : '') +
                `<i>Saldo belum cukup untuk deploy aman. Queue akan cek ulang otomatis setelah ${holdCooldownSec}s.</i>`
              );
            }
            continue;
          }
          await safeSend(
            `${blockedByRent ? '⛔ <b>Deploy Ditolak (Queue)</b>' : '⛔ <b>Deploy Ditolak (Queue)</b>'}\n` +
            `<b>${symbol}</b> — <code>${blockedReason}</code>\n` +
          `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
          (
            Number.isFinite(Number(result.rangeMin)) && Number.isFinite(Number(result.rangeMax))
              ? `Range: <code>${result.rangeMin}-${result.rangeMax}</code> (max ${result.rangeMaxBins ?? 'n/a'} bin)\n`
              : ''
          ) +
          (result.detail ? `Detail: <code>${escapeHTML(String(result.detail).slice(0, 240))}</code>\n` : '') +
          (blockedByRent
              ? `<i>Adjust range gagal untuk pool/range ini. Pool lain tetap normal.</i>`
              : `<i>Queue menghormati veto deploy.</i>`)
          );
          continue;
        }

        const positionPubkey = typeof result === 'string' ? result : null;
        await safeSend(
          `✅ <b>Deploy Berhasil! (Queue)</b>\n` +
          `<b>${symbol}</b> — <code>DEPLOYED</code>\n` +
          (positionPubkey ? `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` : '') +
          `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
          `🔒 <i>Masuk mode monitor...</i>`
        );

        if (positionPubkey && _monitorFn) {
          _monitorFn(positionPubkey, symbol, poolAddress).catch(e => {
            console.error(`[QUEUE] Monitor loop crash untuk ${symbol}: ${e.message}`);
          });
        }
      } finally {
        await releaseDeploySlot(reservationId).catch(() => {});
      }

    } catch (tokenErr) {
      // Token-level error: log dan lanjut ke token berikutnya, jangan crash loop
      const sym = entry?.symbol || mint?.slice(0, 8) || 'UNKNOWN';
      console.error(`[QUEUE] ⛔ Error saat proses ${sym}: ${tokenErr.message}`);
      removeQueueCandidate(mint, entry); // Buang dari queue agar tidak retry tanpa batas
      await safeSend(
        `❌ <b>Deploy Gagal (Queue)</b>\n` +
        `<b>${sym}</b>\n` +
        `Error: <code>${tokenErr.message.slice(0, 200)}</code>\n` +
        `<i>Token dikeluarkan dari queue.</i>`
      );
    }
  }

  // Jadwalkan ulang watcher (15 detik — real-time monitoring)
  _watcherTimer = setTimeout(runWatcher, 15_000);
}

/** Mulai watcher. Panggil sekali saat startup. */
export function startDeployQueueWatcher() {
  if (_watcherTimer) return;
  console.log('[QUEUE] 👀 Watcher dimulai (interval: 15s real-time monitoring)');
  _watcherTimer = setTimeout(runWatcher, 15_000);
}

/** Hentikan watcher. */
export function stopDeployQueueWatcher() {
  if (_watcherTimer) {
    clearTimeout(_watcherTimer);
    _watcherTimer = null;
  }
  _queue.clear();
  __resetDeployQueueHoldNotifyState();
  console.log('[QUEUE] 🛑 Watcher dihentikan');
}

export function getQueueSize()    { return _queue.size; }
export function getQueueEntries() { return Array.from(_queue.values()); }
