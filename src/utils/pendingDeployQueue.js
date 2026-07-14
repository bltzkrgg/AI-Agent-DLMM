'use strict';

import { getConfig } from '../config.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { checkSupertrendVeto, isSupportedQuoteToken, getQuoteTokenLabel } from '../market/meridianVeto.js';
import { getPoolMemorySignal, recordPoolDeploy } from '../market/poolMemory.js';
import { getRuntimeState } from '../runtime/state.js';
import { getDeploySlotUsage, reserveDeploySlot, releaseDeploySlot } from './deploySlotGuard.js';
import { evaluateClosedM15SupertrendReclaim, evaluateEntryCandleSanity } from './entryCandleSanity.js';

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
const FINAL_ENTRY_PROXIMITY_MAX_BIN_DELTA = 1;
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

function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export function buildDeployTriggeredTelegramMessage({
  symbol = '',
  attemptId = '',
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
    `⏳ <b>DEPLOY ATTEMPT</b>\n` +
    `Token: <b>${symbol}</b>\n` +
    `Pool: <code>${poolAddress.slice(0, 8)}</code>\n\n` +
    `Trend: <b>${check.liveTrend || 'UNKNOWN'}</b>\n` +
    m15Line +
    m5Line +
    `\nEntry: <b>${entry?.meta?.entryReadiness || 'N/A'}</b> | ` +
    `Breakout: <b>${entry?.meta?.breakoutQuality || 'N/A'}</b>\n` +
    `Timing: <code>${entry?.meta?.entryTimingState || 'N/A'}</code>\n` +
    (attemptId ? `Attempt ID: <code>${attemptId}</code>\n` : '') +
    `\n⏳ <i>Sedang membuka posisi ${solAmount} SOL...</i>`
  );
}

function summarizeFinalDeployReason({
  outcome = 'SUCCESS',
  reason = '',
  proximityDecision = null,
} = {}) {
  const rawReason = String(reason || '').trim();
  const lowerReason = rawReason.toLowerCase();
  if (outcome === 'HOLD') {
    if (lowerReason.includes('final snapshot unavailable') || lowerReason.includes('waiting fresh market snapshot')) {
      return 'final snapshot unavailable';
    }
    if (lowerReason.includes('final snapshot unreliable') || lowerReason.includes('waiting reliable live snapshot')) {
      return 'final snapshot unreliable';
    }
    if (lowerReason.includes('fresh live price/bin snapshot') || lowerReason.includes('entry proximity unavailable')) {
      return 'final live price/bin unavailable';
    }
    if (lowerReason.includes('drift too wide')) {
      return 'final drift too wide';
    }
    if (lowerReason.includes('snapshot not fresh')) {
      return 'final snapshot not fresh';
    }
    if (lowerReason.includes('trusted execution snapshot')) {
      return 'final trusted execution snapshot';
    }
    if (Number.isFinite(Number(proximityDecision?.priceDriftPct)) || Number.isFinite(Number(proximityDecision?.binDelta))) {
      const drift = Number.isFinite(Number(proximityDecision?.priceDriftPct))
        ? `${Number(proximityDecision.priceDriftPct).toFixed(2)}%`
        : 'na';
      const bin = Number.isFinite(Number(proximityDecision?.binDelta))
        ? String(proximityDecision.binDelta)
        : 'na';
      return `final drift guard hit (drift=${drift}, bin=${bin})`;
    }
    return rawReason || 'final deploy hold';
  }

  if (outcome === 'BLOCKED') {
    if (lowerReason.includes('invalid_dlmm_deploy_args')) return 'final deploy blocked by invalid DLMM args';
    if (lowerReason.includes('veto_non_refundable_rent')) return 'final deploy blocked by non-refundable rent';
    return rawReason || 'final deploy blocked';
  }

  if (outcome === 'RECONCILE') {
    return rawReason || 'final deploy result needs reconcile';
  }

  return rawReason || 'final deploy success';
}

export function buildDeployFinalOutcomeTelegramMessage({
  symbol = '',
  attemptId = '',
  poolAddress = '',
  outcome = 'SUCCESS',
  reason = '',
  detail = '',
  proximityDecision = null,
  positionPubkey = '',
} = {}) {
  const normalizedOutcome = String(outcome || 'SUCCESS').toUpperCase();
  const statusCode = normalizedOutcome === 'HOLD'
    ? 'FINAL_DEPLOY_HOLD'
    : normalizedOutcome === 'BLOCKED'
      ? 'FINAL_DEPLOY_BLOCKED'
      : normalizedOutcome === 'RECONCILE'
        ? 'FINAL_DEPLOY_RECONCILE'
        : 'FINAL_DEPLOY_SUCCESS';
  const headline = normalizedOutcome === 'HOLD'
    ? '⏸️ <b>Deploy Ditahan</b>'
    : normalizedOutcome === 'BLOCKED'
      ? '⛔ <b>Deploy Diblokir</b>'
      : normalizedOutcome === 'RECONCILE'
        ? '⚠️ <b>Deploy Reconcile Required</b>'
        : '✅ <b>Deploy Selesai</b>';
  const statusLine = normalizedOutcome === 'SUCCESS'
    ? `Status: <code>DEPLOYED</code>\n`
    : `Status: <code>${statusCode}</code>\n`;
  const reasonText = summarizeFinalDeployReason({ outcome: normalizedOutcome, reason, proximityDecision });
  const driftLine = normalizedOutcome === 'HOLD' && proximityDecision
    ? `Drift: <code>${Number.isFinite(Number(proximityDecision.priceDriftPct)) ? `${Number(proximityDecision.priceDriftPct).toFixed(2)}%` : 'na'}</code> | ` +
      `Bin: <code>${Number.isFinite(Number(proximityDecision.binDelta)) ? proximityDecision.binDelta : 'na'}</code>\n`
    : '';
  const detailLine = detail
    ? `Detail: <code>${escapeHTML(String(detail).slice(0, 240))}</code>\n`
    : '';
  const manualActionLine = normalizedOutcome === 'BLOCKED'
    ? `<i>Deploy tidak tuntas. Jika sempat ada posisi parsial, unwrap dan close manual dulu.</i>`
    : normalizedOutcome === 'RECONCILE'
      ? `<i>Hasil deploy belum pasti. Cek on-chain sebelum retry manual.</i>`
      : normalizedOutcome === 'HOLD'
        ? `<i>Final snapshot belum layak. Agent menahan deploy.</i>`
        : `<i>Masuk mode monitor...</i>`;

  return (
    `${headline}\n` +
    `<b>${escapeHTML(symbol)}</b>` +
    (normalizedOutcome === 'SUCCESS' ? ' — <code>DEPLOYED</code>' : ` — <code>${statusCode}</code>`) + '\n' +
    (attemptId ? `Attempt ID: <code>${attemptId}</code>\n` : '') +
    `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
    statusLine +
    (positionPubkey ? `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` : '') +
    (normalizedOutcome === 'HOLD' ? `Reason: <code>${escapeHTML(reasonText)}</code>\n` : `Reason: <code>${escapeHTML(reasonText)}</code>\n`) +
    driftLine +
    detailLine +
    manualActionLine
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

function logSilentFinalDeployHold({
  symbol = '',
  mint = '',
  poolAddress = '',
  reason = '',
  stage = 'final_gate',
} = {}) {
  console.log(
    `[QUEUE] 🔕 Silent final HOLD ${symbol || mint?.slice?.(0, 8) || 'UNKNOWN'} ` +
    `stage=${stage} pool=${String(poolAddress || 'unknown').slice(0, 8) || 'unknown'} ` +
    `reason=${reason || 'unknown'}`
  );
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

function buildDeployAttemptId({ mint = '', poolAddress = '', now = Date.now() } = {}) {
  const mintShort = String(mint || 'unknown').slice(0, 4);
  const poolShort = String(poolAddress || 'nopool').slice(0, 4);
  const stamp = Number(now || Date.now()).toString(36).slice(-6);
  return `${mintShort}-${poolShort}-${stamp}`;
}

export function classifyDeployAttemptResult(result) {
  if (result && typeof result === 'object' && result.dryRun) {
    return { status: 'DRY_RUN', ok: true, detail: result };
  }
  if (result && typeof result === 'object' && result.blocked) {
    return {
      status: 'BLOCKED',
      ok: true,
      detail: result,
      reason: String(result.reason || 'DEPLOY_BLOCKED'),
    };
  }
  if (typeof result === 'string' && result.trim()) {
    return {
      status: 'SUCCESS',
      ok: true,
      positionPubkey: result,
    };
  }
  return {
    status: 'UNKNOWN_RECONCILE',
    ok: false,
    detail: result,
    reason: 'DEPLOY_RESULT_UNKNOWN_RECONCILE',
  };
}

function logDeployAttemptOutcome({
  attemptId = '',
  status = 'UNKNOWN',
  symbol = '',
  poolAddress = '',
  message = '',
  error = false,
} = {}) {
  const logLine =
    `[QUEUE] ${error ? '⛔' : 'ℹ️'} DEPLOY_ATTEMPT_${String(status || 'UNKNOWN').toUpperCase()} ` +
    `attempt=${attemptId || 'na'} symbol=${symbol || 'UNKNOWN'} pool=${String(poolAddress || 'unknown').slice(0, 8)} ` +
    `${message || ''}`.trim();
  if (error) console.error(logLine);
  else console.log(logLine);
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

function hasValidFrozenDeployIntent({
  entryActiveBin = null,
  entryPrice = null,
  snapshotAt = null,
  maxAgeSec = 180,
  now = Date.now(),
} = {}) {
  const bin = Number(entryActiveBin);
  const price = Number(entryPrice);
  const ts = Number(snapshotAt);
  const safeMaxAgeSec = Math.max(30, Number(maxAgeSec) || 180);
  const ageMs = Number.isFinite(ts) && ts > 0 ? Math.max(0, now - ts) : Number.POSITIVE_INFINITY;
  return Number.isFinite(bin) &&
    Number.isSafeInteger(bin) &&
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(ts) &&
    ts > 0 &&
    ageMs <= (safeMaxAgeSec * 1000);
}

function readCanonicalEntryMeta(meta = {}, fallback = {}) {
  const snapshot = meta?.entryCanonicalSnapshot && typeof meta.entryCanonicalSnapshot === 'object'
    ? meta.entryCanonicalSnapshot
    : null;
  return {
    snapshotAt: Number.isFinite(Number(snapshot?.snapshotAt))
      ? Number(snapshot.snapshotAt)
      : Number.isFinite(Number(meta?.snapshotAt))
        ? Number(meta.snapshotAt)
        : fallback.snapshotAt ?? null,
    snapshotPrice: Number.isFinite(Number(snapshot?.snapshotPrice))
      ? Number(snapshot.snapshotPrice)
      : Number.isFinite(Number(meta?.snapshotPrice))
        ? Number(meta.snapshotPrice)
        : fallback.snapshotPrice ?? null,
    snapshotM5Change: Number.isFinite(Number(snapshot?.snapshotM5Change))
      ? Number(snapshot.snapshotM5Change)
      : Number.isFinite(Number(meta?.snapshotM5Change))
        ? Number(meta.snapshotM5Change)
        : fallback.snapshotM5Change ?? null,
    watchWindowSec: Number.isFinite(Number(snapshot?.watchWindowSec))
      ? Number(snapshot.watchWindowSec)
      : Number.isFinite(Number(meta?.watchWindowSec))
        ? Number(meta.watchWindowSec)
        : fallback.watchWindowSec ?? null,
    maxDriftPct: Number.isFinite(Number(snapshot?.maxDriftPct))
      ? Number(snapshot.maxDriftPct)
      : Number.isFinite(Number(meta?.maxDriftPct))
        ? Number(meta.maxDriftPct)
        : fallback.maxDriftPct ?? null,
    entryActiveBin: Number.isFinite(Number(snapshot?.entryActiveBin))
      ? Number(snapshot.entryActiveBin)
      : Number.isFinite(Number(meta?.entryActiveBin))
        ? Number(meta.entryActiveBin)
        : fallback.entryActiveBin ?? null,
    entryPrice: Number.isFinite(Number(snapshot?.entryPrice))
      ? Number(snapshot.entryPrice)
      : Number.isFinite(Number(meta?.entryPrice))
        ? Number(meta.entryPrice)
        : fallback.entryPrice ?? null,
  };
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

function isSlotSaturationHoldReason(reason = '') {
  return String(reason || '').includes('SLOT_SATURATED_PROMOTION_PAUSED');
}

function isDeploySlotSaturated() {
  return getDeploySlotUsage().available <= 0;
}

function readLiveSnapshotAtMs(liveSnapshot = null, meta = {}, pool = {}) {
  const rawSnapshotAt = liveSnapshot?.snapshotAt ??
    liveSnapshot?.ts ??
    liveSnapshot?.timestamp ??
    meta?.snapshotAt ??
    pool?._watchSnapshotAt ??
    null;
  const numericSnapshotAt = Number(rawSnapshotAt);
  if (Number.isFinite(numericSnapshotAt) && numericSnapshotAt > 0) return numericSnapshotAt;
  const parsedSnapshotAt = Date.parse(String(rawSnapshotAt || ''));
  return Number.isFinite(parsedSnapshotAt) && parsedSnapshotAt > 0 ? parsedSnapshotAt : 0;
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

function isUsableLiveExecutionSnapshot(snapshot = null, meta = {}, pool = {}, cfg = getConfig(), now = Date.now()) {
  const source = String(snapshot?.ohlcv?.source || snapshot?.dataSource || '').toLowerCase();
  if (!snapshot || !source.includes('meteora-dlmm-ohlcv')) return false;
  const live = readLiveActiveBinState(snapshot, pool, meta);
  if (!(Number.isFinite(Number(live.currentPrice)) && Number(live.currentPrice) > 0 &&
    Number.isFinite(Number(live.activeBinId)))) {
    return false;
  }
  const snapshotAt = readLiveSnapshotAtMs(snapshot, meta, pool);
  if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return false;
  const canonicalWatchWindowSec = Number(
    meta?.watchWindowSec ||
    meta?.entryCanonicalSnapshot?.watchWindowSec ||
    pool?._watchWindowSec ||
    0
  );
  const resolvedWatchWindowMs = Number.isFinite(canonicalWatchWindowSec) && canonicalWatchWindowSec > 0
    ? canonicalWatchWindowSec * 1000
    : 0;
  const strictMaxAgeMs = Math.max(
    5_000,
    resolvedWatchWindowMs,
    Number(cfg?.entryFinalLiveSnapshotMaxAgeMs) ||
    Number(cfg?.entryFreshWatchWindowSec) * 1000 ||
    90_000
  );
  const executionMaxAgeMs = Math.max(strictMaxAgeMs, 180_000);
  return (now - snapshotAt) <= executionMaxAgeMs;
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
  const bypassCache = options?.bypassCache === true;
  const key = getSnapshotCacheKey(mint, poolAddress || '', { includeEntryCandles5m });
  const now = Date.now();
  if (!bypassCache) {
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
  }

  _snapshotCacheMisses += 1;
  console.log(
    `[QUEUE] 🧠 Snapshot cache miss ${symbol || mint.slice(0, 8)} ` +
    `pool=${(poolAddress || '').slice(0, 8) || 'none'} poolAddressPassed=${poolAddress ? 'yes' : 'no'} ` +
    `entry5m=${includeEntryCandles5m ? 'yes' : 'no'} ` +
    `mode=${bypassCache ? 'bypass' : 'cache'} ` +
    `hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`
  );
  const task = getMarketSnapshot(mint, poolAddress || null, {
    from: includeEntryCandles5m ? 'entry_candle_sanity' : 'deploy_queue',
    includeEntryCandles5m,
    includeOnChainSignals: false,
    bypassCache,
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

export async function getDeployQueueLiveSnapshot(mint, poolAddress = null, symbol = '', options = {}) {
  return getCachedMarketSnapshot(mint, poolAddress, symbol, options);
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
  const canonicalLiveTrend = readCanonicalLiveSnapshotTrend(liveSnapshot);
  const liveTrendRaw = canonicalLiveTrend.trend;
  const liveM5Raw = Number(liveSnapshot?.ohlcv?.priceChangeM5 ?? 0);
  const liveSource = String(liveSnapshot?.ohlcv?.source || liveSnapshot?.dataSource || '').toLowerCase();
  const liveEntry5mHistory = liveSnapshot?.ohlcv?.entry5mHistorySuccess === true;
  const liveHistorySuccess = liveSnapshot?.ohlcv?.historySuccess === true;
  const liveTrendKnown = ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(liveTrendRaw) && canonicalLiveTrend.conflicted !== true;
  const liveM5Known = Number.isFinite(liveM5Raw) && (
    liveEntry5mHistory ||
    liveHistorySuccess ||
    liveSource.includes('meteora-dlmm-ohlcv')
  );

  return {
    // For LP final decisions, once a live snapshot exists we fail closed on live truth
    // instead of reviving queued bullish trend from older scout/watch metadata.
    trend: liveSnapshot ? (liveTrendKnown ? liveTrendRaw : 'UNKNOWN') : (metaTrendRaw || 'UNKNOWN'),
    trendSource: liveSnapshot ? (liveTrendKnown ? 'live' : 'unknown') : (metaTrendRaw ? 'queue' : 'unknown'),
    m5: liveM5Known ? liveM5Raw : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? metaM5Raw : 0),
    m5Source: liveM5Known ? 'live' : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? 'queue' : 'unknown'),
    liveTrendRaw,
    liveM5Raw,
    metaTrendRaw,
    metaM5Raw,
    liveTrendConflicted: canonicalLiveTrend.conflicted === true,
    liveQualityTrend: canonicalLiveTrend.qualityTrend,
    liveTaTrend: canonicalLiveTrend.taTrend,
  };
}

function isTrustedLpWatchMeta(meta = {}) {
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  return meta.queueTrustedWatch === true &&
    (timingState === 'BREAKOUT' || timingState === 'ATH_BREAK' || timingState === 'MOMENTUM_ALIVE') &&
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

function readCanonicalLiveSnapshotTrend(liveSnapshot = null) {
  const qualityTrend = normalizeLiveTrend(liveSnapshot?.quality?.taTrend || 'UNKNOWN');
  const taTrend = normalizeLiveTrend(liveSnapshot?.ta?.supertrend?.trend || 'UNKNOWN');

  if (qualityTrend === 'UNKNOWN' && taTrend === 'UNKNOWN') {
    return { trend: 'UNKNOWN', conflicted: false, qualityTrend, taTrend };
  }
  if (qualityTrend === 'UNKNOWN') {
    return { trend: taTrend, conflicted: false, qualityTrend, taTrend };
  }
  if (taTrend === 'UNKNOWN') {
    return { trend: qualityTrend, conflicted: false, qualityTrend, taTrend };
  }
  if (qualityTrend === taTrend) {
    return { trend: qualityTrend, conflicted: false, qualityTrend, taTrend };
  }

  return { trend: 'UNKNOWN', conflicted: true, qualityTrend, taTrend };
}

function readLiveSnapshotTrend(liveSnapshot = null) {
  return readCanonicalLiveSnapshotTrend(liveSnapshot).trend;
}

function readClosedM15SupertrendReclaimState(liveSnapshot = null, cfg = getConfig(), now = Date.now()) {
  const reclaim = evaluateClosedM15SupertrendReclaim({
    snapshot: liveSnapshot,
    now,
    maxAgeSec: Number(cfg.entryM15MaxAgeSec ?? 1800) || 1800,
    supertrendValue: liveSnapshot?.ta?.supertrend?.value,
  });
  return {
    known: reclaim.known === true,
    source: reclaim.source || 'unknown',
    candle: reclaim.candle || null,
    supertrendValue: reclaim.supertrendValue ?? null,
    distancePct: reclaim.distancePct ?? null,
    aboveLine: reclaim.aboveLine === true,
    ageSec: reclaim.ageSec ?? null,
    freshWindowOk: reclaim.freshWindowOk ?? null,
    consecutiveAboveLineCount: reclaim.consecutiveAboveLineCount ?? null,
    timingState: reclaim.timingState ?? null,
    windowState: reclaim.windowState ?? null,
    staleWarning: reclaim.staleWarning ?? null,
    reason: reclaim.reason || 'M15_RECLAIM_UNAVAILABLE',
  };
}

function readLiveActiveBinState(liveSnapshot = null, pool = {}, meta = {}) {
  const currentPrice = Number(
    liveSnapshot?.ohlcv?.liveSpotPrice ||
    liveSnapshot?.ohlcv?.currentPrice ||
    liveSnapshot?.price?.currentPrice ||
    meta?.currentPrice ||
    pool?.price ||
    pool?.pool_price ||
    0
  );
  const activeBinId = Number(
    liveSnapshot?.pool?.activeBinId ??
    liveSnapshot?.activeBinId ??
    pool?._activeBinId ??
    pool?.activeBinId ??
    pool?.activeBin ??
    meta?.activeBinId ??
    Number.NaN
  );
  return {
    currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null,
    activeBinId: Number.isFinite(activeBinId) ? Math.trunc(activeBinId) : null,
  };
}

function isFreshLiveSnapshot(liveSnapshot = null, meta = {}, pool = {}, cfg = getConfig(), now = Date.now()) {
  const source = String(liveSnapshot?.ohlcv?.source || liveSnapshot?.dataSource || '').toLowerCase();
  if (!liveSnapshot || !source) return false;
  if (!source.includes('meteora-dlmm-ohlcv')) return false;

  const snapshotAt = readLiveSnapshotAtMs(liveSnapshot, meta, pool);
  if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return false;

  const canonicalWatchWindowSec = Number(
    meta?.watchWindowSec ||
    meta?.entryCanonicalSnapshot?.watchWindowSec ||
    pool?._watchWindowSec ||
    0
  );
  const resolvedWatchWindowMs = Number.isFinite(canonicalWatchWindowSec) && canonicalWatchWindowSec > 0
    ? canonicalWatchWindowSec * 1000
    : 0;
  const maxAgeMs = Math.max(
    5_000,
    resolvedWatchWindowMs,
    Number(cfg?.entryFinalLiveSnapshotMaxAgeMs) ||
    Number(cfg?.entryFreshWatchWindowSec) * 1000 ||
    90_000
  );
  return (now - snapshotAt) <= maxAgeMs;
}

function getLiveUpsideTolerance(liveSnapshot = null, maxDriftPct = 2.5) {
  const liveTrend = readLiveSnapshotTrend(liveSnapshot);
  const liveM5 = Number(liveSnapshot?.ohlcv?.priceChangeM5 ?? 0);
  const bullishFastMove = liveTrend === 'BULLISH' && Number.isFinite(liveM5) && liveM5 >= 1.25;
  return {
    bullishFastMove,
    liveTrend,
    liveM5,
    allowedUpperPriceDriftPct: bullishFastMove ? (maxDriftPct + 0.75) : maxDriftPct,
    allowedUpperBinDelta: bullishFastMove ? (FINAL_ENTRY_PROXIMITY_MAX_BIN_DELTA + 1) : FINAL_ENTRY_PROXIMITY_MAX_BIN_DELTA,
  };
}

export function getFinalEntryProximityDecision({
  meta = {},
  pool = {},
  liveSnapshot = null,
  cfg = getConfig(),
  now = Date.now(),
} = {}) {
  const canonicalMeta = readCanonicalEntryMeta(meta);
  const trustedLpWatch = isTrustedLpWatchMeta(meta);
  const maxDriftPct = Math.max(0.1, Number(cfg?.entryFinalProximityMaxDriftPct) || 2.5);
  const intentPrice = Number.isFinite(Number(canonicalMeta.entryPrice)) ? Number(canonicalMeta.entryPrice) : null;
  const intentBin = Number.isFinite(Number(canonicalMeta.entryActiveBin)) ? Number(canonicalMeta.entryActiveBin) : null;
  const live = readLiveActiveBinState(liveSnapshot, pool, meta);
  const currentPrice = live.currentPrice;
  const activeBinId = live.activeBinId;
  const freshLiveSnapshot = isFreshLiveSnapshot(liveSnapshot, canonicalMeta, pool, cfg, now);
  const executionUsableSnapshot = isUsableLiveExecutionSnapshot(liveSnapshot, canonicalMeta, pool, cfg, now);
  if (!freshLiveSnapshot) {
    if (!trustedLpWatch || !executionUsableSnapshot) {
      return {
        ok: false,
        action: 'HOLD',
        reason: 'entry proximity unavailable; waiting fresh live price/bin snapshot',
        currentPrice,
        activeBinId,
        intentPrice,
        intentBin,
        priceDriftPct: null,
        binDelta: null,
        comparedBy: 'none',
        snapshotUsableForExecution: executionUsableSnapshot,
        freshLiveSnapshot,
      };
    }
  }
  if (!freshLiveSnapshot && trustedLpWatch && executionUsableSnapshot) {
    // Allow trusted LP watch to continue on mildly stale-but-usable execution snapshots.
  }
  const signedPriceDriftPct = intentPrice > 0 && currentPrice > 0
    ? ((currentPrice - intentPrice) / intentPrice) * 100
    : null;
  const priceDriftPct = Number.isFinite(signedPriceDriftPct)
    ? Math.abs(signedPriceDriftPct)
    : null;
  const signedBinDelta = Number.isFinite(intentBin) && Number.isFinite(activeBinId)
    ? (activeBinId - intentBin)
    : null;
  const binDelta = Number.isFinite(signedBinDelta) ? Math.abs(signedBinDelta) : null;
  const tolerance = getLiveUpsideTolerance(liveSnapshot, maxDriftPct);
  const directionalPriceExceeded = Number.isFinite(signedPriceDriftPct) && (
    signedPriceDriftPct < (-1 * maxDriftPct) ||
    signedPriceDriftPct > tolerance.allowedUpperPriceDriftPct
  );
  const directionalBinExceeded = Number.isFinite(signedBinDelta) && (
    signedBinDelta < (-1 * FINAL_ENTRY_PROXIMITY_MAX_BIN_DELTA) ||
    signedBinDelta > tolerance.allowedUpperBinDelta
  );
  const hasComparableSignal = Number.isFinite(priceDriftPct) || Number.isFinite(binDelta);

  if (!hasComparableSignal) {
    return {
      ok: false,
      action: 'HOLD',
      reason: 'entry proximity unavailable; waiting fresh live price/bin snapshot',
      currentPrice,
      activeBinId,
      intentPrice,
      intentBin,
      priceDriftPct,
      binDelta,
      comparedBy: 'none',
      snapshotUsableForExecution: executionUsableSnapshot,
      freshLiveSnapshot,
    };
  }

  if (!directionalPriceExceeded && !directionalBinExceeded) {
    return {
      ok: true,
      action: 'ALLOW',
      reason: freshLiveSnapshot
        ? 'entry proximity within live drift guard'
        : 'entry proximity within live drift guard on trusted execution snapshot',
      currentPrice,
      activeBinId,
      intentPrice,
      intentBin,
      priceDriftPct,
      signedPriceDriftPct,
      binDelta,
      signedBinDelta,
      allowedUpperPriceDriftPct: tolerance.allowedUpperPriceDriftPct,
      allowedUpperBinDelta: tolerance.allowedUpperBinDelta,
      bullishFastMoveTolerance: tolerance.bullishFastMove,
      snapshotUsableForExecution: executionUsableSnapshot,
      freshLiveSnapshot,
      comparedBy: Number.isFinite(priceDriftPct) && Number.isFinite(binDelta)
        ? 'price+bin'
        : Number.isFinite(priceDriftPct)
          ? 'price'
          : 'bin',
    };
  }

  const detail = [];
  if (directionalPriceExceeded) {
    if (Number.isFinite(signedPriceDriftPct) && signedPriceDriftPct > 0) {
      detail.push(`upper price drift ${formatPct(priceDriftPct)} > ${tolerance.allowedUpperPriceDriftPct.toFixed(2)}%`);
    } else {
      detail.push(`lower price drift ${formatPct(priceDriftPct)} > ${maxDriftPct.toFixed(2)}%`);
    }
  }
  if (directionalBinExceeded) {
    if (Number.isFinite(signedBinDelta) && signedBinDelta > 0) {
      detail.push(`upper active bin delta ${binDelta} > ${tolerance.allowedUpperBinDelta}`);
    } else {
      detail.push(`lower active bin delta ${binDelta} > ${FINAL_ENTRY_PROXIMITY_MAX_BIN_DELTA}`);
    }
  }
  return {
    ok: false,
    action: 'HOLD',
    reason: `entry proximity drift too wide: ${detail.join(' | ')}`,
    currentPrice,
    activeBinId,
    intentPrice,
    intentBin,
    priceDriftPct,
    signedPriceDriftPct,
    binDelta,
    signedBinDelta,
    allowedUpperPriceDriftPct: tolerance.allowedUpperPriceDriftPct,
    allowedUpperBinDelta: tolerance.allowedUpperBinDelta,
    bullishFastMoveTolerance: tolerance.bullishFastMove,
    snapshotUsableForExecution: executionUsableSnapshot,
    freshLiveSnapshot,
    comparedBy: directionalPriceExceeded && directionalBinExceeded ? 'price+bin' : directionalPriceExceeded ? 'price' : 'bin',
  };
}

function shouldBypassTrustedLpCandleHold({
  meta = {},
  decision = {},
  finalSt = {},
  proximityDecision = {},
} = {}) {
  if (!isTrustedLpWatchMeta(meta)) return false;
  if (!decision || decision.ok) return false;
  if (finalSt?.ok !== true || String(finalSt?.direction || '').toUpperCase() !== 'BULLISH') return false;
  if (proximityDecision?.ok !== true) return false;
  if (proximityDecision?.snapshotUsableForExecution !== true) return false;

  const code = String(decision.code || '').toUpperCase();
  return code === 'STALE' ||
    code === 'M15_STALE' ||
    code === 'VOLUME_LOOKBACK_UNAVAILABLE' ||
    code === 'M15_VOLUME_LOOKBACK_UNAVAILABLE';
}

function clearBullishSupertrendCache(meta = {}, pool = {}) {
  const clearIfBullish = (obj, dirKey, atKey, sourceKey) => {
    if (!obj || typeof obj !== 'object') return;
    const dir = String(obj?.[dirKey] || '').toUpperCase();
    if (dir === 'BULLISH') {
      delete obj[dirKey];
      delete obj[atKey];
      delete obj[sourceKey];
    }
  };

  clearIfBullish(meta, 'finalSupertrend15m', 'finalSupertrend15mAt', 'finalSupertrend15mSource');
  clearIfBullish(meta, 'supertrend15m', 'supertrend15mAt', 'supertrend15mSource');
  clearIfBullish(pool, '_finalSupertrend15m', '_finalSupertrend15mAt', '_finalSupertrend15mSource');
  clearIfBullish(pool, '_supertrend15m', '_supertrend15mAt', '_supertrend15mSource');
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
  const source = String(
    meta.finalSupertrend15mSource ||
    meta.supertrend15mSource ||
    pool?._finalSupertrend15mSource ||
    pool?._supertrend15mSource ||
    'unknown'
  );
  return { direction, at, source };
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
  const liveTrendState = readCanonicalLiveSnapshotTrend(liveSnapshot);
  const liveTrend = readLiveSnapshotTrend(liveSnapshot);
  const liveReliable = isReliableLiveSnapshot(liveSnapshot);
  const liveExecutionUsable = isUsableLiveExecutionSnapshot(liveSnapshot, meta, pool, getConfig(), now);
  const closedM15Reclaim = readClosedM15SupertrendReclaimState(liveSnapshot, getConfig(), now);
  const trustedLpWatch = isTrustedLpWatchMeta(meta);
  const cached = readCachedSupertrend15m(meta, pool);
  const fresh = cached.at > 0 && (now - cached.at) <= ttlMs;
  const cachedSource = String(cached.source || 'unknown');
  const cachedCanonicalBullish = fresh &&
    cached.direction === 'BULLISH' &&
    (cachedSource === 'fresh_fetch' || cachedSource === 'cache:fresh_fetch');
  if (liveSnapshot && liveTrendState.conflicted === true) {
    return {
      ok: false,
      action: 'HOLD',
      reason: `live Supertrend 15m conflict quality=${liveTrendState.qualityTrend} ta=${liveTrendState.taTrend}; waiting canonical confirmation`,
      source: 'live_snapshot',
      direction: 'UNKNOWN',
    };
  }
  // Hard-stop policy: explicit live bearish must always veto entry.
  // This prevents a fresh bearish read from being overridden by cached bullish state.
  if (liveTrend === 'BEARISH') {
    clearBullishSupertrendCache(meta, pool);
    return {
      ok: false,
      action: 'VETO',
      reason: liveReliable
        ? 'live Supertrend 15m bearish from reliable snapshot'
        : 'live Supertrend 15m bearish from snapshot',
      source: 'live_snapshot',
      direction: 'BEARISH',
    };
  }
  if (fresh && cached.direction === 'BEARISH') {
    return {
      ok: false,
      action: 'VETO',
      reason: 'fresh cached Supertrend 15m bearish',
      source: 'cache',
      direction: 'BEARISH',
    };
  }
  if (liveReliable && liveTrend === 'BULLISH') {
    if (!closedM15Reclaim.known) {
      if (trustedLpWatch && liveExecutionUsable) {
        return {
          ok: true,
          action: 'ALLOW',
          reason: 'trusted watch live Supertrend 15m bullish; closed M15 reclaim unavailable but execution snapshot is usable',
          source: 'live_snapshot',
          direction: 'BULLISH',
        };
      }
      return {
        ok: false,
        action: 'HOLD',
        reason: 'closed M15 reclaim above Supertrend unavailable/stale; waiting confirmation',
        source: 'live_snapshot',
        direction: 'BULLISH',
      };
    }
    if (closedM15Reclaim.aboveLine !== true) {
      return {
        ok: false,
        action: 'HOLD',
        reason: `closed M15 candle is still below Supertrend 15m line (${formatPct(closedM15Reclaim.distancePct)}); waiting confirmation`,
        source: 'live_snapshot',
        direction: 'BULLISH',
      };
    }
    if (closedM15Reclaim.freshWindowOk !== true) {
      if (trustedLpWatch && liveExecutionUsable) {
        return {
          ok: true,
          action: 'ALLOW',
          reason: 'trusted watch live Supertrend 15m bullish; closed M15 reclaim not fully confirmed but execution snapshot is usable',
          source: 'live_snapshot',
          direction: 'BULLISH',
        };
      }
      return {
        ok: false,
        action: 'HOLD',
        reason: 'closed M15 reclaim needs at least 2 candles above Supertrend; waiting confirmation',
        source: 'live_snapshot',
        direction: 'BULLISH',
      };
    }
    if (cachedCanonicalBullish) {
      return {
        ok: true,
        action: 'ALLOW',
        reason: 'live Supertrend 15m bullish with fresh closed-M15 reclaim confirmation cache',
        source: 'cache',
        direction: 'BULLISH',
      };
    }
    if (!mint) {
      return {
        ok: false,
        action: 'HOLD',
        reason: 'missing mint for canonical Supertrend 15m confirmation',
        source: 'unknown',
        direction: 'UNKNOWN',
      };
    }
    try {
      const result = await checkFn(mint, currentPrice);
      const direction = normalizeSupertrendDirection(result?.direction);
      if (!result?.veto && direction === 'BULLISH') {
        return {
          ok: true,
          action: 'ALLOW',
          reason: `live Supertrend 15m bullish with canonical reclaim confirmation: ${result.reason || 'fresh Supertrend 15m bullish'}`,
          source: 'fresh_fetch',
          direction: 'BULLISH',
        };
      }
      if (direction === 'BEARISH' || String(result?.reason || '').toUpperCase().includes('BEARISH')) {
        clearBullishSupertrendCache(meta, pool);
        return {
          ok: false,
          action: 'VETO',
          reason: result?.reason || 'fresh Supertrend 15m bearish',
          source: 'fresh_fetch',
          direction: 'BEARISH',
        };
      }
      return {
        ok: false,
        action: 'HOLD',
        reason: result?.reason || 'Supertrend 15m unavailable',
        source: 'fresh_fetch',
        direction: direction || 'UNKNOWN',
      };
    } catch (e) {
      return {
        ok: false,
        action: 'HOLD',
        reason: e?.message || `Supertrend 15m check failed for ${label}`,
        source: 'unknown',
        direction: 'UNKNOWN',
      };
    }
  }
  if (liveSnapshot && liveReliable !== true && liveExecutionUsable !== true) {
    return {
      ok: false,
      action: 'HOLD',
      reason: 'live Supertrend 15m snapshot unreliable; waiting fresh reliable bullish snapshot',
      source: 'live_snapshot',
      direction: liveTrend || 'UNKNOWN',
    };
  }
  if (liveSnapshot && liveReliable === true && liveTrend !== 'BULLISH') {
    return {
      ok: false,
      action: 'HOLD',
      reason: `live Supertrend 15m not bullish (${liveTrend || 'UNKNOWN'}); waiting bullish confirmation`,
      source: 'live_snapshot',
      direction: liveTrend || 'UNKNOWN',
    };
  }

  if (fresh) {
    if (cachedCanonicalBullish) {
      return { ok: true, action: 'ALLOW', reason: 'fresh cached Supertrend 15m bullish', source: 'cache', direction: 'BULLISH' };
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
  const { meta = {}, pool = {}, now = Date.now() } = args || {};
  if (decision.direction === 'BULLISH' || decision.direction === 'BEARISH') {
    const stampDirection = decision.direction;
    const stampAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const stampSource = decision.source === 'cache' ? 'cache:fresh_fetch' : String(decision.source || 'unknown');
    if (meta && typeof meta === 'object') {
      meta.finalSupertrend15m = stampDirection;
      meta.finalSupertrend15mAt = stampAt;
      meta.finalSupertrend15mSource = stampSource;
      meta.supertrend15m = stampDirection;
      meta.supertrend15mAt = stampAt;
      meta.supertrend15mSource = stampSource;
    }
    if (pool && typeof pool === 'object') {
      pool._finalSupertrend15m = stampDirection;
      pool._finalSupertrend15mAt = stampAt;
      pool._finalSupertrend15mSource = stampSource;
      pool._supertrend15m = stampDirection;
      pool._supertrend15mAt = stampAt;
      pool._supertrend15mSource = stampSource;
    }
  }
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
        `m15MinRatio=${Number(diag.entryM15MinVolumeRatio ?? cfg.entryM15MinVolumeRatio ?? 0.7).toFixed(3)} ` +
        `reclaimState=${String(diag.m15ReclaimWindowState ?? diag.m15ReclaimTimingState ?? 'UNKNOWN')} ` +
        `staleWarn=${diag.m15ReclaimStaleWarning === true ? 'yes' : 'no'}`
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
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const trustedLpWatch = isTrustedLpWatchMeta(meta);
  const trendUnknown = signals.trend === 'UNKNOWN';
  const trendBearish = signals.trend === 'BEARISH';
  const trendFresh = signals.trendSource === 'live';
  const liveTrendKnown = signals.trendSource === 'live' && signals.trend !== 'UNKNOWN';

  let decision = 'DEPLOY';
  let reason = '';
  const liveTrend = readLiveSnapshotTrend(liveSnapshot);
  const liveReliable = isReliableLiveSnapshot(liveSnapshot);

  if (lpMode) {
    if (signals.liveTrendConflicted) {
      decision = 'HOLD';
      reason = 'HOLD: trend conflict; waiting canonical confirmation';
    } else if (meta.taTrendConflicted === true) {
      decision = 'HOLD';
      reason = 'HOLD: trend conflict; waiting canonical confirmation';
    } else if ((liveReliable && liveTrend === 'BEARISH') || trendBearish) {
      decision = 'DROP';
      reason = liveReliable && liveTrend === 'BEARISH'
        ? 'Supertrend 15m bearish (live_snapshot)'
        : `Supertrend 15m bearish (${signals.trendSource})`;
    } else if (trendUnknown) {
      decision = 'HOLD';
      reason = 'HOLD: live trend unknown; waiting fresh live confirmation';
    } else if (!liveReliable) {
      decision = 'HOLD';
      reason = 'HOLD: live snapshot unreliable; waiting fresh reliable live confirmation';
    } else if (!trendFresh) {
      decision = 'HOLD';
      reason = 'HOLD: trend stale; waiting fresh live trend';
    } else if (signals.trend !== 'BULLISH') {
      decision = 'HOLD';
      reason = 'HOLD: live trend not bullish; waiting fresh live confirmation';
    } else if (!liveTrendKnown) {
      decision = 'HOLD';
      reason = 'HOLD: live trend unknown; waiting fresh live confirmation';
    } else if (trustedLpWatch) {
      reason = `Trusted WATCH prepared (${signals.trendSource})`;
    }
  } else if (timingState !== 'BREAKOUT') {
    decision = 'HOLD';
    reason = `Timing belum fresh: ${timingState || 'UNKNOWN'}`;
  }

  return {
    ...signals,
    lpMode,
    entryDecisionMode: decisionMode,
    m5HardGateEnabled: cfg?.entryM5HardGateEnabled !== false,
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
  const signalStDistancePct = Number(meta.signalStDistancePct);
  const freshBreakoutConfirmed = meta.freshBreakoutConfirmed === true;
  const momentumAlive = meta.momentumAlive === true;
  const trustedLpWatch = isTrustedLpWatchMeta(meta);

  if (meta.isRetest || meta.isScoutDefer) return false;
  if (lpMode) {
    if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK' && timingState !== 'MOMENTUM_ALIVE') return false;
    if (taTrend === 'BEARISH') return false;
    if (!trustedLpWatch && taTrend !== 'BULLISH') return false;
    if (trustedLpWatch && taTrend !== 'BULLISH' && !isFreshBullishSupertrend15m(meta, {}, Date.now(), FINAL_ST_CACHE_TTL_MS)) {
      return false;
    }
    if (timingState === 'MOMENTUM_ALIVE') {
      if (!momentumAlive) return false;
    } else if (!freshBreakoutConfirmed) {
      return false;
    }
  } else if (timingState !== 'BREAKOUT') {
    return false;
  }
  if (readiness !== 'HIGH') return false;
  if (breakoutQuality !== 'VALID' && breakoutQuality !== 'STRONG') return false;
  if (taTrend === 'BEARISH') return false;
  if (taTrend && taTrend !== 'BULLISH' && !trustedLpWatch) return false;
  if (lpMode && !trustedLpWatch && Number.isFinite(signalStDistancePct) && signalStDistancePct <= 0) {
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
  const canonicalMeta = readCanonicalEntryMeta(meta, { snapshotAt: entry.enqueuedAt });
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
      activeSignals = liveSignals;
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
    ? Math.max(180, Number(canonicalMeta.watchWindowSec || cfg.entryFreshWatchWindowSec || 180))
    : Math.max(5, Number(canonicalMeta.watchWindowSec || cfg.entryFreshWatchWindowSec || 90));
  const maxDriftPct = lpMode
    ? Math.max(8, Number(canonicalMeta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 8))
    : Math.max(0.1, Number(canonicalMeta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 2.5));
  const snapshotAt = Number(canonicalMeta.snapshotAt || entry.enqueuedAt || 0);
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
  const snapshotPrice = Number(canonicalMeta.snapshotPrice || 0);
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
    const tokenScope = {
      symbol: entry?.symbol || mint?.slice(0, 8) || 'UNKNOWN',
      pool: entry?.pool || null,
      poolAddress: getPoolAddress(entry?.pool) || '',
      attemptId: '',
    };

    // Outer try-catch: satu token gagal tidak boleh crash loop keseluruhan
    try {
      // Re-check: mungkin sudah dihapus oleh caller lain
      if (!_queue.has(mint)) continue;

      const { symbol, pool, meta } = entry;
      tokenScope.symbol = symbol || tokenScope.symbol;
      tokenScope.pool = pool || tokenScope.pool;
      const isRetest = meta?.isRetest || meta?.isScoutDefer;
      const queueType = isRetest ? 'RETEST' : 'DEPLOY';
      const deferUntil = Number(entry.nextEligibleAt || 0);
      if (deferUntil > Date.now()) {
        continue;
      }

      const poolAddress = getPoolAddress(pool);
      tokenScope.poolAddress = poolAddress || tokenScope.poolAddress;

      if (isDeploySlotSaturated()) {
        console.log(
          `[QUEUE] 🫥 Slot saturated, suppressing hold/drop noise for ${symbol} ` +
          `pool=${getPoolAddress(pool).slice(0, 8) || 'unknown'}`
        );
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

      const finalLiveSnapshot = await getDeployQueueLiveSnapshot(
        mint,
        poolAddress || null,
        symbol,
        {
          includeEntryCandles5m: false,
          bypassCache: true,
        }
      );
      if (!finalLiveSnapshot) {
        entry.nextEligibleAt = Date.now() + 15_000;
        entry.deferReason = 'Final snapshot unavailable; waiting fresh market snapshot';
        console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: Final snapshot unavailable; waiting fresh market snapshot`);
        logSilentFinalDeployHold({
          symbol,
          mint,
          poolAddress,
          reason: 'Final snapshot unavailable; waiting fresh market snapshot',
          stage: 'final_snapshot_unavailable',
        });
        continue;
      }
      if (!isReliableLiveSnapshot(finalLiveSnapshot)) {
        const executionUsable = isUsableLiveExecutionSnapshot(finalLiveSnapshot, meta, pool, getConfig(), Date.now());
        if (!executionUsable) {
          entry.nextEligibleAt = Date.now() + 15_000;
          entry.deferReason = 'Final snapshot unreliable; waiting reliable live snapshot';
          console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: Final snapshot unreliable; waiting reliable live snapshot`);
          logSilentFinalDeployHold({
            symbol,
            mint,
            poolAddress,
            reason: 'Final snapshot unreliable; waiting reliable live snapshot',
            stage: 'final_snapshot_unreliable',
          });
          continue;
        }
        console.log(
          `[QUEUE] ⚠️ ${symbol} live snapshot unreliable for trend history but usable for final execution price/bin; ` +
          `continuing with canonical ST check and proximity guard`
        );
      }
      if (pool && typeof pool === 'object') {
        pool._marketSnapshot = finalLiveSnapshot;
      }
      entry.lastLiveSnapshot = finalLiveSnapshot;

      const currentPrice = Number(
        finalLiveSnapshot?.ohlcv?.currentPrice ||
        finalLiveSnapshot?.price?.currentPrice ||
        pool?._entrySignals?.currentPrice ||
        meta?.currentPrice ||
        pool?.price ||
        pool?.pool_price ||
        0
      );
      const finalSt = await ensureFinalSupertrendBullish({
        mint,
        symbol,
        pool,
        meta,
        liveSnapshot: finalLiveSnapshot,
        currentPrice,
      });
      if (!finalSt.ok) {
        if (finalSt.action === 'VETO') {
          removeQueueCandidate(mint, entry);
          if (!isDeploySlotSaturated()) {
            await safeSend(
              `❌ <b>Deploy Queue Drop</b>\n` +
              `<b>${symbol}</b>\n` +
              `ST 15m: <code>${finalSt.direction || 'UNKNOWN'}</code> (<code>${finalSt.source}</code>)\n` +
              `<i>${escapeHTML(finalSt.reason)}</i>`
            );
          }
        } else {
          entry.nextEligibleAt = Date.now() + 15_000;
          entry.deferReason = finalSt.reason;
          console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: ${finalSt.reason}`);
          logSilentFinalDeployHold({
            symbol,
            mint,
            poolAddress,
            reason: finalSt.reason,
            stage: 'final_supertrend_hold',
          });
        }
        continue;
      }

      let liveSnapshotForDeploy = entry.lastLiveSnapshot || null;
      liveSnapshotForDeploy = finalLiveSnapshot;
      let proximityDecision = getFinalEntryProximityDecision({
        meta,
        pool,
        liveSnapshot: liveSnapshotForDeploy,
        now: Date.now(),
      });
      if (!proximityDecision.ok) {
        entry.nextEligibleAt = Date.now() + 15_000;
        entry.deferReason = proximityDecision.reason;
        console.log(
          `[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: ${proximityDecision.reason} ` +
          `intentPrice=${Number.isFinite(proximityDecision.intentPrice) ? Number(proximityDecision.intentPrice).toFixed(10) : 'na'} ` +
          `livePrice=${Number.isFinite(proximityDecision.currentPrice) ? Number(proximityDecision.currentPrice).toFixed(10) : 'na'} ` +
          `priceDrift=${Number.isFinite(proximityDecision.priceDriftPct) ? `${Number(proximityDecision.priceDriftPct).toFixed(2)}%` : 'na'} ` +
          `intentBin=${Number.isFinite(proximityDecision.intentBin) ? proximityDecision.intentBin : 'na'} ` +
          `liveBin=${Number.isFinite(proximityDecision.activeBinId) ? proximityDecision.activeBinId : 'na'} ` +
          `binDelta=${Number.isFinite(proximityDecision.binDelta) ? proximityDecision.binDelta : 'na'}`
        );
        logSilentFinalDeployHold({
          symbol,
          mint,
          poolAddress,
          reason: proximityDecision.reason,
          stage: 'final_proximity_hold',
        });
        continue;
      }

      const finalCandle = await ensureFinalEntryCandleSanity({
        mint,
        symbol,
        pool,
        meta,
        liveSnapshot: finalLiveSnapshot,
      });
      if (!finalCandle.ok) {
        if (shouldBypassTrustedLpCandleHold({
          meta,
          decision: finalCandle,
          finalSt,
          proximityDecision,
        })) {
          console.log(
            `[QUEUE] ⚠️ ${symbol} bypass final candle HOLD for trusted LP watch ` +
            `reason=${finalCandle.reason} proximity=${proximityDecision.comparedBy || 'na'}`
          );
        } else {
          entry.nextEligibleAt = Date.now() + 15_000;
          entry.deferReason = finalCandle.reason;
          console.log(`[QUEUE] ⏸️ ${symbol} HOLD sebelum deploy: ${finalCandle.reason}`);
          if (isSlotSaturationHoldReason(finalCandle.reason) || isDeploySlotSaturated()) {
            continue;
          }
          logSilentFinalDeployHold({
            symbol,
            mint,
            poolAddress,
            reason: finalCandle.reason,
            stage: 'final_candle_hold',
          });
          continue;
        }
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
      const canonicalMeta = readCanonicalEntryMeta(meta);
      const intentBin = Number.isFinite(Number(canonicalMeta.entryActiveBin)) ? Number(canonicalMeta.entryActiveBin) : null;
      const intentPrice = Number.isFinite(Number(canonicalMeta.entryPrice)) ? Number(canonicalMeta.entryPrice) : null;
      const intentSnapshotAt = Number.isFinite(Number(canonicalMeta.snapshotAt)) ? Number(canonicalMeta.snapshotAt) : null;
      const intentMaxAgeSec = Math.max(30, Number(canonicalMeta.watchWindowSec || cfg.entryFreshWatchWindowSec || 180) || 180);
      const frozenEnabled = meta?.hasFrozenEntryIntent === true && hasValidFrozenDeployIntent({
        entryActiveBin: intentBin,
        entryPrice: intentPrice,
        snapshotAt: intentSnapshotAt,
        maxAgeSec: intentMaxAgeSec,
      });
      const deployIntentBin = frozenEnabled ? intentBin : null;
      const deployIntentPrice = frozenEnabled ? intentPrice : null;
      const deployIntentSnapshotAt = frozenEnabled ? intentSnapshotAt : null;
      console.log(
        `[QUEUE] 🚀 Attempting deploy for ${symbol} ` +
        `decision=${decision} trend=${check.liveTrend || 'UNKNOWN'} (${check.trendSource || 'unknown'}) ` +
        `m5=${formatPct(check.liveM5)} (${check.m5Source || 'unknown'}) ` +
        `proximity=${proximityDecision.comparedBy || 'na'} ` +
        `drift=${Number.isFinite(proximityDecision.priceDriftPct) ? `${Number(proximityDecision.priceDriftPct).toFixed(2)}%` : 'na'} ` +
        `binDelta=${Number.isFinite(proximityDecision.binDelta) ? proximityDecision.binDelta : 'na'} ` +
        `intent=${frozenEnabled ? 'FROZEN' : 'LIVE'} ` +
        `intentBin=${Number.isFinite(deployIntentBin) ? deployIntentBin : 'na'} ` +
        `intentPrice=${Number.isFinite(deployIntentPrice) ? deployIntentPrice.toFixed(10) : 'na'} ` +
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
      const attemptId = buildDeployAttemptId({ mint, poolAddress });
      tokenScope.attemptId = attemptId;

      try {
        logDeployAttemptOutcome({
          attemptId,
          status: 'STARTED',
          symbol,
          poolAddress,
          message: `decision=${decision} amount=${solAmount}`,
        });
        await safeSend(buildDeployTriggeredTelegramMessage({
          symbol,
          attemptId,
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

        const deployTimeoutMs = Number(cfg.deployTimeoutMs || 180_000);
        const result = await withTimeout(_deployFn(poolAddress, {
          hasNonRefundableFees:
            pool?._marketSnapshot?.pool?.hasNonRefundableFees ??
            pool?.hasNonRefundableFees ??
            meta?.hasNonRefundableFees ??
            false,
          finalTrendStamp: {
            direction: finalSt.direction || 'UNKNOWN',
            source: finalSt.source || 'unknown',
            reason: finalSt.reason || '',
            checkedAt: Date.now(),
          },
          entryCanonicalSnapshot: meta?.entryCanonicalSnapshot && typeof meta.entryCanonicalSnapshot === 'object'
            ? {
              ...meta.entryCanonicalSnapshot,
              finalTrendStamp: {
                direction: finalSt.direction || 'UNKNOWN',
                source: finalSt.source || 'unknown',
                reason: finalSt.reason || '',
                checkedAt: Date.now(),
              },
            }
            : null,
          frozenEntryIntent: {
            entryActiveBin: deployIntentBin,
            entryPrice: deployIntentPrice,
            snapshotAt: deployIntentSnapshotAt,
            enabled: frozenEnabled,
            binStep: Number(entry?.pool?.binStep || pool?.binStep || 0),
            maxDriftPct: Number(meta?.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 8),
            // Keep frozen intent as an optimization, but allow safe live fallback
            // when anchor drift makes the frozen snapshot unusable.
            required: false,
          },
        }), deployTimeoutMs, 'DEPLOY_QUEUE');

        const classifiedResult = classifyDeployAttemptResult(result);

        if (classifiedResult.status === 'DRY_RUN') {
          logDeployAttemptOutcome({
            attemptId,
            status: 'DRY_RUN',
            symbol,
            poolAddress,
            message: 'queue deploy simulation completed',
          });
          await safeSend(
            `🧪 <b>Dry-run (Queue Deploy)</b>\n` +
            `<b>${symbol}</b> — Simulasi selesai, tidak ada tx real.\n` +
            `Range: <code>${result.rangeMin}–${result.rangeMax}</code>`
          );
          continue;
        }
        if (classifiedResult.status === 'BLOCKED') {
          const blockedReason = String(classifiedResult.reason || 'DEPLOY_BLOCKED');
          logDeployAttemptOutcome({
            attemptId,
            status: 'BLOCKED',
            symbol,
            poolAddress,
            message: blockedReason,
          });
          const blockedByRent = String(result.reason || '').includes('VETO_NON_REFUNDABLE_RENT');
          const blockedByBalance = blockedReason.includes('INSUFFICIENT_SOL_BALANCE');
          const blockedByInvalidInput = blockedReason.includes('INVALID_DLMM_DEPLOY_ARGS') ||
            blockedReason.includes('anchorErrorCode":6002') ||
            blockedReason.includes('anchorErrorHex":"0x1772') ||
            blockedReason.includes('InvalidInput');
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
            if (holdNotice.shouldSend && !isDeploySlotSaturated()) {
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
          if (blockedByInvalidInput) {
            const holdCooldownSec = Math.max(60, Number(cfg.deployQueueHoldNotifyCooldownSec) || 180);
            const holdNotice = shouldSendDeployQueueHoldNotification({
              poolAddress,
              mint,
              reason: 'HOLD: DLMM invalid input during simulation',
              now: Date.now(),
              cooldownMs: holdCooldownSec * 1000,
            });
            entry.attempts = Math.max(0, entry.attempts - 1);
            entry.nextEligibleAt = Date.now() + holdCooldownSec * 1000;
            _queue.set(mint, entry);
            if (holdNotice.shouldSend && !isDeploySlotSaturated()) {
              await safeSend(
                `⏸️ <b>Deploy Queue Hold</b>\n` +
                `<b>${symbol}</b> — <code>DLMM_INVALID_INPUT</code>\n` +
                `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
                (result.detail ? `Detail: <code>${escapeHTML(String(result.detail).slice(0, 240))}</code>\n` : '') +
                `<i>Simulasi DLMM menolak input. Queue akan cek ulang otomatis setelah ${holdCooldownSec}s.</i>`
              );
            }
            continue;
          }
          await safeSend(
            buildDeployFinalOutcomeTelegramMessage({
              symbol,
              attemptId,
              poolAddress,
              outcome: 'BLOCKED',
              reason: blockedReason,
              detail: result.detail || '',
            }) +
            (
              Number.isFinite(Number(result.rangeMin)) && Number.isFinite(Number(result.rangeMax))
                ? `\nRange: <code>${result.rangeMin}-${result.rangeMax}</code> (max ${result.rangeMaxBins ?? 'n/a'} bin)`
                : ''
            ) +
            (
              blockedByRent
                ? `\n<i>Adjust range gagal untuk pool/range ini. Pool lain tetap normal.</i>`
                : `\n<i>Queue menghormati veto deploy.</i>`
            )
          );
          continue;
        }

        if (classifiedResult.status === 'UNKNOWN_RECONCILE') {
          logDeployAttemptOutcome({
            attemptId,
            status: 'UNKNOWN',
            symbol,
            poolAddress,
            message: `unexpected deploy result type=${typeof result}`,
            error: true,
          });
          await safeSend(
            buildDeployFinalOutcomeTelegramMessage({
              symbol,
              attemptId,
              poolAddress,
              outcome: 'RECONCILE',
              reason: 'DEPLOY_RESULT_UNKNOWN_RECONCILE',
            })
          );
          continue;
        }

        const positionPubkey = classifiedResult.positionPubkey || null;
        logDeployAttemptOutcome({
          attemptId,
          status: 'SUCCESS',
          symbol,
          poolAddress,
          message: `position=${positionPubkey ? positionPubkey.slice(0, 8) : 'unknown'}`,
        });
        await safeSend(
          buildDeployFinalOutcomeTelegramMessage({
            symbol,
            attemptId,
            poolAddress,
            outcome: 'SUCCESS',
            positionPubkey: positionPubkey || '',
          })
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
        const sym = tokenScope.symbol || entry?.symbol || mint?.slice(0, 8) || 'UNKNOWN';
        const isTimeout = String(tokenErr?.message || '').includes('DEPLOY_QUEUE_TIMEOUT_');
        const failedPoolAddress = tokenScope.poolAddress || getPoolAddress(tokenScope.pool) || '';
        const failedAttemptId = typeof tokenScope.attemptId === 'string' && tokenScope.attemptId
          ? tokenScope.attemptId
          : buildDeployAttemptId({ mint, poolAddress: failedPoolAddress });
        logDeployAttemptOutcome({
          attemptId: failedAttemptId,
          status: isTimeout ? 'TIMEOUT' : 'FAILED',
          symbol: sym,
          poolAddress: failedPoolAddress,
          message: tokenErr.message,
          error: true,
        });
        removeQueueCandidate(mint, entry); // Buang dari queue agar tidak retry tanpa batas
        const timeoutNote = isTimeout
          ? `\n<i>Deploy queue timeout. Perlu reconcile/manual check sebelum retry.</i>`
          : '';
        const failureStatus = isTimeout ? 'TIMEOUT' : 'FAILED';
        await safeSend(
          `❌ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${sym}</b>\n` +
          `Attempt ID: <code>${failedAttemptId}</code>\n` +
          `Status: <code>${failureStatus}</code>\n` +
          `Pool: <code>${String(failedPoolAddress || 'unknown').slice(0, 8)}</code>\n` +
          `Reason: <code>${escapeHTML(tokenErr.message).slice(0, 200)}</code>${timeoutNote}\n` +
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
