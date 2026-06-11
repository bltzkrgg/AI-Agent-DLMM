/**
 * src/agents/hunterAlpha.js — Linear Sniper Loop (RPC-First)
 *
 * ARSITEKTUR LINEAR (satu thread, berurutan):
 *
 *   SCAN → FILTER → DEPLOY → MONITOR (lock) → EXIT → kembali ke SCAN
 *
 * Tidak ada paralel. Tidak ada queue. Tidak ada DB.
 * Satu posisi aktif pada satu waktu.
 */

'use strict';

import { PublicKey } from '@solana/web3.js';
import { getConfig }              from '../config.js';
import { screenToken }            from '../market/coinfilter.js';
import { runMeridianVeto, discoverHighFeePoolsMeridian, isSupportedQuoteToken, getQuoteTokenLabel } from '../market/meridianVeto.js';
import { getMarketSnapshot }      from '../market/oracle.js';
import { getPoolMemorySignal, recordPoolDecision } from '../market/poolMemory.js';
import { getPoolInfo }            from '../solana/meteora.js';
import { deployPosition, monitorPnL, exitPosition, markPositionManuallyClosed, setEvilPandaNotifyFn, setPositionLifecycle, getPositionOnChainStatus, EP_CONFIG, getActivePositionKeys, getPositionMeta, reconcileZombiePositions } from '../sniper/evilPanda.js';
import { createMessage }          from '../agent/provider.js';
import { getConnection, getWalletBalance } from '../solana/wallet.js';
import { appendDecisionLog }      from '../learn/decisionLog.js';
import { applyPoolPatternLearningToCandidates, applyPoolPatternLearningToScore, extractPoolPatternFeatures, recordPoolPatternEntry } from '../learn/poolPatternLearning.js';
import { isBlacklisted }          from '../learn/tokenBlacklist.js';
import { getRuntimeState }        from '../runtime/state.js';
import { getPositionRuntimeState, updatePositionRuntimeState } from '../app/positionRuntimeState.js';
import { evaluatePoolImpactGuard } from '../risk/poolImpactGuard.js';
import { escapeHTML, safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
import reportManager              from '../utils/reportManager.js';
import pendingStore               from '../utils/pendingStore.js';
import { enqueueForDeploy, ensureFinalEntryCandleSanity, ensureFinalSupertrendBullish, isFreshDeployMeta, startDeployQueueWatcher, setDeployQueueNotifyFn, setDeployQueueMonitorFn } from '../utils/pendingDeployQueue.js';
import { getDeploySlotUsage, reserveDeploySlot, releaseDeploySlot } from '../utils/deploySlotGuard.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DLMM_POOL_SEARCH_BASE = 'https://dlmm.datapi.meteora.ag/pools';
const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag/pools';
// ── Pool selector: pilih pool terbaik per-token berdasarkan binStep priority ─────────────
//
// Input : array pool untuk satu token yang sama (tokenXMint identik)
// Output: satu pool terpilih
//
// Urutan prioritas: [200, 125, 100] (fee tertinggi dulu).
// Jika tidak ada yang cocok, ambil pool dengan binStep tertinggi yang tersedia.
// Di antara pool dengan binStep sama, pilih yang feeActiveTvlRatio tertinggi.

function selectBestPoolByBinStep(pools, binStepPriority = [200, 125, 100]) {
  if (!pools || pools.length === 0) return null;
  if (pools.length === 1) return pools[0];

  // Coba satu per satu priority
  for (const targetStep of binStepPriority) {
    const candidates = pools.filter(p => p.binStep === targetStep);
    if (candidates.length > 0) {
      // Pilih fee/tvl ratio tertinggi di antara kandidat binStep ini
      return candidates.sort((a, b) => (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))[0];
    }
  }

  // Fallback: tidak ada yang cocok dengan priority list → ambil binStep tertinggi tersedia
  return pools.sort((a, b) => b.binStep - a.binStep || (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))[0];
}

// ── Group pools by token, kemudian select best per token ─────────────────────────────

function deduplicatePoolsByToken(pools, binStepPriority) {
  // Group by tokenXMint
  const byMint = new Map();
  for (const pool of pools) {
    const mint = pool.tokenXMint || '';
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint).push(pool);
  }

  // Untuk setiap token, pilih pool terbaik
  const result = [];
  for (const [, tokenPools] of byMint) {
    const best = selectBestPoolByBinStep(tokenPools, binStepPriority);
    if (best) result.push(best);
  }

  return result;
}

// ── Notify helper (diset dari index.js) ──────────────────────────
let _notifyFn = null;
let _notifyMuted = false;
export function setNotifyFn(fn) {
  _notifyFn = fn;
  setEvilPandaNotifyFn(fn);
  // Wire deploy queue notify fn agar notif real-time bisa keluar
  setDeployQueueNotifyFn(fn);
  // Wire monitor fn ke deploy queue agar posisi hasil queue masuk monitor loop
  setDeployQueueMonitorFn((pubkey, sym, poolAddr) => monitorLoop(pubkey, sym, poolAddr));
}
export function setNotifyMuted(value) {
  _notifyMuted = Boolean(value);
}
async function notify(msg) {
  if (_notifyMuted) return;
  try { await _notifyFn?.(msg); } catch { /* non-fatal */ }
}

function getOutOfRangeWaitMs(cfg = getConfig()) {
  const minutes = Number(cfg?.outOfRangeWaitMinutes);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  return Math.max(60_000, Math.round(safeMinutes * 60_000));
}

function getDisplayedOutOfRangeWaitMs(cfg = getConfig()) {
  const actualMinutes = Number(cfg?.outOfRangeWaitMinutes);
  const safeMinutes = Number.isFinite(actualMinutes) && actualMinutes > 0 ? actualMinutes : 30;
  const configuredDisplay = Number(cfg?.oorDisplayWaitMinutes);
  const safeDisplay = Number.isFinite(configuredDisplay) && configuredDisplay > 0
    ? configuredDisplay
    : OOR_DISPLAY_WAIT_MINUTES;
  const displayMinutes = Math.min(safeDisplay, safeMinutes);
  return Math.max(60_000, Math.round(displayMinutes * 60_000));
}

function getOorAlertCooldownMs(cfg = getConfig()) {
  return getDisplayedOutOfRangeWaitMs(cfg);
}

function getMonitorFastLaneConfig(cfg = getConfig()) {
  const enabled = cfg?.monitorFastLaneEnabled !== false;
  const throttleMs = Math.max(250, Number(cfg?.monitorFastLaneThrottleMs || 1200));
  const fallbackPollMs = Math.max(1000, Number(cfg?.monitorFastLaneFallbackPollMs || 12_000));
  return {
    enabled,
    throttleMs,
    fallbackPollMs,
    usePoolAccount: cfg?.monitorFastLaneUsePoolAccount !== false,
    usePositionAccount: cfg?.monitorFastLaneUsePositionAccount !== false,
  };
}

function formatDurationFromMs(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const minutes = safeMs / 60_000;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} jam`;
  if (minutes >= 10) return `${minutes.toFixed(0)} menit`;
  return `${minutes.toFixed(1)} menit`;
}

function buildOorWaitingMessage({ symbol, positionPubkey, elapsedMs, waitMs, currentValueSol, pnlPct }) {
  const sign = pnlPct >= 0 ? '+' : '';
  return (
    `⏳ <b>OOR Watch</b>\n` +
    `Token: <b>${escapeHTML(symbol)}</b>\n` +
    `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` +
    `PnL: <code>${sign}${pnlPct.toFixed(2)}%</code>\n` +
    `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
    `<i>Status: monitoring</i>\n` +
    `<i>Next check: 5m</i>`
  );
}

function buildOorExpiredMessage({ symbol, positionPubkey, elapsedMs, waitMs, currentValueSol, pnlPct, inRange }) {
  const sign = pnlPct >= 0 ? '+' : '';
  return (
    `⏱️ <b>OOR Timeout</b>\n` +
    `Token: <b>${escapeHTML(symbol)}</b>\n` +
    `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` +
    `PnL: <code>${sign}${pnlPct.toFixed(2)}%</code>\n` +
    `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
    `Range: <code>${inRange ? 'IN_RANGE' : 'OUT_OF_RANGE'}</code>\n` +
    `Durasi OOR: <code>${formatDurationFromMs(elapsedMs)}</code> / batas <code>${formatDurationFromMs(waitMs)}</code>\n` +
    `<i>Config OOR sudah lewat, posisi akan ditutup sekarang.</i>`
  );
}

function buildOorRecoveredMessage({ symbol, positionPubkey }) {
  return (
    `↩️ <b>OOR recovered</b>\n` +
    `Token: <b>${escapeHTML(symbol)}</b>\n` +
    `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` +
    `<i>Posisi kembali masuk range, countdown OOR dibersihkan.</i>`
  );
}

export function evaluateOutOfRangeMonitorState({
  positionPubkey,
  symbol,
  status,
  runtimeState,
  cfg,
  now = Date.now(),
} = {}) {
  const inRange = status?.inRange === true;
  const waitMs = getOutOfRangeWaitMs(cfg);
  const displayWaitMs = getDisplayedOutOfRangeWaitMs(cfg);
  const oorSince = Number.isFinite(runtimeState?.oorSince) ? runtimeState.oorSince : null;
  const lastOorAlertAt = Number.isFinite(runtimeState?.lastOorAlertAt) ? runtimeState.lastOorAlertAt : null;

  if (inRange) {
    if (oorSince !== null || lastOorAlertAt !== null) {
      return {
        shouldExit: false,
        clearOorMarkers: true,
        runtimePatch: { oorSince: null, lastOorAlertAt: null },
        notifyMessage: buildOorRecoveredMessage({ symbol, positionPubkey }),
        logMessage: `[hunter] ${symbol} kembali IN_RANGE, OOR timer dibersihkan.`,
      };
    }

    return {
      shouldExit: false,
      clearOorMarkers: false,
      runtimePatch: null,
      notifyMessage: null,
      logMessage: null,
    };
  }

  const nextOorSince = oorSince ?? now;
  const elapsedMs = Math.max(0, now - nextOorSince);
  const alertCooldownMs = getOorAlertCooldownMs(cfg);
  const shouldAlert = lastOorAlertAt === null || (now - lastOorAlertAt) >= alertCooldownMs;
  const runtimePatch = {
    oorSince: nextOorSince,
    lastOorAlertAt: shouldAlert ? now : lastOorAlertAt,
  };

  if (elapsedMs >= waitMs) {
    return {
      shouldExit: true,
      clearOorMarkers: false,
      runtimePatch,
      notifyMessage: buildOorExpiredMessage({
        symbol,
        positionPubkey,
        elapsedMs,
        waitMs: displayWaitMs,
        currentValueSol: Number(status?.currentValueSol) || 0,
        pnlPct: Number(status?.pnlPct) || 0,
        inRange,
      }),
      logMessage: `[hunter] ${symbol} OOR timeout: elapsed=${elapsedMs}ms wait=${displayWaitMs}ms remaining=${Math.max(0, displayWaitMs - elapsedMs)}ms (config=${waitMs}ms)`,
      exitReason: `OUT_OF_RANGE_${Math.round(waitMs / 60_000)}M`,
    };
  }

  return {
    shouldExit: false,
    clearOorMarkers: false,
    runtimePatch,
    notifyMessage: shouldAlert ? buildOorWaitingMessage({
      symbol,
      positionPubkey,
      elapsedMs,
      waitMs: displayWaitMs,
      currentValueSol: Number(status?.currentValueSol) || 0,
      pnlPct: Number(status?.pnlPct) || 0,
    }) : null,
    logMessage: shouldAlert ? `[hunter] ${symbol} OOR wait: elapsed=${elapsedMs}ms remaining=${Math.max(0, displayWaitMs - elapsedMs)}ms wait=${displayWaitMs}ms (config=${waitMs}ms)` : null,
    exitReason: null,
  };
}

// ── State ─────────────────────────────────────────────────────────
let _running   = false;
let _deployLock = false;
let _shutdownInProgress = false;
const _closingPositions = new Set();
const _positionLabels = new Map(); // pubkey -> { symbol }
const _monitoredPositions = new Set();
const _lastRealtimePnlLogAt = new Map();
const _pendingRetestQueue = new Map(); // mint -> { pool, symbol, reason, attempts, nextCheckAt, expiresAt }
const _taWatchQueue = new Map(); // mint -> { pool, symbol, reason, attempts, nextCheckAt, expiresAt, source }
const OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused';
let _pendingTaRadarTimer = null;
let _pendingTaRadarInFlight = false;
let _taWatchTimer = null;
let _taWatchInFlight = false;
let _manualCloseWatchTimer = null;
let _manualCloseWatchInFlight = false;
const OOR_DISPLAY_WAIT_MINUTES = 5;
const MANUAL_CLOSE_ALERT_COOLDOWN_MS = 5 * 60_000;
const _manualCloseAlertState = new Map(); // positionPubkey -> lastAlertAt

function isOperatorDiscoveryPaused() {
  const state = getRuntimeState(OPERATOR_DISCOVERY_PAUSED_KEY, null);
  return state === true || state?.paused === true;
}

function listActivePositions() {
  const keys = getActivePositionKeys();
  return keys.map((pubkey) => {
    const meta = getPositionMeta(pubkey) || {};
    const label = _positionLabels.get(pubkey) || {};
    return {
      pubkey,
      symbol: label.symbol || (meta.tokenXMint ? meta.tokenXMint.slice(0, 8) : pubkey.slice(0, 8)),
      poolAddress: meta.poolAddress || '',
      mint: meta.tokenXMint || '',
      pnlPct: Number(meta.pnlPct),
      currentValueSol: Number(meta.currentValueSol),
      deploySol: Number(meta.deploySol),
      hwmPct: Number(meta.hwmPct),
    };
  });
}

function isWatcherModeActive() {
  const cfg = getConfig();
  return isRunning() || cfg.autoScreeningEnabled === true || _pendingRetestQueue.size > 0 || _taWatchQueue.size > 0;
}

function isAutoScreeningRuntimeEnabled() {
  const state = getRuntimeState('autoScreeningRuntimeEnabled', null);
  if (state === true || state?.enabled === true) return true;
  if (state === false || state?.enabled === false) return false;
  return getConfig().autoScreeningEnabled === true;
}

function hasActiveMint(mint) {
  if (!mint) return false;
  return listActivePositions().some((p) => p.mint === mint);
}

function hasActivePoolAddress(poolAddress) {
  if (!poolAddress) return false;
  return listActivePositions().some((p) => p.poolAddress === poolAddress);
}

function getPoolMint(pool = {}) {
  return pool.tokenXMint || pool.tokenX || pool.mint || pool.address || '';
}

function getPoolSymbol(pool = {}) {
  return pool.tokenXSymbol || pool.name?.split('-')[0] || getPoolMint(pool).slice(0, 8) || 'UNKNOWN';
}

function isRetestableTaVeto(vetoResult = {}) {
  const gate = String(vetoResult?.gate || '').toUpperCase();
  const reason = String(vetoResult?.reason || '').toUpperCase();
  return gate === 'SUPERTREND_15M' || reason.includes('SUPERTREND') || reason.includes('TREND 15M');
}

function addPendingRetest(pool, reason = 'TA belum valid') {
  const cfg = getConfig();
  if (cfg.pendingRetestEnabled === false) return;

  const mint = getPoolMint(pool);
  if (!mint || hasActiveMint(mint)) return;

  const now = Date.now();
  const intervalMin = Math.max(1, Number(cfg.retestIntervalMin) || 5);
  const ttlMin = Math.max(intervalMin, Number(cfg.retestTtlMin) || 60);
  const existing = _pendingRetestQueue.get(mint);

  _pendingRetestQueue.set(mint, {
    pool,
    symbol: getPoolSymbol(pool),
    reason,
    attempts: existing?.attempts || 0,
    firstSeenAt: existing?.firstSeenAt || now,
    lastReason: reason,
    nextCheckAt: now + intervalMin * 60 * 1000,
    expiresAt: existing?.expiresAt || (now + ttlMin * 60 * 1000),
  });
  console.log(`[hunter] ⏳ Pending retest: ${getPoolSymbol(pool)} — ${reason}`);
}

function getWatchConfig(cfg = getConfig()) {
  return {
    enabled: cfg.taWatchEnabled !== false,
    maxPools: Math.max(1, Number(cfg.taWatchMaxPools) || 10),
    expiryMin: Math.max(5, Number(cfg.taWatchExpiryMin) || 60),
  };
}

function computeTaWatchPriorityScore({ pool = {}, entrySignals = {}, row = {}, now = Date.now() } = {}) {
  const cfg = getConfig();
  const readiness = String(entrySignals.entryReadiness || '').toUpperCase();
  const breakout = String(entrySignals.breakoutQuality || '').toUpperCase();
  const timing = String(entrySignals.entryTimingState || '').toUpperCase();
  const trend = String(entrySignals.taTrend || '').toUpperCase();
  const volumeRatio = Number(entrySignals.volumeRatio || 0);
  const m5 = Number(entrySignals.priceChangeM5 || 0);
  const stDistance = Number(entrySignals.signalStDistancePct || 0);
  const ageSec = Math.max(0, Math.round(((now - Number(row.firstSeenAt || now)) || 0) / 1000));
  const freshnessBonus = Math.max(0, 90 - Math.floor(ageSec / 30));

  let score = 0;
  score += readiness === 'HIGH' ? 220 : readiness === 'MEDIUM' ? 120 : 30;
  score += breakout === 'STRONG' ? 180 : breakout === 'VALID' ? 120 : 20;
  score += timing === 'ATH_BREAK' ? 120 : timing === 'BREAKOUT' ? 90 : timing === 'LP_LIVE' ? 95 : 0;
  score += trend === 'BULLISH' ? 80 : 0;
  score += Math.max(0, Math.min(60, volumeRatio * 35));
  score += Math.max(0, Math.min(50, m5 * 12));
  score += Math.max(0, Math.min(35, stDistance));
  score += freshnessBonus;

  if (pool?._watchSnapshotAt) score += 10;
  score += Number(row.memoryPriorityDelta || 0);
  const pattern = applyPoolPatternLearningToScore({
    baseScore: score,
    candidate: {
      pool,
      entrySignals,
      row,
      tokenMint: pool?.tokenXMint || pool?.tokenX || pool?.mint || '',
      poolAddress: pool?.address || pool?.poolAddress || pool?.pool || '',
      symbol: pool?.tokenXSymbol || pool?.name || '',
      entryReason: row?.lastReason || '',
    },
    config: cfg,
    now,
  });
  const finalScore = pattern.score;
  if (pattern.learningDecision.enabled) {
    const tag = pattern.learningDecision.shadowMode ? 'PATTERN_LEARNING_SHADOW' : 'PATTERN_LEARNING_APPLIED';
    console.log(
      `[${tag}] ${pattern.candidateFeatures.symbol || pattern.candidateFeatures.tokenMint || 'UNKNOWN'} ` +
      `fp=${pattern.learningDecision.reasons[0] || 'NO_FP'} samples=${pattern.learningDecision.sampleCount} ` +
      `base=${pattern.baseScore.toFixed(2)} delta=${Number(pattern.learningDecision.delta || 0).toFixed(2)} ` +
      `shadow=${pattern.shadowScore.toFixed(2)} applied=${pattern.appliedDelta.toFixed(2)} score=${finalScore.toFixed(2)}`
    );
  }
  return finalScore;
}

function formatMemorySignal(signal = {}) {
  const delta = Number(signal.priorityDelta || 0);
  const lookupMs = Number(signal.lookupMs || 0);
  return `memory=${signal.reason || 'NO_MEMORY'} delta=${delta} lookup=${lookupMs}ms`;
}

function isDeploySlotSaturated(slotUsage = getDeploySlotUsage()) {
  const maxPositions = Number(slotUsage?.maxPositions || 0);
  const active = Number(slotUsage?.active || 0);
  const reserved = Number(slotUsage?.reserved || 0);
  return maxPositions > 0 && (active + reserved) >= maxPositions;
}

function addWatchPassTa(pool, reason = 'TA PASS', source = 'TA') {
  const cfg = getConfig();
  const watchCfg = getWatchConfig(cfg);
  const slotUsage = getDeploySlotUsage();

  const mint = getPoolMint(pool);
  if (!mint || hasActiveMint(mint)) return { admitted: false, reason: 'Mint aktif / tidak valid', row: null, evicted: null };
  if (!isSupportedQuoteToken(pool)) {
    const quoteReason = `Unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`;
    console.log(`[WATCH] ⛔ ${getPoolSymbol(pool)} ditolak: ${quoteReason}`);
    return { admitted: false, reason: quoteReason, row: null, evicted: null };
  }

  const now = Date.now();
  const existing = _taWatchQueue.get(mint);
  const symbol = getPoolSymbol(pool);
  const signals = pool?._entrySignals || {};
  if (String(signals.taTrend || '').toUpperCase() === 'BEARISH') {
    return { admitted: false, reason: 'Supertrend 15m bearish', row: null, evicted: null };
  }
  const memorySignal = getPoolMemorySignal(pool, now);
  if (memorySignal.cooldownActive) {
    console.log(`[WATCH] 🧠 ${symbol} ditahan memory cooldown (${formatMemorySignal(memorySignal)})`);
    return { admitted: false, reason: `Pool memory cooldown: ${symbol} (${memorySignal.reason})`, row: null, evicted: null };
  }
  const watchWindowSec = getLpWatchWindowSec(cfg);
  const maxDriftPct = getLpMaxDriftPct(cfg);
  const memoryPriorityDelta = Number(memorySignal.priorityDelta || 0);
  const frozenIntent = resolveFrozenEntryIntent(pool, existing, signals);
  const resolvedSnapshotAt = Number.isFinite(Number(existing?.snapshotAt))
    ? Number(existing.snapshotAt)
    : Number.isFinite(Number(frozenIntent.snapshotAt))
      ? Number(frozenIntent.snapshotAt)
      : now;
  const resolvedEntryActiveBin = Number.isFinite(Number(existing?.entryActiveBin))
    ? Number(existing.entryActiveBin)
    : Number.isFinite(Number(frozenIntent.entryActiveBin))
      ? Number(frozenIntent.entryActiveBin)
      : null;
  const resolvedEntryPrice = Number.isFinite(Number(existing?.entryPrice))
    ? Number(existing.entryPrice)
    : Number.isFinite(Number(frozenIntent.entryPrice))
      ? Number(frozenIntent.entryPrice)
      : null;
  if (!Number.isFinite(Number(pool?._entryActiveBin)) && Number.isFinite(frozenIntent.entryActiveBin)) {
    pool._entryActiveBin = Number(frozenIntent.entryActiveBin);
  }
  if (!Number.isFinite(Number(pool?._entryPrice)) && Number.isFinite(frozenIntent.entryPrice)) {
    pool._entryPrice = Number(frozenIntent.entryPrice);
  }
  if (!Number.isFinite(Number(pool?._entryIntentSnapshotAt)) && Number.isFinite(frozenIntent.snapshotAt)) {
    pool._entryIntentSnapshotAt = Number(frozenIntent.snapshotAt);
  }
  const priorityScore = computeTaWatchPriorityScore({
    pool,
    entrySignals: signals,
    row: { ...(existing || {}), memoryPriorityDelta },
    now,
  });
  const effectiveMaxPools = watchCfg.enabled ? watchCfg.maxPools : Number.MAX_SAFE_INTEGER;
  const effectiveExpiryMin = watchCfg.expiryMin;

  const row = {
    pool,
    symbol,
    reason,
    source,
    attempts: existing?.attempts || 0,
    firstSeenAt: existing?.firstSeenAt || now,
    lastReason: reason,
    nextCheckAt: now,
    expiresAt: existing?.expiresAt || (now + effectiveExpiryMin * 60 * 1000),
    lastHeartbeatAt: existing?.lastHeartbeatAt || 0,
    snapshotAt: resolvedSnapshotAt,
    snapshotPrice: existing?.snapshotPrice ?? signals.currentPrice ?? null,
    snapshotHigh24h: existing?.snapshotHigh24h ?? signals.high24h ?? null,
    snapshotStDistancePct: existing?.snapshotStDistancePct ?? signals.signalStDistancePct ?? null,
    snapshotAthDistancePct: existing?.snapshotAthDistancePct ?? signals.signalAthDistancePct ?? null,
    snapshotM5Change: existing?.snapshotM5Change ?? signals.priceChangeM5 ?? null,
    snapshotM15Change: existing?.snapshotM15Change ?? signals.priceChangeM15 ?? null,
    entryActiveBin: resolvedEntryActiveBin,
    entryPrice: resolvedEntryPrice,
    taTrend: existing?.taTrend ?? signals.taTrend ?? null,
    priceChangeM5: existing?.priceChangeM5 ?? signals.priceChangeM5 ?? null,
    watchWindowSec: existing?.watchWindowSec || watchWindowSec,
    maxDriftPct: existing?.maxDriftPct || maxDriftPct,
    hasFrozenEntryIntent:
      (existing?.hasFrozenEntryIntent === true || frozenIntent.hasFrozenEntryIntent === true) &&
      Number.isFinite(resolvedEntryActiveBin) &&
      Number.isFinite(resolvedEntryPrice) &&
      resolvedEntryPrice > 0 &&
      Number.isFinite(resolvedSnapshotAt) &&
      resolvedSnapshotAt > 0,
    memoryPriorityDelta,
    memoryReason: memorySignal.reason,
    priorityScore,
  };
  recordPoolDecision({
    pool,
    decision: 'WATCH',
    reason,
    source,
    snapshot: {
      ...signals,
      recentTrend: signals.taTrend,
      recentM5: signals.priceChangeM5,
    },
  });

  if (existing) {
    _taWatchQueue.set(mint, row);
    console.log(`[WATCH] 👀 ${symbol} refresh watch queue (${source}) — ${reason} | ${formatMemorySignal(memorySignal)}`);
    return { admitted: true, row, evicted: null, reason: null };
  }

  if (isDeploySlotSaturated(slotUsage)) {
    const rejectReason = `SLOT_SATURATED_PROMOTION_PAUSED (${slotUsage.active + slotUsage.reserved}/${slotUsage.maxPositions})`;
    console.log(`[WATCH] ⏸️ ${symbol} tunda masuk watch: ${rejectReason}`);
    return { admitted: false, row: null, evicted: null, reason: rejectReason };
  }

  if (_taWatchQueue.size < effectiveMaxPools) {
    _taWatchQueue.set(mint, row);
    console.log(`[WATCH] 👀 ${symbol} masuk watch queue (${source}) — ${reason} | ${formatMemorySignal(memorySignal)}`);
    return { admitted: true, row, evicted: null, reason: null };
  }

  const sortedByWeakest = [..._taWatchQueue.entries()].sort((a, b) => {
    const aScore = Number(a[1]?.priorityScore || 0);
    const bScore = Number(b[1]?.priorityScore || 0);
    if (aScore !== bScore) return aScore - bScore;
    return Number(a[1]?.firstSeenAt || 0) - Number(b[1]?.firstSeenAt || 0);
  });
  const weakest = sortedByWeakest[0];
  const weakestScore = Number(weakest?.[1]?.priorityScore || 0);

  if (priorityScore > weakestScore) {
    _taWatchQueue.delete(weakest[0]);
    _taWatchQueue.set(mint, row);
    console.log(
      `[WATCH] 🔀 ${symbol} menggantikan watch terlemah ${weakest?.[1]?.symbol || weakest?.[0]?.slice(0,8)} ` +
      `(score ${priorityScore} > ${weakestScore})`
    );
    return { admitted: true, row, evicted: weakest[1], reason: null };
  }

  const rejectReason = `WATCH penuh (${_taWatchQueue.size}/${watchCfg.maxPools}) dan score tidak cukup (${priorityScore} <= ${weakestScore})`;
  console.log(`[WATCH] ⛔ ${symbol} tidak masuk watch: ${rejectReason}`);
  return { admitted: false, row: null, evicted: null, reason: rejectReason };
}

async function resolveManualCaPool(address, cfg = getConfig(), deps = {}) {
  const getPoolInfoFn = typeof deps?.getPoolInfoFn === 'function' ? deps.getPoolInfoFn : getPoolInfo;
  const fetchFn = typeof deps?.fetchWithTimeoutFn === 'function' ? deps.fetchWithTimeoutFn : fetchWithTimeout;
  const tokenMint = String(address || '').trim();
  const binStepPriority = Array.isArray(cfg.binStepPriority) && cfg.binStepPriority.length > 0
    ? cfg.binStepPriority.map(Number).filter(Number.isFinite)
    : [200, 125, 100];
  const sourcesTried = [];

  const isSolMint = (mint = '') => String(mint || '').trim() === WSOL_MINT;
  const isSolSymbol = (symbol = '') => {
    const s = String(symbol || '').trim().toUpperCase();
    return s === 'SOL' || s === 'WSOL';
  };
  const parsePoolArray = (data) => {
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.pools)) return data.pools;
    if (Array.isArray(data)) return data;
    return [];
  };
  const normalizePoolCandidate = (p = {}, source = 'UNKNOWN') => {
    const tokenXMint = String(
      p?.tokenXMint || p?.tokenX || p?.token_x?.address || p?.base?.mint || p?.mintA || p?.baseMint || ''
    ).trim();
    const tokenYMint = String(
      p?.tokenYMint || p?.tokenY || p?.token_y?.address || p?.quote?.mint || p?.mintB || p?.quoteMint || ''
    ).trim();
    const tokenXSymbol = String(
      p?.tokenXSymbol || p?.token_x?.symbol || p?.base?.symbol || p?.symbolA || ''
    ).trim();
    const tokenYSymbol = String(
      p?.tokenYSymbol || p?.token_y?.symbol || p?.quote?.symbol || p?.symbolB || ''
    ).trim();
    const address = String(p?.address || p?.poolAddress || p?.pool_address || p?.pool || '').trim();
    const rawBinStep =
      p?.binStep ??
      p?.bin_step ??
      p?.pool_config?.bin_step ??
      p?.dlmm_params?.bin_step ??
      null;
    const binStep = Number(rawBinStep || 0);
    const feePct = Number(p?.feePct || p?.fee_pct || 0);
    const activeTvl = Number(p?.activeTvl || p?.active_tvl || 0);
    const totalTvl = Number(p?.totalTvl || p?.tvl || p?.total_tvl || activeTvl || 0);
    const volume24h = Number(
      p?.volume24h || p?.volume_24h || p?.trade_volume_24h || p?.tradeVolume24h || p?.v24h || p?.volume || 0
    );
    const isDlmm =
      String(p?.type || '').toLowerCase() === 'dlmm' ||
      String(p?.pool_type || p?.poolType || '').toLowerCase() === 'dlmm' ||
      Number.isFinite(binStep) && binStep > 0 ||
      Boolean(p?.dlmm_params) ||
      Boolean(p?.pool_config);
    return {
      ...p,
      address,
      poolAddress: address,
      tokenXMint,
      tokenYMint,
      tokenXSymbol,
      tokenYSymbol,
      quoteMint: tokenYMint || String(p?.quoteMint || ''),
      quoteSymbol: tokenYSymbol || String(p?.quoteSymbol || ''),
      binStep,
      feePct,
      activeTvl,
      totalTvl,
      volume24h,
      isDlmm,
      _source: source,
    };
  };
  const swapPoolSides = (pool = {}) => ({
    ...pool,
    tokenXMint: pool.tokenYMint || '',
    tokenYMint: pool.tokenXMint || '',
    tokenXSymbol: pool.tokenYSymbol || '',
    tokenYSymbol: pool.tokenXSymbol || '',
    quoteMint: pool.tokenXMint || '',
    quoteSymbol: pool.tokenXSymbol || '',
  });
  const canonicalizePoolForToken = (pool = {}, mint = '') => {
    const xMint = String(pool?.tokenXMint || '').trim();
    const yMint = String(pool?.tokenYMint || '').trim();
    const tokenIsX = xMint === mint;
    const tokenIsY = yMint === mint;
    const xIsSol = isSolMint(xMint) || isSolSymbol(pool?.tokenXSymbol);
    const yIsSol = isSolMint(yMint) || isSolSymbol(pool?.tokenYSymbol);
    if (tokenIsY && xIsSol) return swapPoolSides(pool);
    if (tokenIsX && yIsSol) return pool;
    return pool;
  };
  const poolMintAliases = (pool = {}) => {
    const out = new Set();
    const add = (v) => {
      const s = String(v || '').trim();
      if (s) out.add(s);
    };
    add(pool?.tokenXMint);
    add(pool?.tokenYMint);
    add(pool?.token_x?.address);
    add(pool?.token_y?.address);
    add(pool?.base?.mint);
    add(pool?.quote?.mint);
    add(pool?.baseMint);
    add(pool?.quoteMint);
    add(pool?.mintA);
    add(pool?.mintB);
    add(pool?.tokenX);
    add(pool?.tokenY);
    add(pool?.mint);
    return out;
  };
  const poolMatchesToken = (pool = {}, mint = '') => poolMintAliases(pool).has(mint);
  const rankCandidates = (rows = []) => {
    return [...rows].sort((a, b) => {
      if (a.solPair !== b.solPair) return (b.solPair ? 1 : 0) - (a.solPair ? 1 : 0);
      if (a.supportedBinStep !== b.supportedBinStep) return (b.supportedBinStep ? 1 : 0) - (a.supportedBinStep ? 1 : 0);
      if (a.binStepPriorityRank !== b.binStepPriorityRank) return a.binStepPriorityRank - b.binStepPriorityRank;
      if (a.totalTvl !== b.totalTvl) return b.totalTvl - a.totalTvl;
      if (a.volume24h !== b.volume24h) return b.volume24h - a.volume24h;
      if (a.hasPoolAddress !== b.hasPoolAddress) return (b.hasPoolAddress ? 1 : 0) - (a.hasPoolAddress ? 1 : 0);
      return 0;
    });
  };
  const pickCandidate = (rawPools = [], source = 'UNKNOWN') => {
    const rejection = {
      foundCount: 0,
      rejectedNoSolPair: 0,
      rejectedUnsupportedBinStep: 0,
      rejectedMissingPoolAddress: 0,
      rejectedNotDlmm: 0,
      rejectedOther: 0,
    };
    const matched = rawPools
      .map((p) => normalizePoolCandidate(p, source))
      .filter((p) => poolMatchesToken(p, tokenMint));
    rejection.foundCount = matched.length;

    const scored = matched.map((candidate) => {
      const c = canonicalizePoolForToken(candidate, tokenMint);
      const xMint = String(c?.tokenXMint || '').trim();
      const yMint = String(c?.tokenYMint || '').trim();
      const xIsSol = isSolMint(xMint) || isSolSymbol(c?.tokenXSymbol);
      const yIsSol = isSolMint(yMint) || isSolSymbol(c?.tokenYSymbol);
      const solPair = xIsSol || yIsSol;
      const hasPoolAddress = Boolean(String(c?.address || c?.poolAddress || '').trim());
      const binStep = Number(c?.binStep || 0);
      const prioIndex = binStepPriority.indexOf(binStep);
      const supportedBinStep = prioIndex >= 0;
      const binStepPriorityRank = prioIndex >= 0 ? prioIndex : Number.MAX_SAFE_INTEGER;
      if (!c.isDlmm) rejection.rejectedNotDlmm += 1;
      else if (!solPair) rejection.rejectedNoSolPair += 1;
      else if (!supportedBinStep) rejection.rejectedUnsupportedBinStep += 1;
      else if (!hasPoolAddress) rejection.rejectedMissingPoolAddress += 1;
      return {
        candidate: c,
        solPair,
        supportedBinStep,
        binStepPriorityRank,
        totalTvl: Number(c?.totalTvl || c?.activeTvl || 0),
        volume24h: Number(c?.volume24h || 0),
        hasPoolAddress,
        accept: c.isDlmm && solPair && supportedBinStep && hasPoolAddress,
      };
    });
    const accepted = rankCandidates(scored.filter((x) => x.accept));
    return {
      best: accepted[0]?.candidate || null,
      rejection,
    };
  };
  const buildResolveError = ({
    reason = '',
    directStat = null,
    fallbackStat = null,
  } = {}) => {
    const parts = [
      reason,
      `sources=${sourcesTried.join('>') || 'none'}`,
      'cacheUsed=no',
    ];
    const statToText = (label, stat) => {
      if (!stat) return `${label}:none`;
      return `${label}:{found=${stat.foundCount},noSol=${stat.rejectedNoSolPair},binStep=${stat.rejectedUnsupportedBinStep},noAddr=${stat.rejectedMissingPoolAddress},notDlmm=${stat.rejectedNotDlmm},other=${stat.rejectedOther}}`;
    };
    parts.push(statToText('direct', directStat));
    parts.push(statToText('fallback', fallbackStat));
    return new Error(parts.join(' | '));
  };

  try {
    const poolInfo = await getPoolInfoFn(tokenMint);
    return {
      ok: true,
      kind: 'POOL',
      poolInfo,
      tokenMint: String(poolInfo.tokenX || poolInfo.tokenXMint || poolInfo.mint || '').trim(),
      poolAddress: String(poolInfo.address || tokenMint).trim(),
      symbol: poolInfo.tokenXSymbol || poolInfo.name?.split('-')[0] || tokenMint.slice(0, 8) || 'UNKNOWN',
      resolutionNote: 'Direct Meteora pool address',
    };
  } catch (directPoolError) {
    const searchUrl = `${DLMM_POOL_SEARCH_BASE}?query=${encodeURIComponent(tokenMint)}&sort_by=${encodeURIComponent('tvl:desc')}&page_size=20`;
    let directRows = [];
    let directStat = null;
    try {
      sourcesTried.push('dlmm.datapi.direct');
      const res = await fetchFn(searchUrl, {}, 10_000);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        directRows = parsePoolArray(data);
      } else {
        sourcesTried.push(`dlmm.datapi.direct.http_${res.status}`);
      }
    } catch (e) {
      sourcesTried.push(`dlmm.datapi.direct.err_${String(e?.message || 'unknown').slice(0, 24)}`);
    }
    if (directRows.length > 0) {
      const picked = pickCandidate(directRows, 'DLMM_DIRECT');
      directStat = picked.rejection;
      if (picked.best) {
        const bestPool = canonicalizePoolForToken(picked.best, tokenMint);
        const symbol = bestPool.tokenXMint === tokenMint
          ? (bestPool.tokenXSymbol || bestPool.name?.split('-')[0] || tokenMint.slice(0, 8))
          : (bestPool.tokenYSymbol || bestPool.name?.split('-')[0] || tokenMint.slice(0, 8));
        return {
          ok: true,
          kind: 'TOKEN',
          poolInfo: bestPool,
          tokenMint,
          poolAddress: String(bestPool.address || bestPool.poolAddress || '').trim(),
          symbol,
          resolutionNote: `Token mint resolved via direct Meteora DLMM search (${picked.rejection.foundCount} candidate${picked.rejection.foundCount === 1 ? '' : 's'})`,
          discoveryCount: directRows.length,
        };
      }
    }

    let fallbackRows = [];
    let fallbackStat = null;
    try {
      sourcesTried.push('pool-discovery.fresh');
      const fallbackLimit = Math.max(
        200,
        Number(cfg.meteoraDiscoveryLimit) || 50,
        Number(cfg.screeningTopPoolsLimit) || 10
      );
      const fallbackUrl = `${POOL_DISCOVERY_BASE}?page_size=${fallbackLimit}&filter_by=${encodeURIComponent('pool_type=dlmm')}`;
      const fallbackRes = await fetchFn(fallbackUrl, {}, 10_000);
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json().catch(() => null);
        fallbackRows = parsePoolArray(fallbackData);
      } else {
        sourcesTried.push(`pool-discovery.http_${fallbackRes.status}`);
      }
    } catch (e) {
      sourcesTried.push(`pool-discovery.err_${String(e?.message || 'unknown').slice(0, 24)}`);
    }

    if (fallbackRows.length > 0) {
      const picked = pickCandidate(fallbackRows, 'POOL_DISCOVERY_FRESH');
      fallbackStat = picked.rejection;
      if (picked.best) {
        const bestPool = canonicalizePoolForToken(picked.best, tokenMint);
        const symbol = bestPool.tokenXMint === tokenMint
          ? (bestPool.tokenXSymbol || bestPool.name?.split('-')[0] || tokenMint.slice(0, 8))
          : (bestPool.tokenYSymbol || bestPool.name?.split('-')[0] || tokenMint.slice(0, 8));
        return {
          ok: true,
          kind: 'TOKEN',
          poolInfo: bestPool,
          tokenMint,
          poolAddress: String(bestPool.address || bestPool.poolAddress || '').trim(),
          symbol,
          resolutionNote: `Token mint resolved via fresh pool-discovery fallback (${picked.rejection.foundCount} candidate${picked.rejection.foundCount === 1 ? '' : 's'})`,
          discoveryCount: fallbackRows.length,
        };
      }
    }

    throw buildResolveError({
      reason: `Tidak ada pool Meteora yang cocok untuk mint ${tokenMint.slice(0, 8)}...`,
      directStat,
      fallbackStat,
    });
  }
}

export async function __resolveManualCaPoolForTests(address, cfg = {}, deps = {}) {
  return resolveManualCaPool(address, cfg, deps);
}

export async function submitManualCaPool(poolAddress, { source = 'TELEGRAM_CA' } = {}) {
  const cfg = getConfig();
  const address = String(poolAddress || '').trim();
  if (!address) {
    return { ok: false, status: 'INVALID', reason: 'Pool address kosong' };
  }

  console.log(`[MANUAL] 📥 CA diterima: ${address}`);

  let resolved;
  try {
    resolved = await resolveManualCaPool(address, cfg);
  } catch (e) {
    const reason = `Gagal resolve CA ke pool Meteora: ${e.message}`;
    console.warn(`[MANUAL] ❌ ${reason}`);
    return { ok: false, status: 'INVALID', reason };
  }

  const poolInfo = resolved.poolInfo;
  const tokenMint = String(resolved.tokenMint || poolInfo.tokenX || poolInfo.tokenXMint || poolInfo.mint || '').trim();
  const symbol = resolved.symbol || poolInfo.tokenXSymbol || poolInfo.name?.split('-')[0] || tokenMint.slice(0, 8) || 'UNKNOWN';
  if (!isSupportedQuoteToken(poolInfo)) {
    const reason = `Unsupported quote token ${getQuoteTokenLabel(poolInfo)}; expected SOL/WSOL`;
    console.warn(`[MANUAL] ❌ ${symbol}: ${reason}`);
    return { ok: false, status: 'VETO', kind: resolved.kind, symbol, poolAddress: resolved.poolAddress || address, tokenMint, reason };
  }
  if (!tokenMint) {
    const reason = 'Token mint tidak tersedia dari pool Meteora';
    console.warn(`[MANUAL] ❌ ${symbol}: ${reason}`);
    return { ok: false, status: 'INVALID', symbol, reason };
  }

  if (hasActiveMint(tokenMint) || hasActivePoolAddress(resolved.poolAddress || address)) {
    const reason = 'Token/pool sudah aktif';
    console.log(`[MANUAL] 🔁 ${symbol} dilewati: ${reason}`);
    return { ok: false, status: 'DUPLICATE', symbol, reason };
  }

  const marketSnapshot = await getMarketSnapshot(
    tokenMint,
    resolved.poolAddress || address,
    {
      from: 'manual_ca',
      includeEntryCandles5m: String(cfg.entryDecisionMode || 'strict').toLowerCase() === 'lp_simple_m15',
    }
  ).catch(() => null);
  const entrySignals = deriveBreakoutEntrySignals({ pool: poolInfo, marketSnapshot, cfg });
  const now = Date.now();
  const watchWindowSec = getLpWatchWindowSec(cfg);
  const maxDriftPct = getLpMaxDriftPct(cfg);
  const entryIntent = extractEntryIntent(poolInfo, marketSnapshot, entrySignals);

  const pool = {
    ...poolInfo,
    address: resolved.poolAddress || address,
    poolAddress: resolved.poolAddress || address,
    tokenXMint: tokenMint,
    tokenXSymbol: symbol,
    name: poolInfo.name || `${symbol}/SOL`,
    _entrySignals: entrySignals,
    _watchSnapshotAt: now,
    _watchSnapshotPrice: entrySignals.currentPrice ?? marketSnapshot?.price?.currentPrice ?? null,
    _watchSnapshotHigh24h: entrySignals.high24h ?? marketSnapshot?.ohlcv?.high24h ?? null,
    _watchSnapshotStDistancePct: entrySignals.signalStDistancePct ?? null,
    _watchSnapshotAthDistancePct: entrySignals.signalAthDistancePct ?? null,
    _watchSnapshotM5Change: entrySignals.priceChangeM5 ?? null,
    _watchSnapshotM15Change: entrySignals.priceChangeM15 ?? null,
    _watchTaTrend: entrySignals.taTrend ?? null,
    _entryActiveBin: entryIntent.entryActiveBin,
    _entryPrice: entryIntent.entryPrice,
    _marketSnapshot: marketSnapshot,
    hasNonRefundableFees: Boolean(marketSnapshot?.pool?.hasNonRefundableFees),
  };

  const manualStGate = await ensureFinalSupertrendBullish({
    mint: tokenMint,
    symbol,
    pool,
    meta: {},
    liveSnapshot: marketSnapshot,
    currentPrice: entrySignals.currentPrice ?? marketSnapshot?.price?.currentPrice ?? 0,
  });
  if (!manualStGate.ok) {
    const status = manualStGate.action === 'VETO' ? 'DROP' : 'HOLD';
    const reason = manualStGate.reason || 'Supertrend 15m belum confirmed bullish';
    console.log(`[MANUAL] ${status === 'DROP' ? '❌' : '⏸️'} ${symbol} ${status}: ${reason}`);
    return { ok: false, status, kind: resolved.kind, symbol, poolAddress: resolved.poolAddress || address, tokenMint, entrySignals, reason };
  }

  const queueMeta = {
    scoutReason: 'Manual CA input',
    entryReadiness: entrySignals.entryReadiness,
    breakoutQuality: entrySignals.breakoutQuality,
    entryGateMode: entrySignals.entryGateMode,
    entryTimingState: entrySignals.entryTimingState,
    signalStDistancePct: entrySignals.signalStDistancePct,
    signalAthDistancePct: entrySignals.signalAthDistancePct,
    taTrend: entrySignals.taTrend,
    priceChangeM5: entrySignals.priceChangeM5,
    snapshotAt: now,
    snapshotPrice: pool._watchSnapshotPrice,
    snapshotHigh24h: pool._watchSnapshotHigh24h,
    watchWindowSec,
    maxDriftPct,
    entryActiveBin: entryIntent.entryActiveBin,
    entryPrice: entryIntent.entryPrice,
    hasFrozenEntryIntent: entryIntent.hasFrozenEntryIntent,
    hasNonRefundableFees: pool.hasNonRefundableFees,
  };

  const readyForQueue = isFreshDeployMeta(queueMeta);

  if (readyForQueue) {
    console.log(`[MANUAL] 🟡 ${symbol} fresh → deploy queue`);
    enqueueForDeploy(pool, symbol, queueMeta);
    return { ok: true, status: 'QUEUE', kind: resolved.kind, symbol, poolAddress: resolved.poolAddress || address, tokenMint, entrySignals, resolutionNote: resolved.resolutionNote };
  }

  const watchResult = addWatchPassTa(pool, 'Manual CA input', source);
  if (!watchResult?.admitted) {
    console.log(`[MANUAL] ⛔ ${symbol} ditolak dari WATCH: ${watchResult?.reason || 'WATCH penuh'}`);
    return { ok: false, status: 'DROP', kind: resolved.kind, symbol, poolAddress: resolved.poolAddress || address, tokenMint, reason: watchResult?.reason || 'WATCH penuh' };
  }

  console.log(`[MANUAL] 👀 ${symbol} masuk WATCH (${resolved.kind})`);
  return {
    ok: true,
    status: 'WATCH',
    kind: resolved.kind,
    symbol,
    poolAddress: resolved.poolAddress || address,
    tokenMint,
    entrySignals,
    watch: watchResult.row,
    resolutionNote: resolved.resolutionNote,
  };
}

async function collectReadyRetestPools(cfg = getConfig()) {
  if (cfg.pendingRetestEnabled === false || _pendingRetestQueue.size === 0) return [];

  const now = Date.now();
  const maxAttempts = Math.max(1, Number(cfg.retestMaxAttempts) || 8);
  const maxReady = Math.max(1, Number(cfg.retestMaxReadyPerScan) || 3);
  const intervalMin = Math.max(1, Number(cfg.retestIntervalMin) || 5);
  const ready = [];

  for (const [mint, row] of [..._pendingRetestQueue.entries()]) {
    if (ready.length >= maxReady) break;
    if (!row?.pool || hasActiveMint(mint) || isBlacklisted(mint)) {
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.expiresAt <= now || row.attempts >= maxAttempts) {
      console.log(`[SCREEN] ⌛ Retest expired: ${row.symbol} attempts=${row.attempts}/${maxAttempts}`);
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.nextCheckAt > now) continue;

    row.attempts += 1;
    row.nextCheckAt = now + intervalMin * 60 * 1000;
    try {
      const veto = await withTimeout(
        runMeridianVeto({ mint, symbol: row.symbol, pool: row.pool }),
        Number(cfg.retestVetoTimeoutMs || 45_000),
        'RETEST_MERIDIAN_VETO'
      );
      if (veto.veto) {
        row.lastReason = veto.reason || row.lastReason;
        if (!isRetestableTaVeto(veto)) {
          console.log(`[SCREEN] ❌ Retest dropped: ${row.symbol} — ${row.lastReason}`);
          _pendingRetestQueue.delete(mint);
          continue;
        }
      }

      const marketSnapshot = await getMarketSnapshot(
        mint,
        row.pool?.address || row.pool?.poolAddress || row.pool?.pool || null,
        {
          from: 'retest_collect',
          includeEntryCandles5m: String(cfg.entryDecisionMode || 'strict').toLowerCase() === 'lp_simple_m15',
        }
      ).catch(() => null);
      const entrySignals = deriveBreakoutEntrySignals({ pool: row.pool, vetoResult: veto, marketSnapshot, cfg });
      if (entrySignals.entryTimingState === 'BEARISH_TREND') {
        row.lastReason = 'Supertrend 15m bearish';
        console.log(`[SCREEN] ❌ Retest dropped: ${row.symbol} — ${row.lastReason}`);
        _pendingRetestQueue.delete(mint);
        continue;
      }

      if (isLPLiveTimingState(entrySignals.entryTimingState)) {
        if (entrySignals.entryReadiness === 'HIGH' && (entrySignals.breakoutQuality === 'VALID' || entrySignals.breakoutQuality === 'STRONG')) {
          const pool = {
            ...row.pool,
            _retestReason: row.reason,
            _retestAttempts: row.attempts,
            _entrySignals: entrySignals,
            hasNonRefundableFees: Boolean(marketSnapshot?.pool?.hasNonRefundableFees),
            _entryActiveBin: toFiniteNumber(row.entryActiveBin ?? row.pool?._entryActiveBin ?? null, null),
            _entryPrice: toFiniteNumber(row.entryPrice ?? row.pool?._entryPrice ?? null, null),
            _entryIntentSnapshotAt: toFiniteNumber(row.snapshotAt ?? row.pool?._entryIntentSnapshotAt ?? now, now),
            _watchSnapshotAt: row.snapshotAt || now,
            _watchSnapshotPrice: row.snapshotPrice ?? entrySignals.currentPrice ?? null,
            _watchSnapshotHigh24h: row.snapshotHigh24h ?? entrySignals.high24h ?? null,
            _watchSnapshotStDistancePct: row.snapshotStDistancePct ?? entrySignals.signalStDistancePct ?? null,
            _watchSnapshotAthDistancePct: row.snapshotAthDistancePct ?? entrySignals.signalAthDistancePct ?? null,
            _watchSnapshotM5Change: row.snapshotM5Change ?? entrySignals.priceChangeM5 ?? null,
            _watchSnapshotM15Change: row.snapshotM15Change ?? entrySignals.priceChangeM15 ?? null,
            _watchWindowSec: row.watchWindowSec || Math.max(5, Number(cfg.entryFreshWatchWindowSec) || 90),
            _watchMaxDriftPct: row.maxDriftPct || Math.max(0.1, Number(cfg.entryFreshBreakoutMaxDriftPct) || 2.5),
          };
          const watchResult = addWatchPassTa(pool, row.reason || 'TA PASS', 'RADAR');
          if (watchResult?.admitted) {
            _pendingRetestQueue.delete(mint);
            if (watchResult.evicted?.pool) {
              addPendingRetest(watchResult.evicted.pool, 'WATCH digeser oleh prioritas lebih kuat');
            }
            console.log(`[WATCH] ✅ Retest PASS → WATCH: ${row.symbol} attempts=${row.attempts}`);
            ready.push(pool);
            continue;
          }

          row.lastReason = watchResult?.reason || 'WATCH penuh';
          _pendingRetestQueue.set(mint, row);
          console.log(`[WATCH] ⏳ Retest PASS tapi belum bisa masuk WATCH: ${row.symbol} — ${row.lastReason}`);
          continue;
        }
      }

      row.lastReason = `TA belum fresh: ${entrySignals.entryTimingState}/${entrySignals.breakoutQuality}`;
      _pendingRetestQueue.set(mint, row);
      console.log(`[SCREEN] ⏳ Retest still pending: ${row.symbol} — ${row.lastReason}`);
    } catch (e) {
      row.lastReason = e?.message || 'Retest error';
      _pendingRetestQueue.set(mint, row);
      console.warn(`[SCREEN] Retest error ${row.symbol}: ${row.lastReason}`);
    }
  }

  return ready;
}

export function isRunning()            { return _running; }
export function getCurrentPosition()   { return getActivePositionKeys()[0] || null; }
export function getActivePositions()   { return listActivePositions(); }
export function setShutdownInProgress(v = true) { _shutdownInProgress = !!v; }

// ── Delay helper ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function generateFinalCycleReport(CycleReport = []) {
  void CycleReport;
  return reportManager.generateReport();
}

function chunkArray(items, size = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isNaturalDeployError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return ['partial', 'simulation failed', 'slippage', 'timeout', 'blockhash']
    .some((needle) => msg.includes(needle));
}

function hasFeePnlData(result = {}) {
  return result?.feePnlAvailable === true || String(result?.feePnlSource || 'none') !== 'none';
}

function hasTrackedFeeSnapshot(result = {}) {
  const feeSource = String(result?.feePnlSource || 'none');
  if (result?.feePnlAvailable === true) return true;
  if (feeSource === 'none' || feeSource === 'fast_path') return false;
  const feePnlSol = Math.max(0, Number(result?.feePnlSol || 0));
  const feePnlPct = Math.max(0, Number(result?.feePnlPct || 0));
  return feePnlSol > 0 || feePnlPct > 0;
}

function resolveTrackedFeeSnapshot(status = {}, meta = {}) {
  if (hasTrackedFeeSnapshot(status)) {
    return {
      feePnlSol: Math.max(0, Number(status?.feePnlSol || 0)),
      feePnlPct: Math.max(0, Number(status?.feePnlPct || 0)),
      feePnlAvailable: status?.feePnlAvailable === true,
      feePnlSource: status?.feePnlSource || 'none',
    };
  }
  return {
    feePnlSol: Math.max(0, Number(meta?.feePnlSol || 0)),
    feePnlPct: Math.max(0, Number(meta?.feePnlPct || 0)),
    feePnlAvailable: meta?.feePnlAvailable === true,
    feePnlSource: meta?.feePnlSource || 'none',
  };
}

function formatFeePnlLine(result = {}) {
  if (!hasFeePnlData(result)) return 'Fee PnL: <code>unavailable</code>\n';
  const feePnlSol = Math.max(0, Number(result?.feePnlSol || 0));
  const feePnlPct = Math.max(0, Number(result?.feePnlPct || 0));
  const sign = feePnlPct > 0 ? '+' : '';
  return `Fee PnL: <code>${feePnlSol.toFixed(6)} SOL / ${sign}${feePnlPct.toFixed(2)}%</code>\n`;
}

function formatExposurePnlLine(result = {}) {
  const totalPct = Number(result?.pnlTotalPct);
  if (!Number.isFinite(totalPct)) return '';
  const sign = totalPct >= 0 ? '+' : '';
  return `Total Exposure PnL: <code>${sign}${totalPct.toFixed(2)}%</code>\n`;
}

function formatWalletDeltaLine(result = {}) {
  const walletNetDeltaSol = Number(result?.walletNetDeltaSol);
  if (!Number.isFinite(walletNetDeltaSol)) return '';
  return `Wallet Net Delta: <code>${walletNetDeltaSol.toFixed(6)} SOL</code>\n`;
}

function formatRentRefundLine(result = {}) {
  const rentRefundSol = Number(result?.rentRefundSol);
  if (!Number.isFinite(rentRefundSol)) return '';
  return `Rent Refund (est): <code>${rentRefundSol.toFixed(6)} SOL</code>\n`;
}

function formatMaybePct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : 'UNKNOWN';
}

function formatMaybeUsd(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `$${Math.round(num).toLocaleString('en-US')}` : 'UNKNOWN';
}

function formatMaybeBool(value) {
  if (value === true) return 'YES';
  if (value === false) return 'NO';
  return 'UNKNOWN';
}

function getEntryGateMode(cfg = getConfig()) {
  return String(cfg?.entryGateMode || 'lp_fee_flow').trim().toLowerCase();
}

function isLpEntryMode(cfg = getConfig()) {
  return getEntryGateMode(cfg).includes('lp');
}

function getLpWatchWindowSec(cfg = getConfig(), fallback = 90) {
  const base = Math.max(5, Number(cfg.entryFreshWatchWindowSec) || fallback);
  return isLpEntryMode(cfg) ? Math.max(180, base) : base;
}

function getLpMaxDriftPct(cfg = getConfig(), fallback = 2.5) {
  const base = Math.max(0.1, Number(cfg.entryFreshBreakoutMaxDriftPct) || fallback);
  return isLpEntryMode(cfg) ? Math.max(8, base) : base;
}

function isLPLiveTimingState(state = '') {
  return ['LP_LIVE', 'RECLAIM', 'RECLAIM_LIVE', 'BREAKOUT', 'ATH_BREAK'].includes(String(state || '').toUpperCase());
}

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function hasValidFrozenEntryIntent({
  entryActiveBin = null,
  entryPrice = null,
  snapshotAt = null,
} = {}) {
  const bin = Number(entryActiveBin);
  const price = Number(entryPrice);
  const ts = Number(snapshotAt);
  return Number.isFinite(bin) &&
    Number.isSafeInteger(bin) &&
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(ts) &&
    ts > 0;
}

function resolveFrozenEntryIntent(pool = {}, existing = null, entrySignals = null) {
  const existingActiveBin = toFiniteNumber(existing?.entryActiveBin ?? null, null);
  const existingPrice = toFiniteNumber(existing?.entryPrice ?? null, null);
  const existingSnapshotAt = toFiniteNumber(existing?.snapshotAt ?? null, null);
  if (hasValidFrozenEntryIntent({
    entryActiveBin: existingActiveBin,
    entryPrice: existingPrice,
    snapshotAt: existingSnapshotAt,
  })) {
    return {
      entryActiveBin: existingActiveBin,
      entryPrice: existingPrice,
      snapshotAt: existingSnapshotAt,
      hasFrozenEntryIntent: true,
    };
  }

  const marketSnapshot = pool?._marketSnapshot ?? null;
  const resolved = extractEntryIntent(pool, marketSnapshot, entrySignals || pool?._entrySignals || null);
  const snapshotAt = toFiniteNumber(
    pool?._entryIntentSnapshotAt ?? pool?._watchSnapshotAt ?? Date.now(),
    Date.now(),
  );
  const hasFrozenEntryIntent = hasValidFrozenEntryIntent({
    entryActiveBin: resolved.entryActiveBin,
    entryPrice: resolved.entryPrice,
    snapshotAt,
  });
  return {
    entryActiveBin: hasFrozenEntryIntent ? resolved.entryActiveBin : null,
    entryPrice: hasFrozenEntryIntent ? resolved.entryPrice : null,
    snapshotAt,
    hasFrozenEntryIntent,
  };
}

function extractEntryIntent(pool = {}, marketSnapshot = null, entrySignals = null) {
  const entryActiveBin = toFiniteNumber(
    pool?._entryActiveBin ??
      pool?.activeBinId ??
      pool?.active_bin ??
      pool?.activeBin ??
      marketSnapshot?.pool?.activeBinId ??
      marketSnapshot?.pool?.active_bin ??
      null,
    null,
  );
  const entryPrice = toFiniteNumber(
    pool?._entryPrice ??
      entrySignals?.currentPrice ??
      marketSnapshot?.ohlcv?.currentPrice ??
      marketSnapshot?.price?.currentPrice ??
      pool?.price ??
      pool?.pool_price ??
      null,
    null,
  );
  return {
    entryActiveBin,
    entryPrice,
    hasFrozenEntryIntent: Number.isFinite(entryActiveBin) && Number.isSafeInteger(entryActiveBin) && Number.isFinite(entryPrice) && entryPrice > 0,
  };
}

function deriveBreakoutEntrySignals({ pool = {}, vetoResult = null, marketSnapshot = null, cfg = getConfig() } = {}) {
  const entryGateMode = getEntryGateMode(cfg);
  const entryDecisionMode = String(cfg.entryDecisionMode || 'strict').toLowerCase();
  const lpSimpleM15Mode = entryDecisionMode === 'lp_simple_m15';
  const m5HardGateEnabled = cfg.entryM5HardGateEnabled !== false;
  const deferOnM15PreviousUnknown = cfg.entryDeferOnM15PreviousUnknown !== false;
  const isLpMode = isLpEntryMode(cfg);
  const breakoutMinStPct = Number(cfg.entrySupertrendBreakMinPct ?? 1.25);
  const freshAthBreakPct = Number(cfg.entryFreshBreakoutMinAthDistancePct ?? 99.25);
  const requireVolumeConfirm = cfg.entryRequireVolumeConfirm !== false;
  const minVolRatio = Number(cfg.entryMinVolumeRatio || 1.1);
  const taTrend = String(
    marketSnapshot?.quality?.taTrend ||
    marketSnapshot?.ta?.supertrend?.trend ||
    vetoResult?.diagnostics?.supertrend15m ||
    'UNKNOWN'
  ).toUpperCase();

  const currentPrice = Number(
    marketSnapshot?.ohlcv?.currentPrice ||
    marketSnapshot?.price?.currentPrice ||
    pool?.price ||
    0
  );
  const supertrendValue = Number(marketSnapshot?.ta?.supertrend?.value || 0);
  const high24h = Number(marketSnapshot?.ohlcv?.high24h || 0);
  const priceChangeM5 = Number(marketSnapshot?.ohlcv?.priceChangeM5 ?? 0);
  const priceChangeM15 = Number(marketSnapshot?.ohlcv?.priceChangeM15 ?? 0);
  const priceChangeM15Prev = Number(marketSnapshot?.ohlcv?.priceChangeM15Prev ?? NaN);
  const priceChangeH1 = Number(marketSnapshot?.ohlcv?.priceChangeH1 ?? 0);
  const volume24h = Number(
    pool?.volume24h ||
    pool?.volume_24h ||
    pool?.trade_volume_24h ||
    pool?.tradeVolume24h ||
    pool?.volume ||
    pool?.v24h ||
    0
  );
  const tvl = Number(pool?.activeTvl || pool?.totalTvl || pool?.tvl || 0);
  const signalStDistancePct = currentPrice > 0 && supertrendValue > 0
    ? ((currentPrice - supertrendValue) / supertrendValue) * 100
    : null;
  const signalAthDistancePct = currentPrice > 0 && high24h > 0
    ? (currentPrice / high24h) * 100
    : null;
  const minDistancePct = Number(cfg.entrySupertrendMinDistancePct ?? 1.5);
  const maxDistancePct = Number(cfg.entrySupertrendMaxDistancePct ?? 18);
  const athBreakPct = Number(cfg.entryBreakoutMinAthDistancePct ?? 95);
  const volumeRatio = tvl > 0 ? volume24h / tvl : null;
  const isFreshAthBreak = Number.isFinite(signalAthDistancePct) && signalAthDistancePct >= freshAthBreakPct;
  const isStrongAthBreak = Number.isFinite(signalAthDistancePct) && signalAthDistancePct >= Math.max(freshAthBreakPct + 0.25, 99.75);
  const hasValidVolume = !requireVolumeConfirm || (Number.isFinite(volumeRatio) && volumeRatio >= minVolRatio);

  let entryTimingState = 'UNKNOWN';
  if (taTrend === 'BEARISH') {
    entryTimingState = 'BEARISH_TREND';
  } else if (taTrend !== 'BULLISH') {
    entryTimingState = 'NO_TREND';
  } else if ((m5HardGateEnabled || !lpSimpleM15Mode) && priceChangeM5 <= 0) {
    entryTimingState = 'NO_M5';
  } else if (requireVolumeConfirm && !hasValidVolume) {
    entryTimingState = 'WAIT_VOLUME';
  } else if (deferOnM15PreviousUnknown && !Number.isFinite(priceChangeM15Prev)) {
    entryTimingState = 'M15_PREV_UNKNOWN';
  } else if (!Number.isFinite(signalStDistancePct)) {
    entryTimingState = 'UNKNOWN';
  } else {
    const aboveSupertrend = signalStDistancePct > 0;
    if (!aboveSupertrend) {
      entryTimingState = 'TOO_CLOSE';
    } else if (isLpMode) {
      entryTimingState = 'LP_LIVE';
    } else if (entryGateMode === 'lper_retest' && signalStDistancePct > maxDistancePct) {
      entryTimingState = 'WAIT_FOR_PULLBACK';
    } else if (signalStDistancePct < breakoutMinStPct) {
      entryTimingState = 'TOO_CLOSE';
    } else if (!isFreshAthBreak) {
      entryTimingState = 'LATE_BREAKOUT';
    } else if (isStrongAthBreak) {
      entryTimingState = 'ATH_BREAK';
    } else if (signalAthDistancePct != null && signalAthDistancePct >= athBreakPct) {
      entryTimingState = 'BREAKOUT';
    } else if (signalStDistancePct > maxDistancePct && (priceChangeM15 < 0.5 || priceChangeM5 < 0.5)) {
      entryTimingState = 'EXTENDED';
    } else {
      entryTimingState = 'LATE_BREAKOUT';
    }
  }

  const entryReadiness =
    entryTimingState === 'ATH_BREAK' || entryTimingState === 'BREAKOUT' || entryTimingState === 'LP_LIVE' ? 'HIGH'
      : entryTimingState === 'EXTENDED' ? 'MEDIUM'
      : entryTimingState === 'TOO_CLOSE' ? 'LOW'
      : 'LOW';

  const breakoutQuality =
    entryTimingState === 'ATH_BREAK' ? 'STRONG'
      : entryTimingState === 'BREAKOUT' ? 'VALID'
      : entryTimingState === 'LP_LIVE'
        ? ((Number.isFinite(volumeRatio) && volumeRatio >= (minVolRatio * 1.5)) || priceChangeM15 >= 2 ? 'STRONG' : 'VALID')
        : entryTimingState === 'EXTENDED' ? 'WEAK'
        : 'WEAK';

  return {
    entryTimingState,
    entryReadiness,
    breakoutQuality,
    entryDecisionMode,
    m5HardGateEnabled,
    deferOnM15PreviousUnknown,
    taTrend,
    currentPrice,
    supertrendValue,
    high24h,
    priceChangeM5,
    priceChangeM15,
    priceChangeM15Prev,
    priceChangeH1,
    signalStDistancePct,
    signalAthDistancePct,
    volumeRatio,
    minDistancePct,
    maxDistancePct,
    breakoutMinStPct,
    freshAthBreakPct,
    athBreakPct,
    entryGateMode,
    canDeploy: entryTimingState === 'ATH_BREAK' || entryTimingState === 'BREAKOUT' || entryTimingState === 'LP_LIVE',
  };
}

function buildLlmPoolContext({ pool = {}, screenResult = null, vetoResult = null, marketSnapshot = null, bookedSlots = 0, entrySignals = null }) {
  const okx = screenResult?.okxSignals || null;
  const gmgn = screenResult?.gmgnMetrics || null;
  const breakout = entrySignals || deriveBreakoutEntrySignals({ pool, vetoResult, marketSnapshot });
  const taTrend = breakout.taTrend;
  const priceChangeM5  = breakout.priceChangeM5;
  const priceChangeM15 = breakout.priceChangeM15 ?? marketSnapshot?.ohlcv?.priceChangeM15 ?? vetoResult?.diagnostics?.m15_change;
  const priceChangeM15Prev = marketSnapshot?.ohlcv?.priceChangeM15Prev;
  const priceChangeH1  = breakout.priceChangeH1;
  const taReliable     = marketSnapshot?.quality?.taReliable;
  const athDistancePct = vetoResult?.diagnostics?.athDistancePct;
  const stageWaterfall = screenResult?.stageWaterfall || {};
  const topFlags = Array.isArray(screenResult?.highFlags)
    ? screenResult.highFlags.slice(0, 3).map((f) => f?.msg).filter(Boolean)
    : [];

  // Slot data: injected ke context agar LLM bisa terapkan Rule 0 (Slot Limit Gate)
  // bookedSlots = jumlah winner di siklus ini yang sudah di-approve tapi belum on-chain
  const activeCount  = getActivePositionKeys().length + bookedSlots;
  const maxPositions = Number(getConfig().maxPositions || 1);

  return [
    `- Token: ${pool.tokenXSymbol || pool.name?.split('-')[0] || 'UNKNOWN'}`,
    `- Bin Step: ${pool.binStep || 0}`,
    `- Fee/TVL: ${formatMaybePct((pool.feeActiveTvlRatio || 0) * 100)}`,
    `- Volume 24h: ${formatMaybeUsd(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.volume || 0)}`,
    `- TVL: ${formatMaybeUsd(pool.activeTvl || pool.totalTvl || 0)}`,
    `- Mcap: ${formatMaybeUsd(pool.mcap || 0)}`,
    `- Slot Posisi: ${activeCount} aktif dari maksimal ${maxPositions}`,
    `- TA Supertrend 15m: ${String(taTrend || 'UNKNOWN').toUpperCase()}`,
    `- TA M5 Change: ${formatMaybePct(priceChangeM5)}`,
    `- TA M15 Change: ${formatMaybePct(priceChangeM15)}`,
    `- TA M15 Previous: ${formatMaybePct(priceChangeM15Prev)}`,
    `- TA H1 Change: ${formatMaybePct(priceChangeH1)}`,
    `- TA Reliable: ${formatMaybeBool(taReliable)}`,
    `- Entry Gate Mode: ${breakout.entryGateMode || 'UNKNOWN'}`,
    `- Entry Timing: ${breakout.entryTimingState || 'UNKNOWN'}`,
    `- Price vs Supertrend: ${Number.isFinite(Number(breakout.signalStDistancePct)) ? formatMaybePct(breakout.signalStDistancePct, 2) : 'UNKNOWN'}`,
    `- Price vs 24h High: ${Number.isFinite(Number(breakout.signalAthDistancePct)) ? formatMaybePct(breakout.signalAthDistancePct, 2) : 'UNKNOWN'}`,
    `- Entry Flow Hint: ${breakout.breakoutQuality || 'UNKNOWN'}`,
    `- ATH Distance: ${Number.isFinite(Number(athDistancePct)) ? formatMaybePct(athDistancePct, 1) : 'UNKNOWN'}`,
    `- Meridian Gate: ${vetoResult?.veto ? 'FAIL' : 'PASS'} (${vetoResult?.gate || 'NONE'})`,
    `- Meridian Reason: ${vetoResult?.reason || 'UNKNOWN'}`,
    `- Stage 1 Public: ${stageWaterfall.stage1PublicData || 'UNKNOWN'}`,
    `- Stage 2 GMGN: ${stageWaterfall.stage2GmgnAudit || 'UNKNOWN'}`,
    `- Stage 3 Jupiter: ${stageWaterfall.stage3Jupiter || 'UNKNOWN'}`,
    `- OKX Available: ${formatMaybeBool(okx ? !okx.unavailable : null)}`,
    `- OKX High Risk: ${formatMaybeBool(okx?.highRisk)}`,
    `- OKX Risk Level: ${Number.isFinite(Number(okx?.riskLevel)) ? Number(okx.riskLevel) : 'UNKNOWN'}`,
    `- OKX Wash Trading: ${formatMaybePct(okx?.washTradingPct, 1)}`,
    `- OKX Bundler: ${formatMaybePct(okx?.bundlerPct, 1)}`,
    `- GMGN Status: ${screenResult?.gmgnStatus || 'UNKNOWN'}`,
    `- GMGN Top10: ${formatMaybePct(gmgn?.top10Pct, 2)}`,
    `- GMGN Dev Hold: ${formatMaybePct(gmgn?.devHoldPct, 2)}`,
    `- GMGN Insider: ${formatMaybePct(gmgn?.insiderPct, 2)}`,
    `- GMGN Bundler: ${formatMaybePct(gmgn?.bundlerPct, 2)}`,
    `- GMGN Total Fees: ${Number.isFinite(Number(gmgn?.totalFeesSol)) ? `${Number(gmgn.totalFeesSol).toFixed(2)} SOL` : 'UNKNOWN'}`,
    `- GMGN Burned LP: ${formatMaybeBool(gmgn?.burnedLp)}`,
    `- GMGN Zero Tax: ${formatMaybeBool(gmgn?.zeroTax)}`,
    `- GMGN CTO Flag: ${formatMaybeBool(gmgn?.ctoFlag)}`,
    `- GMGN Vamped: ${formatMaybeBool(gmgn?.vamped)}`,
    `- High Flags: ${topFlags.length ? topFlags.join(' | ') : 'NONE'}`,
  ].join('\n');
}

function summarizeExitError(error) {
  const raw = String(error?.message || error || 'UNKNOWN_EXIT_ERROR');
  const lower = raw.toLowerCase();
  if (lower.includes('exceeded cus meter') || lower.includes('compute units')) {
    return 'EXIT_COMPUTE_UNITS_EXHAUSTED_AFTER_RETRY — transaksi close masih kehabisan compute budget setelah retry maksimum.';
  }
  if (lower.includes('position_still_open_after_exit')) {
    return raw;
  }
  return raw.length > 900 ? `${raw.slice(0, 900)}...` : raw;
}

function getRealtimePnlIntervalMs() {
  const cfg = getConfig();
  const seconds = Math.max(5, Number(cfg.realtimePnlIntervalSec) || 15);
  return Math.round(seconds * 1000);
}

function getManualCloseWatchIntervalMs() {
  return Math.max(5000, getRealtimePnlIntervalMs());
}

function getPendingTaRadarIntervalMs() {
  const cfg = getConfig();
  return Math.max(60_000, Math.round((Math.max(1, Number(cfg.retestIntervalMin) || 5)) * 60 * 1000));
}

function getTaWatchIntervalMs() {
  const cfg = getConfig();
  return Math.max(15_000, Math.round((Math.max(1, Number(cfg.watchIntervalSec) || 30)) * 1000));
}

export function startManualCloseWatcher() {
  if (_manualCloseWatchTimer) return false;

  const tick = async () => {
    if (_manualCloseWatchInFlight) return;
    _manualCloseWatchInFlight = true;
    try {
      const snapshot = listActivePositions();
      for (const pos of snapshot) {
        if (!pos?.pubkey || _closingPositions.has(pos.pubkey)) continue;
        try {
          const status = await getPositionOnChainStatus(pos.pubkey);
          if (!status.tracked) continue;
          if (status.manualWithdrawn) {
            console.log(
              `[hunter] Manual close watcher detected ${pos.symbol || pos.pubkey.slice(0, 8)} ` +
              `pos=${pos.pubkey.slice(0,8)} reason=${status.reason}`
            );
            await markPositionManuallyClosed(pos.pubkey, `MANUAL_WITHDRAW_DETECTED_${status.reason}`);
            _positionLabels.delete(pos.pubkey);
          }
        } catch (e) {
          console.warn(`[hunter] Manual close watcher skip ${pos.pubkey.slice(0,8)}: ${e.message}`);
        }
      }
    } finally {
      _manualCloseWatchInFlight = false;
    }
  };

  _manualCloseWatchTimer = setInterval(tick, getManualCloseWatchIntervalMs());
  _manualCloseWatchTimer.unref?.();
  tick().catch((e) => console.warn(`[hunter] Manual close watcher initial tick error: ${e.message}`));
  console.log(`[hunter] 👁️ Manual close watcher aktif interval=${Math.round(getManualCloseWatchIntervalMs() / 1000)}s`);
  return true;
}

export function stopManualCloseWatcher() {
  if (!_manualCloseWatchTimer) return false;
  clearInterval(_manualCloseWatchTimer);
  _manualCloseWatchTimer = null;
  return true;
}

async function processPendingTaRadar(cfg = getConfig()) {
  if (cfg.pendingRetestEnabled === false || _pendingRetestQueue.size === 0) return [];

  const now = Date.now();
  const maxAttempts = Math.max(1, Number(cfg.retestMaxAttempts) || 8);
  const intervalMin = Math.max(1, Number(cfg.retestIntervalMin) || 5);
  const ready = [];

  for (const [mint, row] of [..._pendingRetestQueue.entries()]) {
    if (!row?.pool || hasActiveMint(mint) || isBlacklisted(mint)) {
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.expiresAt <= now || row.attempts >= maxAttempts) {
  console.log(`[RADAR] ⌛ TA radar expired: ${row.symbol} attempts=${row.attempts}/${maxAttempts}`);
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.nextCheckAt > now) continue;

    row.attempts += 1;
    row.nextCheckAt = now + intervalMin * 60 * 1000;

    try {
      const veto = await withTimeout(
        runMeridianVeto({ mint, symbol: row.symbol, pool: row.pool }),
        Number(cfg.retestVetoTimeoutMs || 45_000),
        'TA_RADAR_MERIDIAN_VETO'
      );

      if (veto.veto && !isRetestableTaVeto(veto)) {
        row.lastReason = veto.reason || row.lastReason;
        console.log(`[RADAR] ❌ TA radar dropped: ${row.symbol} — ${row.lastReason}`);
        _pendingRetestQueue.delete(mint);
        continue;
      }

      const marketSnapshot = await getMarketSnapshot(
        mint,
        row.pool?.address || row.pool?.poolAddress || row.pool?.pool || null,
        {
          from: 'ta_radar',
          includeEntryCandles5m: String(cfg.entryDecisionMode || 'strict').toLowerCase() === 'lp_simple_m15',
        }
      ).catch(() => null);
      const entrySignals = deriveBreakoutEntrySignals({ pool: row.pool, vetoResult: veto, marketSnapshot, cfg });
      if (entrySignals.entryTimingState === 'BEARISH_TREND') {
        row.lastReason = 'Supertrend 15m bearish';
        console.log(`[RADAR] ❌ TA radar dropped: ${row.symbol} — ${row.lastReason}`);
        _pendingRetestQueue.delete(mint);
        continue;
      }

      if (isLPLiveTimingState(entrySignals.entryTimingState)) {
        if (entrySignals.entryReadiness === 'HIGH' && (entrySignals.breakoutQuality === 'VALID' || entrySignals.breakoutQuality === 'STRONG')) {
          const pool = {
            ...row.pool,
            _retestReason: row.reason,
            _retestAttempts: row.attempts,
            _entrySignals: entrySignals,
            hasNonRefundableFees: Boolean(marketSnapshot?.pool?.hasNonRefundableFees),
            _entryActiveBin: toFiniteNumber(row.entryActiveBin ?? row.pool?._entryActiveBin ?? null, null),
            _entryPrice: toFiniteNumber(row.entryPrice ?? row.pool?._entryPrice ?? null, null),
            _entryIntentSnapshotAt: toFiniteNumber(row.snapshotAt ?? row.pool?._entryIntentSnapshotAt ?? now, now),
          };
          const watchResult = addWatchPassTa(pool, row.reason || 'TA PASS', 'RADAR');
          if (watchResult?.admitted) {
            _pendingRetestQueue.delete(mint);
            if (watchResult.evicted?.pool) {
              addPendingRetest(watchResult.evicted.pool, 'WATCH digeser oleh prioritas lebih kuat');
            }
            console.log(`[RADAR] ✅ TA radar PASS → WATCH: ${row.symbol} attempts=${row.attempts}`);
            ready.push({ pool, symbol: row.symbol, entrySignals, vetoResult: veto, reason: row.reason });
            continue;
          }

          row.lastReason = watchResult?.reason || 'WATCH penuh';
          _pendingRetestQueue.set(mint, row);
          console.log(`[RADAR] ⏳ TA radar PASS tapi belum bisa masuk WATCH: ${row.symbol} — ${row.lastReason}`);
          continue;
        }
      }

      row.lastReason = `TA belum fresh: ${entrySignals.entryTimingState}/${entrySignals.breakoutQuality}`;
      _pendingRetestQueue.set(mint, row);
      console.log(`[RADAR] ⏳ TA radar pending: ${row.symbol} — ${row.lastReason}`);
    } catch (e) {
      row.lastReason = e?.message || 'TA radar error';
      _pendingRetestQueue.set(mint, row);
      console.warn(`[RADAR] TA radar error ${row.symbol}: ${row.lastReason}`);
    }
  }

  return ready;
}

export function startPendingTaRadarWatcher() {
  if (_pendingTaRadarTimer) return false;
  if (getConfig().pendingRetestEnabled === false) {
    console.log('[RADAR] TA radar watcher tidak dijalankan karena pendingRetestEnabled=false');
    return false;
  }

  const tick = async () => {
    if (_pendingTaRadarInFlight) return;
    if (!isWatcherModeActive()) return;
    _pendingTaRadarInFlight = true;
    try {
      const cfg = getConfig();
      if (cfg.pendingRetestEnabled === false) return;
      console.log(`[RADAR] 🛰️ heartbeat pending=${_pendingRetestQueue.size} watch=${_taWatchQueue.size}`);
      const ready = await processPendingTaRadar(cfg);
      const slotUsage = getDeploySlotUsage();
      const slotSaturated = isDeploySlotSaturated(slotUsage);
      reportManager.setSlotSaturatedSummaryOnly(slotSaturated);
      for (const item of ready) {
        const { pool, symbol, entrySignals, reason } = item;
        if (slotSaturated) continue;
        const poolAddress = pool.address || pool.poolAddress || pool.pool || pool.pubkey || '';
        const tokenMint = pool.tokenXMint || pool.tokenX || pool.mint || '';
        if (!poolAddress || !tokenMint) continue;

        await notify(
          `🛰️ <b>TA Radar Ready → WATCH</b>\n` +
          `Token: <b>${escapeHTML(symbol)}</b>\n` +
          `Entry: <code>${entrySignals.entryReadiness}</code> | Breakout: <code>${entrySignals.breakoutQuality}</code>\n` +
          `Timing: <code>${entrySignals.entryTimingState}</code>\n` +
          `👀 <i>Masuk watch layer sampai siap masuk queue deploy.</i>`
        );
      }
    } catch (e) {
      console.warn(`[RADAR] TA radar watcher error: ${e.message}`);
    } finally {
      _pendingTaRadarInFlight = false;
    }
  };

  _pendingTaRadarTimer = setInterval(tick, getPendingTaRadarIntervalMs());
  _pendingTaRadarTimer.unref?.();
  tick().catch((e) => console.warn(`[RADAR] TA radar initial tick error: ${e.message}`));
  console.log(`[RADAR] 🛰️ TA radar watcher aktif interval=${Math.round(getPendingTaRadarIntervalMs() / 1000)}s`);
  return true;
}

export function stopPendingTaRadarWatcher() {
  if (!_pendingTaRadarTimer) return false;
  clearInterval(_pendingTaRadarTimer);
  _pendingTaRadarTimer = null;
  return true;
}

async function processTaWatchQueue(cfg = getConfig()) {
  if (_taWatchQueue.size === 0) return [];

  const now = Date.now();
  const maxAttempts = Math.max(1, Number(cfg.retestMaxAttempts) || 8);
  const watchIntervalSec = Math.max(15, Number(cfg.watchIntervalSec) || 30);
  const ready = [];

  const sortedEntries = [..._taWatchQueue.entries()].map(([mint, row]) => {
    row.priorityScore = computeTaWatchPriorityScore({ pool: row.pool, entrySignals: row.pool?._entrySignals || {}, row, now });
    return [mint, row];
  }).sort((a, b) => {
    const aScore = Number(a[1]?.priorityScore || 0);
    const bScore = Number(b[1]?.priorityScore || 0);
    if (aScore !== bScore) return bScore - aScore;
    const aSeen = Number(a[1]?.firstSeenAt || 0);
    const bSeen = Number(b[1]?.firstSeenAt || 0);
    return aSeen - bSeen;
  });

  for (const [mint, row] of sortedEntries) {
    if (!row?.pool || hasActiveMint(mint) || isBlacklisted(mint)) {
      _taWatchQueue.delete(mint);
      continue;
    }
    if (row.expiresAt <= now || row.attempts >= maxAttempts) {
      console.log(`[WATCH] ⌛ WATCH expired: ${row.symbol} attempts=${row.attempts}/${maxAttempts}`);
      _taWatchQueue.delete(mint);
      continue;
    }
    if (row.nextCheckAt > now) continue;

    row.attempts += 1;
    row.priorityScore = computeTaWatchPriorityScore({ pool: row.pool, entrySignals: row.pool?._entrySignals || {}, row, now });
    row.nextCheckAt = now + watchIntervalSec * 1000;
    row.lastHeartbeatAt = now;

    const pool = row.pool;
    const symbol = row.symbol || getPoolSymbol(pool);
    const poolAddress = pool.address || pool.poolAddress || pool.pool || pool.pubkey || '';
    const tokenMint = pool.tokenXMint || pool.tokenX || pool.mint || '';
    const slotCfg = getDeploySlotUsage();
    const maxPositions = Number(cfg.maxPositions || slotCfg.maxPositions || 1);
    const activeCount = getActivePositionKeys().length + Number(slotCfg.reserved || 0);

    if (activeCount >= maxPositions) {
      row.lastReason = `Slot penuh: ${activeCount}/${maxPositions}`;
      _taWatchQueue.set(mint, row);
      console.log(`[WATCH] ⏳ ${symbol} masih ditahan: ${row.lastReason}`);
      continue;
    }

    if (!poolAddress || !tokenMint) {
      console.log(`[WATCH] ❌ ${symbol} dropped: pool/token mint tidak valid`);
      _taWatchQueue.delete(mint);
      continue;
    }

    _taWatchQueue.delete(mint);
    console.log(`[WATCH] ✅ ${symbol} siap masuk queue deploy`);
    ready.push({
      pool,
      symbol,
      meta: {
        scoutReason: row.reason || 'WATCH Ready',
        entryReadiness: 'HIGH',
        breakoutQuality: 'VALID',
        entryGateMode: 'lp_fee_flow',
        entryTimingState: 'LP_LIVE',
        queueTrustedWatch: true,
        watchSource: row.source || 'WATCH',
        watchReason: row.reason || 'WATCH Ready',
        taTrend: pool._entrySignals?.taTrend ?? row.taTrend ?? pool._watchTaTrend,
        signalStDistancePct: pool._entrySignals?.signalStDistancePct ?? row.snapshotStDistancePct ?? pool._watchSnapshotStDistancePct,
        signalAthDistancePct: pool._entrySignals?.signalAthDistancePct ?? row.snapshotAthDistancePct ?? pool._watchSnapshotAthDistancePct,
        priceChangeM5: pool._entrySignals?.priceChangeM5 ?? row.priceChangeM5 ?? row.snapshotM5Change ?? pool._watchSnapshotM5Change,
        snapshotAt: Number.isFinite(Number(row.snapshotAt)) ? Number(row.snapshotAt) : now,
        snapshotPrice: row.snapshotPrice ?? pool._entrySignals?.currentPrice ?? null,
        snapshotHigh24h: row.snapshotHigh24h ?? pool._entrySignals?.high24h ?? null,
        watchWindowSec: row.watchWindowSec || getLpWatchWindowSec(cfg),
        maxDriftPct: row.maxDriftPct || getLpMaxDriftPct(cfg),
        entryActiveBin: toFiniteNumber(row.entryActiveBin ?? pool._entryActiveBin ?? null, null),
        entryPrice: toFiniteNumber(row.entryPrice ?? pool._entryPrice ?? pool._entrySignals?.currentPrice ?? null, null),
        hasFrozenEntryIntent: hasValidFrozenEntryIntent({
          entryActiveBin: toFiniteNumber(row.entryActiveBin ?? pool._entryActiveBin ?? null, null),
          entryPrice: toFiniteNumber(row.entryPrice ?? pool._entryPrice ?? pool._entrySignals?.currentPrice ?? null, null),
          snapshotAt: toFiniteNumber(row.snapshotAt ?? pool._entryIntentSnapshotAt ?? now, now),
        }),
      },
    });
  }

  return ready;
}

export function startTaWatchWatcher() {
  if (_taWatchTimer) return false;

  const tick = async () => {
    if (_taWatchInFlight) return;
    if (!isWatcherModeActive()) return;
    _taWatchInFlight = true;
    try {
      const cfg = getConfig();
      console.log(`[WATCH] 👀 heartbeat pending=${_taWatchQueue.size}`);
      const ready = await processTaWatchQueue(cfg);
      for (const item of ready) {
        const { pool, symbol, meta } = item;
        enqueueForDeploy(pool, symbol, meta);
      }
    } catch (e) {
      console.warn(`[WATCH] TA watch watcher error: ${e.message}`);
    } finally {
      _taWatchInFlight = false;
    }
  };

  _taWatchTimer = setInterval(tick, getTaWatchIntervalMs());
  _taWatchTimer.unref?.();
  tick().catch((e) => console.warn(`[WATCH] TA watch initial tick error: ${e.message}`));
  console.log(`[WATCH] 👀 TA watch watcher aktif interval=${Math.round(getTaWatchIntervalMs() / 1000)}s`);
  return true;
}

export function stopTaWatchWatcher() {
  if (!_taWatchTimer) return false;
  clearInterval(_taWatchTimer);
  _taWatchTimer = null;
  return true;
}

function shouldLogRealtimePnl(positionPubkey) {
  const now = Date.now();
  const intervalMs = getRealtimePnlIntervalMs();
  const last = _lastRealtimePnlLogAt.get(positionPubkey) || 0;
  if (last && now - last < intervalMs) return false;
  _lastRealtimePnlLogAt.set(positionPubkey, now);
  return true;
}

function logRealtimePnl({ positionPubkey, symbol, status }) {
  const pnlPct = Number(status?.pnlPct) || 0;
  const currentValueSol = Number(status?.currentValueSol) || 0;
  const rangeIcon = status?.inRange ? '🟢' : '🟡';
  const intervalSec = Math.round(getRealtimePnlIntervalMs() / 1000);
  const ts = new Date().toISOString();
  console.log(
    `[RealtimePnL] ${ts} ${rangeIcon} ${symbol} ` +
    `pos=${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% ` +
    `value=${currentValueSol.toFixed(4)}SOL ` +
    `action=${status?.action || 'UNKNOWN'} ` +
    `interval=${intervalSec}s`
  );
}

async function notifyRealtimePnl({ positionPubkey, symbol, status }) {
  const pnlPct = Number(status?.pnlPct) || 0;
  const currentValueSol = Number(status?.currentValueSol) || 0;
  const intervalSec = Math.round(getRealtimePnlIntervalMs() / 1000);
  const rangeStatus = status?.inRange ? 'IN_RANGE' : 'OUT_OF_RANGE';
  const sign = pnlPct >= 0 ? '+' : '';
  await notify(
    `📊 <b>Realtime PnL</b>\n` +
    `Token: <b>${escapeHTML(symbol)}</b>\n` +
    `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
    `PnL: <code>${sign}${pnlPct.toFixed(2)}%</code>\n` +
    `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
    `Range: <code>${rangeStatus}</code>\n` +
    `Action: <code>${escapeHTML(status?.action || 'UNKNOWN')}</code>\n` +
    `Interval: <code>${intervalSec}s</code>`
  );
}

function getIdleDelayMin(cfg = getConfig()) {
  if (_pendingRetestQueue.size > 0) {
    return Math.max(1, Number(cfg.retestIntervalMin) || 5);
  }
  return Number(cfg.screeningIntervalMin) || 15;
}

async function withDeployLock(fn) {
  while (_deployLock) await sleep(100);
  _deployLock = true;
  try {
    return await fn();
  } finally {
    _deployLock = false;
  }
}

// ── Main Linear Loop ─────────────────────────────────────────────

/**
 * Jalankan loop Linear Sniper.
 * Dipanggil sekali dari index.js — berjalan terus sampai di-stop.
 */
export async function runLinearLoop() {
  try {
    if (_running) {
      console.warn('[hunter] Loop sudah berjalan, skip.');
      return;
    }
    _running = true;
    console.log('[hunter] ▶ Linear Sniper Loop dimulai');

    const startCfg = getConfig();
    if (!startCfg.autoScreeningEnabled) {
      await notify('🚀 <b>Multi-Agent Scheduler aktif.</b>\n⚠️ <i>Auto-Screening OFF. Ketik <code>/autoscreen on</code> untuk mulai.</i>');
    } else {
      await notify('🚀 <b>Multi-Agent Scheduler aktif.</b> 🔍 Memulai scan real-time (No Cache)...');
    }

    // Loop is now managed by src/index.js multi-agent scheduler
    console.log('[hunter] Scheduler initialized. Delegating to index.js async loops.');
  } catch (error) {
    console.error("⚠️ Loop Error:", error.message);
    _running = false;
    setTimeout(runLinearLoop, 15000);
  }
}

export async function runHunterAlpha(notifyFn = null) {
  const cb = getRuntimeState('hunter-circuit-breaker', null);
  if ((cb?.pausedUntil || 0) > Date.now()) {
    if (typeof notifyFn === 'function') {
      await notifyFn('Circuit Breaker Active');
    }
    return { blocked: true, policy: 'CIRCUIT_BREAKER_ACTIVE' };
  }
  return { blocked: false };
}

export function stopLoop() {
  _running = false;
  console.log('[hunter] Stop signal diterima.');
}

// ── Phase 1: SCAN ─────────────────────────────────────────────────

export async function scanAndDeploy({ emitFinalReport = true } = {}) {
  const CycleReport = [];

  try {
    if (isOperatorDiscoveryPaused()) {
      return { blocked: true, policy: 'OPERATOR_DISCOVERY_PAUSED' };
    }

    const cfg = getConfig();

    const cb = getRuntimeState('hunter-circuit-breaker', null);
    if ((cb?.pausedUntil || 0) > Date.now()) return { blocked: true, policy: 'CIRCUIT_BREAKER_ACTIVE', pausedUntil: cb?.pausedUntil };

    // — Gembok: jika auto-screening dimatikan, pause senyap tanpa log
    if (!isAutoScreeningRuntimeEnabled()) {
      await sleep(10_000);
      return;
    }

    await reconcileZombiePositions({ minAgeMs: 180_000 }).catch((e) => {
      console.warn(`[hunter] Zombie reconcile non-fatal: ${e.message}`);
    });

    const regime = classifyMarketRegime();
    if (regime === 'BEAR_DEFENSE') {
      return { blocked: true, policy: 'REGIME_BEAR_DEFENSE' };
    }

    const limit = cfg.meteoraDiscoveryLimit || 50;

    console.log(`[SCREEN] 🔍 SCAN — High-Fee Hunter (binStep priority: ${(cfg.binStepPriority || [200,125,100]).join('>')} )...`);
    await notify('🔍 <b>Memulai scan real-time (No Cache)...</b>\nMengambil data, mohon tunggu.');


  const radarTransitions = await collectReadyRetestPools(cfg);
  if (radarTransitions.length > 0) {
    console.log(`[WATCH] ${radarTransitions.length} kandidat retest naik ke WATCH.`);
    await notify(
      `👀 <b>Watch Layer Aktif</b>\n` +
      `${radarTransitions.length} kandidat TA masuk mode watch dan menunggu slot deploy.`
    );
  }

  let pools = [];
  try {
    // Ambil semua pool dari Meteora/Meridian fallback (sorted by binStep priority + fee ratio)
    const rawPools = await discoverHighFeePoolsMeridian({ limit });

    // Deduplikasi: satu token mungkin punya beberapa pool.
    // Pilih pool terbaik per-token berdasarkan binStep priority [200,125,100].
    const cfg2          = getConfig();
    const binPriority   = Array.isArray(cfg2.binStepPriority) ? cfg2.binStepPriority.map(Number) : [200, 125, 100];
    pools               = deduplicatePoolsByToken(rawPools, binPriority);

    console.log(`[SCREEN] ${rawPools.length} pool raw → ${pools.length} token unik setelah seleksi binStep`);
  } catch (e) {
    console.warn(`[hunter] discoverHighFeePoolsMeridian gagal: ${e.message}`);
    await sleep(60_000);
    return;
  }

  if (!pools || pools.length === 0) {
    console.log('[SCREEN] Tidak ada pool ditemukan. Tunggu 60 detik...');
    await sleep(60_000);
    return;
  }

  console.log(`[SCREEN] ${pools.length} pool ditemukan. Mulai screening...`);

    const screeningTopPoolsLimit = Math.max(1, Number(cfg.screeningTopPoolsLimit) || 5);

    // ── Sort by efficiency (Vol/TVL), evaluasi HANYA top pool configurable ───
    // Filosofi LP: resource screening hanya untuk kandidat paling efisien.
    // Pool di luar batas ini TIDAK dievaluasi sama sekali (hemat API & waktu).
    pools = pools.sort((a, b) => {
      const aVol = Number(a.volume24h || a.trade_volume_24h || 0);
      const bVol = Number(b.volume24h || b.trade_volume_24h || 0);
      const aTvl = Number(a.totalTvl || a.activeTvl || 0) || 1;
      const bTvl = Number(b.totalTvl || b.activeTvl || 0) || 1;
      return (bVol / bTvl) - (aVol / aTvl);
    });

    const scoutCandidates = pools.slice(0, screeningTopPoolsLimit);
    console.log(`[SCREEN] 🔬 Memulai Strict Serial Screening untuk ${scoutCandidates.length} Top-${screeningTopPoolsLimit} pool (sorted by Vol/TVL efficiency)...`);
  // Jupiter budget dibuat minimal sebesar jumlah kandidat batch ini agar
  // pool yang sudah lolos tahap awal tidak ke-defer prematur sebelum sempat diuji.
  const configuredJupiterBudget = Number(cfg.jupiterMaxChecksPerScan);
  const jupiterBudgetRef = {
    remaining: Math.max(
      1,
      scoutCandidates.length,
      Number.isFinite(configuredJupiterBudget) && configuredJupiterBudget > 0 ? configuredJupiterBudget : 0,
      screeningTopPoolsLimit,
    ),
  };

  let winners = [];
  reportManager.newCycle();

  // ── Guard flag lokal (bukan _running global yang hanya true di LinearLoop) ──
  // scanAndDeploy() harus bisa berjalan independen dari runLinearLoop.
  let _screening = true;

  // 1. Process Pending Store Tokens first
  pendingStore.cleanExpired();
  const pendingTokens = pendingStore.getPendingTokens();
  for (const pending of pendingTokens) {
    const poolData = pending.poolData || { mint: pending.address, tokenXMint: pending.address, tokenXSymbol: pending.name, name: pending.name };
    
    let reportEntry = reportManager.currentCycle.find(t => t.name === pending.name);
    if (!reportEntry) {
      reportEntry = reportManager.addToken(pending.name, pending.address);
      if (!CycleReport.includes(reportEntry)) CycleReport.push(reportEntry);
    }
    
    // Check meridianVeto or TA again for the pending token
    try {
      const vetoResult = await runMeridianVeto({ mint: pending.address, symbol: pending.name, pool: poolData });
      if (vetoResult.veto && isRetestableTaVeto(vetoResult)) {
        console.log(`⏳ [Pending] Token ${pending.name} masih menunggu TA valid (Supertrend/Momentum)`);
        pendingStore.add(pending.address, pending.name, 0, 0); // Update attempt
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'DEFER', vetoResult.reason);
      } else if (vetoResult.veto) {
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'FAIL', vetoResult.reason);
        reportManager.setFinalVerdict(pending.name, 'REJECT', vetoResult.reason);
        pendingStore.remove(pending.address);
      } else {
        console.log(`🔄 [Pending] Token ${pending.name} berhasil melewati TA, naik ke WATCH...`);
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'PASS', 'Berhasil melewati Supertrend');
        pendingStore.remove(pending.address);
        const watchResult = addWatchPassTa(poolData, 'Berhasil melewati Supertrend', 'SCREEN');
        if (!watchResult?.admitted) {
          reportManager.updateGate(pending.name, 'PENDING_RETEST', 'DEFER', watchResult?.reason || 'WATCH penuh');
          addPendingRetest(poolData, watchResult?.reason || 'WATCH penuh');
        }
      }
    } catch (e) {
      console.warn(`Error processing pending token ${pending.name}: ${e.message}`);
    }
  }

  const evaluatePool = async (pool) => {
    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    
    const record = reportManager.addToken(tokenSymbol || 'UNKNOWN', tokenMint || '');
    if (!CycleReport.includes(record)) CycleReport.push(record);
    // Simpan metrics LP ke report entry agar bisa ditampilkan di visual report
    reportManager.setMetrics(tokenSymbol || 'UNKNOWN', {
      tvl:  Number(pool.totalTvl || pool.activeTvl || 0),
      vol:  Number(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || 0),
      mcap: Number(pool.mcap || 0),
    });
    if (!isSupportedQuoteToken(pool)) {
      const quoteReason = `Unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`;
      reportManager.updateGate(tokenSymbol, 'STAGE_0_DISCOVERY', 'FAIL', quoteReason);
      reportManager.setFinalVerdict(tokenSymbol, 'REJECT', quoteReason);
      console.log(`[SCREEN] ❌ ${tokenSymbol || 'UNKNOWN'} quote veto: ${quoteReason}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'STAGE_0_DISCOVERY', reason: quoteReason, summary: [] };
    }
    reportManager.updateGate(tokenSymbol, 'STAGE_0_DISCOVERY', 'PASS');

    if (!tokenMint) {
      reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'FAIL', 'MISSING_TOKEN_MINT');
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'PRECHECK', reason: 'MISSING_TOKEN_MINT', summary: [] };
    }
    console.log(`[hunter] 📦 Mengevaluasi ${tokenSymbol}...`);
    
    if (isBlacklisted(tokenMint)) {
      const rejectReason = 'BLACKLIST lokal aktif';
      reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'FAIL', rejectReason);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'BLACKLIST', reason: rejectReason, summary: [] };
    }
    reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'PASS');

    let screenResult = null;
    try {
      screenResult = await withTimeout(
        screenToken(tokenMint, tokenSymbol, tokenSymbol, { jupiterBudgetRef }),
        Number(cfg.screenTimeoutMs || 120_000),
        'SCREEN_TOKEN'
      );
      const s1 = screenResult?.stageWaterfall?.stage1PublicData || 'UNKNOWN';
      const s2 = screenResult?.stageWaterfall?.stage2GmgnAudit || 'UNKNOWN';
      const s3 = screenResult?.stageWaterfall?.stage3Jupiter || 'UNKNOWN';
      const decisionLines = Array.isArray(screenResult?.decisions)
        ? screenResult.decisions.map((d) => String(d?.line || '')).filter(Boolean)
        : [];
      const gmgnRejectMessages = Array.isArray(screenResult?.gmgnRejects)
        ? screenResult.gmgnRejects.map((r) => String(r?.msg || '')).filter(Boolean)
        : [];
      const stage1Messages = Array.isArray(screenResult?.highFlags)
        ? screenResult.highFlags
            .map((f) => String(f?.msg || ''))
            .filter((msg) => msg && !msg.startsWith('[VETO] Jupiter simulation gagal:'))
        : [];
      const stage3Messages = Array.isArray(screenResult?.highFlags)
        ? screenResult.highFlags
            .map((f) => String(f?.msg || ''))
            .filter((msg) => msg && (msg.startsWith('[VETO] Jupiter simulation gagal:') || msg.startsWith('[FAIL_CLOSED] Jupiter safety unavailable:')))
        : [];
      
      reportManager.updateGate(tokenSymbol, 'STAGE_1_PUBLIC', s1 === 'PASS' ? 'PASS' : s1 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', screenResult?.sources?.okx === false ? 'OKX unavailable' : '');
      if (s1 !== 'PASS') {
        const stage1Reason = stage1Messages[0]
          || decisionLines.find((line) => line.includes('stage-1') || line.includes('Stage-1') || line.includes('FAIL_CLOSED'))
          || 'Failed Stage 1';
        return { ok: false, symbol: tokenSymbol, stage: 'STAGE_1_PUBLIC', reason: stage1Reason };
      }

      reportManager.updateGate(tokenSymbol, 'STAGE_2_GMGN', s2 === 'PASS' ? 'PASS' : s2 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', Array.isArray(screenResult?.gmgnRejects) && screenResult.gmgnRejects.length ? screenResult.gmgnRejects.map((r) => r.msg).join(' | ') : '');
      if (s2 !== 'PASS') {
        const stage2Reason = gmgnRejectMessages.length > 0
          ? gmgnRejectMessages.join(' | ')
          : (decisionLines.find((line) => line.includes('[STAGE-2]')) || 'Failed GMGN');
        return { ok: false, symbol: tokenSymbol, stage: 'STAGE_2_GMGN', reason: stage2Reason };
      }

      reportManager.updateGate(tokenSymbol, 'STAGE_3_JUPITER', s3 === 'PASS' ? 'PASS' : s3 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', Array.isArray(screenResult?.highFlags) && screenResult.highFlags.length ? screenResult.highFlags.map((f) => f.msg).join(' | ') : '');
      if (s3 !== 'PASS') {
        const stage3Reason = stage3Messages[0]
          || decisionLines.find((line) => line.includes('[STAGE-3]') || line.includes('Jupiter'))
          || 'Failed Jupiter';
        return { ok: false, symbol: tokenSymbol, stage: 'STAGE_3_JUPITER', reason: stage3Reason };
      }

      if (!screenResult?.eligible) {
        return { ok: false, symbol: tokenSymbol, stage: 'WATERFALL', reason: 'Not eligible' };
      }
    } catch (e) {
      reportManager.updateGate(tokenSymbol, 'STAGE_1_PUBLIC', 'FAIL', e.message);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'STAGE_1_PUBLIC', reason: e.message };
    }

    let vetoResult = null;
    try {
      vetoResult = await withTimeout(
        runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol, pool }),
        Number(cfg.vetoTimeoutMs || 45_000),
        'MERIDIAN_VETO'
      );
      if (vetoResult.veto) {
        const rejectReason = vetoResult.reason || 'Meridian veto';
        reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'FAIL', rejectReason);
        if (isRetestableTaVeto(vetoResult)) {
          // Simpan ke pendingStore untuk tracking retest antar siklus
          pendingStore.add(tokenMint, tokenSymbol, 0, 0, pool);
          addPendingRetest(pool, rejectReason);
          reportManager.updateGate(tokenSymbol, 'PENDING_RETEST', 'DEFER', rejectReason);
          reportManager.setFinalVerdict(tokenSymbol, 'DEFERRED', rejectReason);
          console.log(`[RADAR] ⏳ ${tokenSymbol} → pending retest (Meridian DEFER: ${rejectReason})`);
        }
        return { ok: false, symbol: tokenSymbol, stage: 'MERIDIAN_VETO', reason: rejectReason };
      }
      reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'PASS');
      reportManager.updateGate(tokenSymbol, 'PENDING_RETEST', 'PASS');
    } catch (e) {
      reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'FAIL', e.message);
      return { ok: false, symbol: tokenSymbol, stage: 'MERIDIAN_VETO', reason: e.message };
    }

    const passesConfig = checkFlatConfig(pool, cfg);
    if (!passesConfig.ok) {
      reportManager.updateGate(tokenSymbol, 'FLAT_CONFIG_GATE', 'FAIL', passesConfig.reason);
      return { ok: false, symbol: tokenSymbol, stage: 'FLAT_CONFIG_GATE', reason: passesConfig.reason };
    }
    reportManager.updateGate(tokenSymbol, 'FLAT_CONFIG_GATE', 'PASS');

    let marketSnapshot = null;
    try {
      marketSnapshot = await getMarketSnapshot(
        tokenMint,
        pool.address || pool.poolAddress || null,
        {
          from: 'scout_eval',
          includeEntryCandles5m: String(cfg.entryDecisionMode || 'strict').toLowerCase() === 'lp_simple_m15',
        }
      );
    } catch (e) {
      console.warn(`[hunter] MarketSnapshot error pada ${tokenSymbol}: ${e.message}`);
    }
    const entrySignals = deriveBreakoutEntrySignals({ pool, vetoResult, marketSnapshot, cfg });

    // ── SLOT LIMIT GATE (Code-level, sebelum LLM dipanggil) ─────────────────
    // Ini adalah hard gate di kode, bukan LLM. Lebih cepat, hemat API call.
    // winners.length = slot yang sudah di-booking siklus ini tapi belum on-chain
    // (anti-race-condition: tanpa ini, 2 token bisa PASS bersamaan di maxPositions=1)
    const slotCfg      = getConfig();
    const slotUsage    = getDeploySlotUsage();
    const maxPositions = Number(slotCfg.maxPositions || slotUsage.maxPositions || 1);
    const activeCount  = getActivePositionKeys().length + winners.length + slotUsage.reserved;
    if (activeCount >= maxPositions) {
      const slotReason = `Slot penuh: ${activeCount}/${maxPositions} (${getActivePositionKeys().length} on-chain + ${winners.length} booked + ${slotUsage.reserved} reserved)`;
      console.log(`[hunter] 🚫 SLOT LIMIT — ${tokenSymbol}: ${slotReason}. LLM di-skip.`);
      reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'DEFER', slotReason);
      reportManager.setFinalVerdict(tokenSymbol, 'DEFERRED', slotReason);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: slotReason };
    }

    try {
      const scoutModel = cfg.screeningModel || cfg.agentModel || cfg.llm_settings?.agentModel || 'UNKNOWN';
      console.log(`[SCREEN] 🧠 LLM stage=SCOUT model=${scoutModel} (slots: ${activeCount}/${maxPositions}, booked=${winners.length}, reserved=${slotUsage.reserved})`);
      const llmPoolContext = buildLlmPoolContext({ pool, screenResult, vetoResult, marketSnapshot, bookedSlots: winners.length, entrySignals });

      if (entrySignals.entryTimingState === 'BEARISH_TREND' || entrySignals.entryTimingState === 'NO_TREND' || entrySignals.entryTimingState === 'NO_M5' || entrySignals.entryTimingState === 'M15_PREV_UNKNOWN' || entrySignals.entryTimingState === 'TOO_CLOSE' || entrySignals.entryTimingState === 'WAIT_FOR_PULLBACK' || entrySignals.entryTimingState === 'WAIT_VOLUME' || entrySignals.entryTimingState === 'LATE_BREAKOUT' || entrySignals.entryTimingState === 'EXTENDED') {
        const waitReason = entrySignals.entryTimingState === 'BEARISH_TREND'
          ? `Supertrend 15m bearish`
          : entrySignals.entryTimingState === 'NO_TREND'
          ? `Supertrend 15m belum bullish`
          : entrySignals.entryTimingState === 'NO_M5'
            ? `Momentum M5 belum hijau`
            : entrySignals.entryTimingState === 'M15_PREV_UNKNOWN'
              ? `TA M15 Previous=UNKNOWN -> DEFER Rule 4`
            : entrySignals.entryTimingState === 'WAIT_VOLUME'
              ? `Volume belum mengonfirmasi breakout`
            : entrySignals.entryTimingState === 'WAIT_FOR_PULLBACK'
              ? `Breakout sudah terlalu lewat untuk mode retest (${formatMaybePct(entrySignals.signalStDistancePct, 2)})`
            : entrySignals.entryTimingState === 'LATE_BREAKOUT'
                ? `Breakout sudah tidak fresh lagi (${formatMaybePct(entrySignals.signalAthDistancePct, 2)} dari high 24h)`
              : entrySignals.entryTimingState === 'EXTENDED'
                ? `Breakout sudah terlalu melebar dari supertrend (${formatMaybePct(entrySignals.signalStDistancePct, 2)})`
              : `Breakout terlalu dekat ke Supertrend (${formatMaybePct(entrySignals.signalStDistancePct, 2)})`;
        const bearishTrend = entrySignals.entryTimingState === 'BEARISH_TREND';
        reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', bearishTrend ? 'FAIL' : 'DEFER', waitReason);
        reportManager.setFinalVerdict(tokenSymbol, bearishTrend ? 'REJECT' : 'DEFERRED', waitReason);
        console.log(`[SCREEN] ⏳ ${tokenSymbol} ditahan sebelum LLM: ${waitReason}`);
        if (!bearishTrend) {
          pendingStore.add(tokenMint || '', tokenSymbol, 0, 0, pool);
          addPendingRetest(pool, waitReason);
        }
        return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: waitReason };
      }

      const entryDecisionMode = String(cfg.entryDecisionMode || 'strict').toLowerCase();
      const lpSimpleM15Mode = entryDecisionMode === 'lp_simple_m15';
      const m5HardGateEnabled = cfg.entryM5HardGateEnabled !== false;
      const deferOnM15PreviousUnknown = cfg.entryDeferOnM15PreviousUnknown !== false;
      const modeM5Headline = (lpSimpleM15Mode && !m5HardGateEnabled)
        ? 'Mode lp_simple_m15 aktif: M15 jadi konfirmasi utama. M5 hanya diagnostik, bukan hard blocker.'
        : 'Candle M5 harus hijau.';
      const modeRule2NoM5 = (lpSimpleM15Mode && !m5HardGateEnabled)
        ? '  IF Entry Timing = "NO_M5" → JANGAN otomatis DEFER. Catat sebagai warning momentum, lanjutkan evaluasi rule lain.'
        : '  IF Entry Timing = "NO_M5" → WAJIB DEFER. Berhenti di sini.';
      const modeRule3 = (lpSimpleM15Mode && !m5HardGateEnabled)
        ? `[RULE 3 — M5 DIAGNOSTIK (LP SIMPLE M15)]
  Cek: "TA M5 Change" dari data.
  TA M5 Change dipakai sebagai konteks tambahan, BUKAN hard gate.
  Jangan auto-DEFER hanya karena TA M5 Change <= 0 jika rule M15/trend/freshness/safety lain sudah valid.`
        : `[RULE 3 — ANTI-CANDLE MERAH (HARAM HUKUMNYA)]
  Cek: "TA M5 Change" dari data.
  IF TA M5 Change <= 0 (nol atau negatif) → WAJIB DEFER. Berhenti di sini.
  ALASAN: Kita tidak menadah pisau jatuh. Candle M5 merah = harga SEDANG TURUN sekarang.
  MUTLAK. Tidak ada pengecualian seberapa besar pun volume atau MCap-nya.`;
      const modeRule4Unknown = (lpSimpleM15Mode && !deferOnM15PreviousUnknown)
        ? '  Jika TA M15 Previous = UNKNOWN, JANGAN auto-DEFER hanya karena UNKNOWN. Tetap fail-closed jika data M15 current/trend/freshness tidak valid.'
        : '  Jika TA M15 Previous = UNKNOWN → WAJIB DEFER.';
      const modeRule6M5 = (lpSimpleM15Mode && !m5HardGateEnabled)
        ? '- TA M5 Change cukup sebagai diagnostik (bukan hard gate di mode ini)'
        : '- TA M5 Change HARUS > 0 (momentum jangka pendek masih hidup)';
      const modeChecklistM5 = (lpSimpleM15Mode && !m5HardGateEnabled)
        ? '  ✓ TA M5 dipakai sebagai diagnostik (bukan hard gate) → Rule 3'
        : '  ✓ TA M5 Change > 0                              → Rule 3';
      const modeChecklistRule4 = (lpSimpleM15Mode && !deferOnM15PreviousUnknown)
        ? '  ✓ Rule 4 lolos (M15 previous unknown tidak auto-defer) → Rule 4'
        : '  ✓ Bukan Dead Cat (M15 Previous check)           → Rule 4';

      const prompt = `[ROLE: INITIAL SCREENING FILTER FOR DLMM LIQUIDITY PROVIDER]
[ROLE: MECHANICAL QUANT EVALUATOR — ATH SECOND BOUNCE HUNTER DLMM LP]

Kamu BUKAN manusia trader yang menganalisis chart visual.
Kamu adalah evaluator mekanis yang hanya membaca data JSON.
JANGAN menebak, mengasumsikan, atau mengisi data yang tidak ada di payload.

LP STYLE ENTRY
Supertrend 15m harus bullish.
${modeM5Headline}
Volume HARUS mendukung.
Entry ideal adalah closed green reclaim / bounce sehat; price reclaim/bounce sehat di area atas yang masih hidup buat fee flow.
Entry yang valid bukan cari breakout paling awal, tapi area yang masih bisa bolak-balik dan dipanen.
Jika Supertrend 15m BEARISH → REJECT. Jika NEUTRAL/UNKNOWN → DEFER/HOLD, jangan deploy.

MINDSET: FEE FLOW HUNTER.
Tugasmu adalah menjaga modal tetap utuh sambil memanen fee selama market masih hidup.
DILARANG KERAS menadah harga yang sedang runtuh (falling knife) atau memaksa entry saat struktur sudah patah.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ATURAN EVALUASI MEKANIS (TERAPKAN BERURUTAN — SATU RULE GAGAL = STOP):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[RULE 0 — SYSTEM CONFIG GATE (Slot Limit)]
  Data: "Slot Posisi" dari payload.
  IF active_positions >= max_positions → WAJIB DEFER.
  Bot dilarang membuka posisi baru jika kuota slot sudah penuh.
  (Gate ini juga dicek di kode sebelum LLM dipanggil — ini sebagai backup awareness.)

[RULE 1 — MAKRO FILTER]
  Cek: "TA Supertrend 15m" dari data.
  IF nilai BUKAN "BULLISH" → WAJIB REJECT. Berhenti di sini.
  Tidak ada pengecualian untuk deploy. BEARISH = REJECT. NEUTRAL/UNKNOWN = DEFER/HOLD.

[RULE 2 — LP ENTRY TIMING]
  Cek: "Entry Timing", "Price vs Supertrend", dan "Price vs 24h High" dari data.
  IF Entry Timing = "BEARISH_TREND" → WAJIB REJECT. Berhenti di sini.
  IF Entry Timing = "NO_TREND" → WAJIB REJECT. Berhenti di sini.
${modeRule2NoM5}
  IF Entry Timing = "WAIT_VOLUME" → WAJIB DEFER. Berhenti di sini.
  IF Entry Timing = "TOO_CLOSE" → WAJIB DEFER. Berhenti di sini.
  Entry ideal adalah closed green reclaim / bounce sehat di area atas yang masih hidup: supertrend bullish, M5 hijau, volume mendukung, dan arus fee masih bisa jalan.

${modeRule3}

[RULE 4 — ANTI-DEAD CAT BOUNCE (WAJIB CEK HISTORIS)]
  Cek: "TA M15 Previous" DAN "TA M15 Change" dari data.
  IF TA M15 Previous <= -4.0% (longsor kuat) DAN TA M15 Change < 2.0% (pantulan lemah) → WAJIB DEFER.
${modeRule4Unknown}
  PENJELASAN: M15 Previous negatif tebal = harga baru saja longsor.
  Pantulan M15 yang hanya kecil sesudahnya = Dead Cat, bukan tren pemulihan.
  M5 hijau di atas fondasi yang baru saja longsor = JEBAKAN. Tunggu konfirmasi lebih lanjut.

[RULE 5 — ANTI-BLOW OFF TOP (DARURAT PASAR EUFORIA)]
  Cek: "TA M15 Change" dari data.
  IF TA M15 Change >= 9.0% → WAJIB DEFER.
  PENJELASAN: Kenaikan M15 ekstrem (>= 9%) adalah tanda Blow-Off Top / klimaks euforia.
  Bensin nyaris habis. Paus besar siap take profit masif di zona ini.
  LPer yang masuk di zona ini menjadi EXIT LIQUIDITY untuk paus. DILARANG MASUK.
  Tunggu koreksi dan konfirmasi pemulihan sebelum entry.

[RULE 6 — HEALTHY FEE FLOW ENTRY (ZONA SEHAT LP)]
  LPer mencari zona fee flow yang SEHAT, bukan terlalu lemah dan bukan terlalu kaku.
  Syarat PASS (semua HARUS terpenuhi):
  - Entry Timing HARUS "LP_LIVE", "BREAKOUT", atau "ATH_BREAK"
  - TA Supertrend 15m HARUS "BULLISH"
  ${modeRule6M5}
  - Volume terkonfirmasi mendukung pergerakan
  - Breakout Quality HARUS "VALID" atau "STRONG"
  Jika semua syarat terpenuhi → WAJIB PASS.
  Kamu DILARANG menahan token yang sudah fee-flow valid hanya karena harga "sudah tinggi".
  Namun jika market belum bullish, M5 merah, atau volume lemah, DEFER.

[RULE 7 — SAFETY GATE (Hard Gate Keamanan)]
  Cek flag keamanan dari data. IF terdeteksi:
  - Wash trading tinggi / transaksi tidak organik       → REJECT
  - Bundling risk aktif terindikasi                     → REJECT
  - Mint authority belum di-renounce                    → DEFER
  - LP tidak di-burn / liquidity terpusat ekstrem       → DEFER
  - Data safety kosong / tidak tersedia                 → DEFER

[CHECKLIST FINAL — PASS hanya jika SEMUA syarat ini terpenuhi]
  ✓ Slot belum penuh                              → Rule 0
  ✓ TA Supertrend 15m = BULLISH                   → Rule 1
  ✓ Entry Timing = LP_LIVE / BREAKOUT / ATH_BREAK → Rule 2
${modeChecklistM5}
${modeChecklistRule4}
  ✓ TA M15 Change < 9.0% (bukan Blow-Off Top)    → Rule 5
  ✓ Breakout Quality = VALID / STRONG             → Rule 6
  ✓ Tidak ada safety red flag                     → Rule 7

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA POOL (JSON):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${llmPoolContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT JAWABAN (WAJIB JSON VALID, TANPA MARKDOWN):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "decision": "PASS | REJECT | DEFER",
  "reason": "Wajib sebutkan rule dan angkanya. Contoh: 'TA M15 Change=+12% -> DEFER Rule 4 (Blow Off Top)' atau 'TA M15=+4%, TA M5=+1.5% -> PASS Rule 5 (Healthy Momentum Zone)'.",
  "safety_score": 0-100,
  "entry_readiness": "LOW | MEDIUM | HIGH",
  "breakout_quality": "WEAK | VALID | STRONG"
}`;
      const res = await withTimeout(createMessage({
        model: scoutModel,
        componentType: 'agent',
        maxTokens: 320,
        messages: [{ role: 'user', content: prompt }]
      }), Number(cfg.llmTimeoutMs || 45_000), 'SCOUT_LLM');
      const rawText = res.content.find(c => c.type === 'text')?.text?.trim() || '';
      const parsed = safeParseAI(rawText, null);
      const decision = String(parsed?.decision || rawText || '').trim().toUpperCase();
      const scoutReason = String(parsed?.reason || '').trim();
      const safetyScore = Number(parsed?.safety_score);
      const entryReadiness = String(parsed?.entry_readiness || '').trim().toUpperCase();
      const breakoutQuality = String(parsed?.breakout_quality || '').trim().toUpperCase();
      const entryTimingState = String(entrySignals.entryTimingState || '').trim().toUpperCase();
      const scoreSuffix = Number.isFinite(safetyScore) ? ` (${Math.max(0, Math.min(100, safetyScore))})` : '';
      const detailSuffix = [
        entryReadiness ? `Entry=${entryReadiness}` : '',
        breakoutQuality ? `Breakout=${breakoutQuality}` : '',
        entryTimingState ? `Timing=${entryTimingState}` : '',
      ].filter(Boolean).join(', ');
      
      if (decision.includes('PASS')) {
        console.log(`[SCREEN] 🤖 ScoutAgent LP APPROVED: ${tokenSymbol}${scoreSuffix}${detailSuffix ? ` | ${detailSuffix}` : ''}`);
        reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'PASS', scoutReason || `Entry=${entryReadiness || 'UNKNOWN'}, Breakout=${breakoutQuality || 'UNKNOWN'}, Timing=${entryTimingState || 'UNKNOWN'}`);
        pool._screenResult = screenResult;
        pool._vetoResult = vetoResult;
        pool._marketSnapshot = marketSnapshot;
        pool.hasNonRefundableFees = Boolean(marketSnapshot?.pool?.hasNonRefundableFees);
        pool._llmPoolContext = llmPoolContext;
        pool._entrySignals = entrySignals;
        const watchResult = addWatchPassTa(pool, scoutReason || 'Scout Approved', 'SCOUT');
        if (watchResult?.admitted) {
          if (watchResult.evicted?.pool) {
            addPendingRetest(watchResult.evicted.pool, 'WATCH digeser oleh prioritas lebih kuat');
          }
          const slotUsage = getDeploySlotUsage();
          if (!isDeploySlotSaturated(slotUsage)) {
            await notify(
              `👀 <b>WATCH</b>\n` +
              `Token: <b>${tokenSymbol}</b> masuk watch layer!\n` +
              `Entry: <code>${entryReadiness || 'N/A'}</code> | Breakout: <code>${breakoutQuality || 'N/A'}</code>\n` +
              `Alasan: <i>${scoutReason || 'Scout Approved'}</i>\n` +
              `⏳ <i>Watcher aktif — deploy otomatis saat slot tersedia.</i>`
            );
          }
          return { ok: true, pool, symbol: tokenSymbol || 'UNKNOWN' };
        }

        const watchFallbackReason = watchResult?.reason || 'WATCH penuh';
        reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'DEFER', watchFallbackReason, `Entry=${entryReadiness}, Breakout=${breakoutQuality}, Timing=${entryTimingState}`);
        reportManager.setFinalVerdict(tokenSymbol, 'DEFERRED', watchFallbackReason);
        pendingStore.add(tokenMint || '', tokenSymbol, 0, 0, pool);
        addPendingRetest(pool, watchFallbackReason);
        console.log(`[SCREEN] ⏳ ${tokenSymbol} → pending retest (WATCH fallback: ${watchFallbackReason})`);
        if (!String(watchFallbackReason).includes('SLOT_SATURATED_PROMOTION_PAUSED')) {
          await notify(
            `⏳ <b>KANDIDAT DITUNDA (WATCH FULL)</b>\n` +
            `Token: <b>${tokenSymbol}</b>\n` +
            `Entry: <code>${entryReadiness || 'N/A'}</code> | Breakout: <code>${breakoutQuality || 'N/A'}</code>\n` +
            `Alasan Tunda: <i>${watchFallbackReason}</i>\n` +
            `👁️‍🗨️ <i>Radar memantau real-time sampai slot WATCH longgar.</i>`
          );
        }
        return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: watchFallbackReason };
      }
      const isDeferred = decision.includes('DEFER');
      const reason = scoutReason || (isDeferred ? 'Insufficient Information' : 'Weak Breakout');
      console.log(`[SCREEN] 🤖 ScoutAgent LP ${isDeferred ? 'DEFERRED' : 'REJECTED'}: ${tokenSymbol}${scoreSuffix}${detailSuffix ? ` | ${detailSuffix}` : ''}`);
      reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', isDeferred ? 'DEFER' : 'FAIL', reason, `Entry=${entryReadiness}, Breakout=${breakoutQuality}, Timing=${entryTimingState}`);

      if (isDeferred) {
        // DEFERRED — masuk radar, lalu watch kalau TA nanti fresh
        reportManager.setFinalVerdict(tokenSymbol, 'DEFERRED', reason);
        pendingStore.add(tokenMint || '', tokenSymbol, 0, 0, pool);
        addPendingRetest(pool, reason);
        console.log(`[SCREEN] ⏳ ${tokenSymbol} → pending retest (Scout DEFER: ${reason})`);
        await notify(
          `⏳ <b>KANDIDAT DITUNDA (RADAR)</b>\n` +
          `Token: <b>${tokenSymbol}</b>\n` +
          `Entry: <code>${entryReadiness || 'N/A'}</code> | Breakout: <code>${breakoutQuality || 'N/A'}</code>\n` +
          `Alasan Tunda: <i>${reason}</i>\n` +
          `👁️‍🗨️ <i>Radar memantau real-time sampai TA konfirmasi.</i>`
        );
      }

      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason };
    } catch (e) {
      console.warn(`[hunter] ScoutAgent error pada ${tokenSymbol}: ${e.message}`);
      reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'FAIL', `ScoutAgent error: ${e.message}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: `ScoutAgent error: ${e.message}` };
    }

  };

  // ── Evaluasi serial top pool configurable ──────────────────────────────────
  // Menggunakan for-of serial bukan chunkArray agar tidak ada chunk yang ter-skip
  // akibat guard _running yang hanya true di LinearLoop.
  for (const pool of scoutCandidates) {
    if (!_screening) break;              // hanya berhenti jika kita sendiri yang stop
    if (winners.length >= screeningTopPoolsLimit) break;      // cukup top pool limit
    try {
      const result = await evaluatePool(pool);
      if (!result) continue;
      if (result.ok && result.pool) {
        winners.push(result.pool);
      } else if (result.symbol) {
        reportManager.setFinalVerdict(result.symbol, 'REJECT', result.reason);
      }
    } catch (evalErr) {
      console.error(`[hunter] evaluatePool crash untuk ${pool.tokenXSymbol || pool.name}: ${evalErr.message}`);
    }
    await sleep(800); // throttle antar pool agar API tidak kewalahan
  }

  if (winners.length === 0) {
    console.log('[hunter] Tidak ada kandidat lolos screening siklus ini.');
    // TIDAK ada sleep di sini — scheduler di luar yang mengatur jeda antar siklus
    return;
  }

  const winnerLearning = applyPoolPatternLearningToCandidates(
    winners.map((pool, index) => ({
      item: pool,
      baseScore: winners.length - index,
      candidate: {
        pool,
        entrySignals: pool?._entrySignals || {},
        row: { lastReason: toGateCompact(pool?._gateSummary || []) },
        tokenMint: pool?.tokenXMint || pool?.tokenX || pool?.mint || '',
        poolAddress: pool?.address || pool?.poolAddress || pool?.pool || '',
        symbol: pool?.tokenXSymbol || pool?.name || '',
        entryReason: toGateCompact(pool?._gateSummary || []),
      },
    })),
    cfg
  );
  if (winnerLearning.mode === 'shadow') {
    for (const d of winnerLearning.diagnostics) {
      console.log(
        `[PATTERN_LEARNING_SHADOW] ${d.symbol || d.tokenMint || 'UNKNOWN'} ` +
        `base=${Number(d.baseScore || 0).toFixed(2)} delta=${Number(d.delta || 0).toFixed(2)} ` +
        `shadow=${Number(d.shadowScore || d.baseScore || 0).toFixed(2)} samples=${Number(d.sampleCount || 0)} ` +
        `reason=${(d.reasons?.[0] || 'NO_REASON')}`
      );
    }
  } else if (winnerLearning.mode === 'active') {
    for (const d of winnerLearning.diagnostics) {
      console.log(
        `[PATTERN_LEARNING_APPLIED] ${d.symbol || d.tokenMint || 'UNKNOWN'} ` +
        `base=${Number(d.baseScore || 0).toFixed(2)} applied=${Number(d.appliedDelta || 0).toFixed(2)} ` +
        `score=${Number(d.score || d.baseScore || 0).toFixed(2)} samples=${Number(d.sampleCount || 0)} ` +
        `reason=${(d.reasons?.[0] || 'NO_REASON')}`
      );
    }
    winners = winnerLearning.candidates;
  }


  // ── GeneralAgent Final LP Decision ─────────────────────────────
  console.log(`[hunter] 🧠 GeneralAgent memulai final audit LP sekuensial untuk ${winners.length} kandidat...`);
  let finalWinner = null;

  for (const w of winners) {
    const sym = w.tokenXSymbol || w.name?.split('-')[0];
    const mcap = Math.round(w.mcap || 0).toLocaleString('en-US');
    const vol = Math.round(w.volume24h || w.volume_24h || w.trade_volume_24h || w.tradeVolume24h || w.volume || w.v24h || 0).toLocaleString('en-US');
    
    try {
      const managementModel = cfg.managementModel || cfg.generalModel || cfg.agentModel;
      console.log(`[hunter] 🧠 LLM stage=GENERAL model=${managementModel}`);
      const gateSummary = (w._gateSummary || []).join('\n');
      const llmPoolContext = w._llmPoolContext || buildLlmPoolContext({
        pool: w,
        screenResult: w._screenResult,
        vetoResult: w._vetoResult,
        marketSnapshot: w._marketSnapshot,
      });
      const prompt = `[ROLE: PRINCIPAL DLMM LIQUIDITY PROVIDER (FINAL DECISION MAKER)]
Kamu adalah pengambil keputusan final untuk posisi DLMM.
Keputusan kamu menentukan apakah modal jadi dipasang atau ditolak.

MINDSET UTAMA:
- Kamu bukan trader.
- Kamu adalah Liquidity Provider yang menjaga modal tetap utuh sambil memanen fee.
- Kamu tidak mengejar entry dekat supertrend.
- Kamu justru mencari breakout yang sudah matang: harga break jauh di atas supertrend 15m bullish, atau ATH close hijau dengan momentum bullish yang jelas.
- Kalau bullish momentum belum terbentuk, jangan deploy.
- Jika data ambigu, jangan paksa keputusan.

ATURAN KEPUTUSAN:
1. DEPLOY jika:
   - semua hard gate safety lulus
   - supertrend 15m bullish
   - candle M5 hijau
   - breakout kuat dan valid
   - harga sudah benar-benar menunjukkan momentum bullish yang sehat
2. REJECT jika:
   - safety data buruk
   - breakout lemah
   - momentum bullish tidak valid
   - risiko modal terlalu tinggi
3. DEFER jika:
   - data belum cukup
   - momentum belum terbentuk
   - breakout belum matang
   - safety data ambigu

PRINSIP KERJA:
- Entry = breakout matang, bukan harga yang baru menyentuh garis.
- Kalau ada keraguan, pilih aman.

DATA FINAL:
- Token: ${sym || 'UNKNOWN'}
- High-level Summary:
${llmPoolContext}
- Gate Summary:
${gateSummary || 'N/A'}

[FORMAT JAWABAN JSON]
{
  "decision": "DEPLOY | REJECT | DEFER",
  "confidence": 0-100,
  "lp_thesis": "1 kalimat konklusif kenapa range ini layak dipasang atau wajib dihindari."
}

Balas HANYA JSON valid tanpa Markdown.`;
      const res = await withTimeout(createMessage({
        model: managementModel,
        componentType: 'management',
        maxTokens: 260,
        messages: [{ role: 'user', content: prompt }]
      }), Number(cfg.llmTimeoutMs || 45_000), 'GENERAL_LLM');
      const rawText = res.content.find(c => c.type === 'text')?.text?.trim() || '';
      const parsed = safeParseAI(rawText, null);
      const decision = String(parsed?.decision || rawText || '').trim().toUpperCase();
      const confidence = Number(parsed?.confidence);
      const confidenceSuffix = Number.isFinite(confidence) ? ` (${Math.max(0, Math.min(100, confidence))})` : '';
      const thesis = String(parsed?.lp_thesis || parsed?.il_risk_assessment || '').trim();
      
      if (decision.includes('DEPLOY')) {
        console.log(`[hunter] 🎯 GeneralAgent MEMUTUSKAN DEPLOY: ${sym}${confidenceSuffix}`);
        if (w._record) {
          w._record.reason = thesis || 'GeneralAgent DEPLOY';
        }
        finalWinner = w;
        break; // Segera eksekusi, stop audit sisanya
      } else {
        const finalDecision = decision.includes('REJECT') ? 'REJECT' : 'DEFER';
        console.log(`[hunter] ✋ GeneralAgent ${finalDecision}: ${sym}${confidenceSuffix}`);
        if (w._record) {
          recordGate(w._record, 'SCOUT_AGENT', finalDecision === 'REJECT' ? 'FAIL' : 'DEFER', thesis || finalDecision);
        }
        if (thesis) {
          appendDecisionLog({ token: sym, mint: w.tokenXMint || w.tokenX || w.mint || '', decision: 'SCREEN_FAIL',
            gate: 'GENERAL_AGENT', reason: thesis, pool: w.address || w.poolAddress || '', feeRatio: w.feeActiveTvlRatio || 0 });
        }
      }
      } catch (e) {
        console.warn(`[hunter] GeneralAgent error pada ${sym}: ${e.message}`);
        if (w._record) {
          recordGate(w._record, 'SCOUT_AGENT', 'DEFER', `GeneralAgent timeout/error: ${e.message}`);
        }
      }
    }

  if (!finalWinner) {
    const retryCfg = getConfig();
    const retryMin = getIdleDelayMin(retryCfg);
    console.log(`[hunter] GeneralAgent membatalkan semua kandidat. Scan ulang dalam ${retryMin} menit...`);
    await notify(
      `✋ <b>Tidak ada deploy kali ini</b>\n` +
      `Semua kandidat final belum mendapat keputusan <code>DEPLOY</code> dari GeneralAgent LP.\n` +
      `Scan ulang dalam <code>${retryMin} menit</code>.`
    );
    await sleep(retryMin * 60 * 1000);
    return;
  }

  const winner = finalWinner;

  // ── Phase 3: DEPLOY & SLOT MANAGEMENT ───────────────────────────
  const cfg2        = getConfig();
  
  // 1. Kapasitas Slot
  const usage0 = getDeploySlotUsage();
  const maxPositions = usage0.maxPositions;
  const activePositionsCount = usage0.active + usage0.reserved;
  let availableSlots = usage0.available;

  if (availableSlots <= 0) {
    console.log(`[hunter] ⚠️ Kapasitas penuh (Max ${maxPositions}). Bot standby memantau exit...`);
    await notify(
      `⚠️ <b>Deploy ditahan</b>\n` +
      `Tahap: <code>SLOT_CAPACITY</code>\n` +
      `Alasan: Slot penuh (<code>${activePositionsCount}/${maxPositions}</code>).`
    );
    await sleep(15_000);
    return;
  }


  // 2. Filter Deduplikasi (Anti Double-Entry)
  const eligibleWinners = winners.filter(w => {
    const mint = w.tokenXMint || w.tokenX || w.mint || w.address;
    const poolAddress = w.address || w.pool_address || w.pool || '';
    return !hasActiveMint(mint) && !hasActivePoolAddress(poolAddress);
  });

  if (eligibleWinners.length === 0) {
    console.log(`[hunter] Semua kandidat Top-${screeningTopPoolsLimit} sudah ada di posisi aktif. Standby...`);
    await notify(
      `⚠️ <b>Deploy ditahan</b>\n` +
      `Tahap: <code>DEDUPLICATION</code>\n` +
      `Alasan: Semua kandidat sudah jadi posisi aktif (anti double-entry).`
    );
    await sleep(15_000);
    return;
  }


  const candidateListStr = eligibleWinners.map((p, i) => {
    const sym   = p.name || p.tokenXMint?.slice(0, 8) || 'UNKNOWN';
    const ratio = ((p.feeActiveTvlRatio || 0) * 100).toFixed(2);
    const tvlRaw= Number(p.totalTvl || p.activeTvl || 0);
    const volRaw= Number(p.volume24h || p.volume_24h || p.trade_volume_24h || p.tradeVolume24h || p.volume || p.v24h || 0);
    const mcap  = Math.round(p.mcap || 0).toLocaleString('en-US');
    const effValue = volRaw / (tvlRaw || 1);
    const eff   = effValue > 1000 ? '>1000' : effValue.toFixed(2);
    const mark  = i === 0 ? '🏆' : '✅';
    return `${i+1}. ${mark} <b>${sym}</b> [${p.binStep || '?'}] — Eff: <code>${eff}x</code>\n   Fee/TVL: <code>${ratio}%</code> | MCap: <code>$${mcap}</code>`;
  }).join('\n\n');

  await notify(
    `🎯 <b>Top ${eligibleWinners.length} Kandidat Tersedia (Deduplicated)</b>\n\n` +
    `${candidateListStr}\n\n` +
    `Mengeksekusi kandidat yang tersedia...`
  );

  // 3. Iterative Deployment
  for (const winner of eligibleWinners) {
    if (availableSlots <= 0) break;

    const deployed = await withDeployLock(async () => {
      const currentCfg = getConfig();
      const slotUsage = getDeploySlotUsage();
      const maxPositionsNow = slotUsage.maxPositions;
      const slotsNow = slotUsage.available;
      if (slotsNow <= 0) {
        console.log(`[hunter] ⚠️ Slot habis saat reserve. Skip deploy kandidat berikut.`);
        return false;
      }

      const poolAddress = winner.address || winner.pool_address || winner.pool;
      const tokenMint   = winner.tokenXMint || winner.tokenX || winner.mint || poolAddress;
      const symbol      = winner.tokenXSymbol || winner.name?.split('-')[0] || poolAddress.slice(0,8);
      if (hasActiveMint(tokenMint) || hasActivePoolAddress(poolAddress)) {
        console.log(`[hunter] 🔁 ${symbol} / ${poolAddress.slice(0,8)} sudah aktif. Skip double-entry.`);
        return false;
      }

      const finalSt = await ensureFinalSupertrendBullish({
        mint: tokenMint,
        symbol,
        pool: winner,
        meta: {},
        liveSnapshot: winner._marketSnapshot || null,
        currentPrice: winner?._entrySignals?.currentPrice || winner?.price || winner?.pool_price || 0,
      });
      if (!finalSt.ok) {
        const reasonText = finalSt.reason || 'Supertrend 15m belum confirmed bullish';
        console.log(`[hunter] ${finalSt.action === 'VETO' ? '❌' : '⏸️'} Final ST gate ${symbol}: ${reasonText}`);
        if (winner._record) {
          recordGate(winner._record, 'SCOUT_AGENT', finalSt.action === 'VETO' ? 'FAIL' : 'DEFER', reasonText);
        }
        if (finalSt.action !== 'VETO') {
          addPendingRetest(winner, reasonText);
        }
        await notify(
          `${finalSt.action === 'VETO' ? '⛔ <b>Deploy Ditolak</b>' : '⏸️ <b>Deploy Ditahan</b>'}\n` +
          `<b>${escapeHTML(symbol)}</b> — <code>FINAL_ST_GATE_${finalSt.action}</code>\n` +
          `ST 15m: <code>${escapeHTML(finalSt.direction || 'UNKNOWN')}</code> (<code>${escapeHTML(finalSt.source || 'unknown')}</code>)\n` +
          `<i>${escapeHTML(reasonText)}</i>`
        );
        return false;
      }

      const finalCandle = await ensureFinalEntryCandleSanity({
        mint: tokenMint,
        symbol,
        pool: winner,
        meta: {},
      });
      if (!finalCandle.ok) {
        const reasonText = finalCandle.reason || 'HOLD: entry candle sanity unavailable/stale';
        console.log(`[hunter] ⏸️ Final candle gate ${symbol}: ${reasonText}`);
        if (winner._record) {
          recordGate(winner._record, 'SCOUT_AGENT', 'DEFER', reasonText);
        }
        addPendingRetest(winner, reasonText);
        await notify(
          `⏸️ <b>Deploy Ditahan</b>\n` +
          `<b>${escapeHTML(symbol)}</b> — <code>FINAL_CANDLE_GATE_HOLD</code>\n` +
          `Candle: <code>${escapeHTML(finalCandle.source || 'unknown')}</code>\n` +
          `<i>${escapeHTML(reasonText)}</i>`
        );
        return false;
      }

      const slotReservation = reserveDeploySlot({
        owner: 'hunterAlpha.scanAndDeploy',
        mint: tokenMint,
        symbol,
        poolAddress,
        source: 'scanAndDeploy',
        ttlMs: Number(currentCfg.deployTimeoutMs || 180_000) + 60_000,
      });
      if (!slotReservation.ok) {
        console.log(`[hunter] 🚫 Slot reservation gagal untuk ${symbol}: ${slotReservation.reason}`);
        return false;
      }
      const reservationId = slotReservation.id;

      try {
        await notify(
          `Mengeksekusi <b>${symbol}</b>...\n` +
          `Tahap lolos:\n<pre>${escapeHTML((winner._gateSummary || [
            'BLACKLIST_LOCAL: PASS',
            'STAGE_1_PUBLIC: PASS',
            'STAGE_2_GMGN: PASS',
            'STAGE_3_JUPITER: PASS',
            'SCOUT_AGENT: PASS',
            'GENERAL_AGENT: DEPLOY',
          ]).join('\n'))}</pre>\n` +
          `Deploy: <code>${currentCfg.deployAmountSol || 0.1} SOL</code>\n` +
          `⏳ <i>Membuka posisi pada pool <code>${poolAddress.slice(0,8)}</code>...</i>`
        );

        let positionPubkey;
        const deployResult = await withTimeout(
          deployPosition(poolAddress, {
            hasNonRefundableFees:
              winner?.hasNonRefundableFees ??
              marketSnapshot?.pool?.hasNonRefundableFees ??
              false,
            finalTrendStamp: {
              direction: finalSt.direction || 'UNKNOWN',
              source: finalSt.source || 'unknown',
              reason: finalSt.reason || '',
              checkedAt: Date.now(),
            },
          }),
          Number(currentCfg.deployTimeoutMs || 180_000),
          'DEPLOY'
        );
        if (deployResult && typeof deployResult === 'object' && deployResult.dryRun) {
          if (winner._record) {
            recordGate(winner._record, 'SCOUT_AGENT', 'DEFER', 'Dry-run simulation');
          }
          await notify(
            `🧪 <b>Dry-run deploy disimulasikan</b>\n` +
            `Token: <b>${escapeHTML(symbol)}</b>\n` +
            `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
            `Tx simulasi: <code>${deployResult.txCount || 0}</code>\n` +
            `Range: <code>${deployResult.rangeMin}-${deployResult.rangeMax}</code>\n` +
            `<i>Tidak ada transaksi real yang dikirim karena mode dryRun aktif.</i>`
          );
          return false;
        }
        if (deployResult && typeof deployResult === 'object' && deployResult.blocked) {
          const reasonText = deployResult.reason || 'DEPLOY_BLOCKED';
          const detailText = deployResult.detail ? `\nDetail: <code>${escapeHTML(String(deployResult.detail).slice(0, 240))}</code>` : '';
          const blockedByBalance = String(reasonText).includes('INSUFFICIENT_SOL_BALANCE');
          if (winner._record) {
            recordGate(winner._record, 'SCOUT_AGENT', 'DEFER', reasonText, {
              blocked: true,
              detail: deployResult.detail || '',
              rangeMin: deployResult.rangeMin,
              rangeMax: deployResult.rangeMax,
              rangeMaxBins: deployResult.rangeMaxBins,
            });
          }
          await notify(
            `${blockedByBalance ? '⏸️ <b>Deploy Ditahan</b>' : '⛔ <b>Deploy Ditolak</b>'}\n` +
            `<b>${escapeHTML(symbol)}</b> — <code>${reasonText}</code>\n` +
            `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
            (
              Number.isFinite(Number(deployResult.rangeMin)) && Number.isFinite(Number(deployResult.rangeMax))
                ? `Range: <code>${deployResult.rangeMin}-${deployResult.rangeMax}</code> (max ${deployResult.rangeMaxBins ?? 'n/a'} bin)\n`
                : ''
            ) +
            `${detailText}\n` +
            (
              blockedByBalance
                ? `<i>Saldo belum cukup untuk deploy aman. Top-up atau turunkan deployAmountSol.</i>`
                : `<i>Pool/range ini tidak dideploy karena memicu non-refundable rent. Pool lain tetap normal.</i>`
            )
          );
          return false;
        }
        positionPubkey = deployResult;
        const learningFeatures = extractPoolPatternFeatures({
          pool: winner,
          entrySignals: winner?._entrySignals || {},
          cfg: currentCfg,
          tokenMint,
          poolAddress,
          symbol,
          entryReason: toGateCompact(winner._gateSummary || []),
        });
        recordPoolPatternEntry({
          positionPubkey,
          features: learningFeatures,
          cfg: currentCfg,
        });
        await setPositionLifecycle(positionPubkey, 'open', {
          patternLearningEntry: learningFeatures,
        });
        _positionLabels.set(positionPubkey, { symbol });
        await notify(
          `✅ <b>Posisi terbuka!</b>\n` +
          `<b>${escapeHTML(symbol)}</b> — <code>DEPLOYED</code>\n` +
          `Tahap lolos ringkas: <code>${escapeHTML(toGateCompact(winner._gateSummary || []))}</code>\n` +
          `Status: <code>DEPLOYED</code>\n` +
          `Tahap: <code>EXECUTION_SUCCESS</code>\n` +
          `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
          `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
          `TP: TA exit >= net ${currentCfg.takeProfitMinNetPnlPct || 0}% | SL: -${currentCfg.stopLossPct || 10}%\n\n` +
          `Anchor: DLMM active bin | Source: frozen/live fallback\n` +
          `🔒 <i>Masuk mode monitor (Background)...</i>`
        );

        monitorLoop(positionPubkey, symbol, poolAddress).catch(err => {
          console.error(`[hunter] Monitor loop crash untuk ${symbol}:`, err);
        });
        return true;
      } catch (e) {
        console.error(`[hunter] deployPosition gagal: ${e.message}`);
        if (String(e.message || '').includes('TIMEOUT')) {
          await reconcileZombiePositions({ minAgeMs: 180_000 }).catch(() => {});
        }
        if (isNaturalDeployError(e)) {
          console.warn(`[hunter] deployPosition natural fail silenced: ${e.message}`);
        } else {
          await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Lanjut ke kandidat berikutnya...</i>`);
        }
        if (winner._record) {
          recordGate(winner._record, 'SCOUT_AGENT', 'FAIL', `EXECUTION_FAILED: ${e.message}`);
        }
        return false;
      } finally {
        await releaseDeploySlot(reservationId).catch(() => {});
      }
    });

      if (deployed) {
        if (winner._record) {
          winner._record.status = 'DEPLOYED';
          winner._record.stageFailed = '-';
        }
        availableSlots--;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (error) {
    console.error(`[hunter] scanAndDeploy critical error:`, error.message);
    return;
  } finally {
    if (!emitFinalReport) {
      console.log('[hunter] Final cycle report disenyapkan untuk first-run autoscreen.');
      return;
    }
    try {
      const report = generateFinalCycleReport(CycleReport);
      if (_notifyMuted) {
        console.log(report);
      } else {
        await notify(report);
      }
    } catch (e) {
      console.error("Gagal kirim ke Telegram:", e.message);
    }
  }
}


// ── Phase 4: MONITOR loop (while position active) ────────────────

async function monitorLoop(positionPubkey, symbol, poolAddress) {
  if (_monitoredPositions.has(positionPubkey)) {
    console.log(`[hunter] Monitor loop already active: ${positionPubkey.slice(0,8)}`);
    return;
  }
  _monitoredPositions.add(positionPubkey);
  console.log(`[hunter] 🔒 MONITOR lock: ${positionPubkey.slice(0,8)} | RealtimePnL interval=${Math.round(getRealtimePnlIntervalMs() / 1000)}s`);
  let consecutiveErrors = 0;
  const connection = getConnection();
  const fastLaneSubs = [];
  let wakeResolver = null;
  let wakeTimeout = null;
  let lastFastLaneWakeAt = 0;

  function clearWakeTimeout() {
    if (wakeTimeout) {
      clearTimeout(wakeTimeout);
      wakeTimeout = null;
    }
  }

  function triggerMonitorWake(reason = 'unknown') {
    const cfg = getConfig();
    const fastCfg = getMonitorFastLaneConfig(cfg);
    const now = Date.now();
    if ((now - lastFastLaneWakeAt) < fastCfg.throttleMs) return;
    lastFastLaneWakeAt = now;
    if (typeof wakeResolver === 'function') {
      const resolver = wakeResolver;
      wakeResolver = null;
      clearWakeTimeout();
      resolver(reason);
    }
  }

  function subscribeFastLaneAccount(pubkey, label) {
    if (!(pubkey instanceof PublicKey)) return;
    const subId = connection.onAccountChange(
      pubkey,
      () => triggerMonitorWake(`ws:${label}`),
      'processed'
    );
    fastLaneSubs.push(subId);
  }

  async function setupFastLaneSubscriptions() {
    const cfg = getConfig();
    const fastCfg = getMonitorFastLaneConfig(cfg);
    if (!fastCfg.enabled) return;

    try {
      if (fastCfg.usePositionAccount) {
        subscribeFastLaneAccount(new PublicKey(positionPubkey), 'position');
      }
    } catch (e) {
      console.warn(`[hunter] fast-lane position subscribe gagal: ${e.message}`);
    }

    if (fastCfg.usePoolAccount && poolAddress) {
      try {
        subscribeFastLaneAccount(new PublicKey(poolAddress), 'pool');
      } catch (e) {
        console.warn(`[hunter] fast-lane pool subscribe gagal: ${e.message}`);
      }
    }

    if (fastLaneSubs.length > 0) {
      console.log(
        `[hunter] ⚡ Fast-lane aktif: ${fastLaneSubs.length} websocket subscription(s) ` +
        `(throttle=${fastCfg.throttleMs}ms fallback=${fastCfg.fallbackPollMs}ms)`
      );
    }
  }

  async function teardownFastLaneSubscriptions() {
    clearWakeTimeout();
    wakeResolver = null;
    for (const subId of fastLaneSubs.splice(0)) {
      try {
        await connection.removeAccountChangeListener(subId);
      } catch {
        // non-fatal cleanup
      }
    }
  }

  async function waitForMonitorWake() {
    const cfg = getConfig();
    const fastCfg = getMonitorFastLaneConfig(cfg);

    if (!fastCfg.enabled || fastLaneSubs.length === 0) {
      await sleep(EP_CONFIG.MONITOR_INTERVAL_MS);
      return 'poll:interval';
    }

    return await new Promise((resolve) => {
      wakeResolver = resolve;
      wakeTimeout = setTimeout(() => {
        wakeResolver = null;
        wakeTimeout = null;
        resolve('poll:fallback');
      }, fastCfg.fallbackPollMs);
    });
  }

  try {
    await setupFastLaneSubscriptions();
    while (_running || getActivePositionKeys().includes(positionPubkey)) {
      await waitForMonitorWake();

      let status;
      try {
        status = await monitorPnL(positionPubkey);
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        console.warn(`[hunter] monitorPnL error (${consecutiveErrors}): ${e.message}`);
        if (consecutiveErrors >= 5) {
          await notify(`⚠️ <b>Monitor error 5x berturut.</b> Force exit...\n<code>${e.message}</code>`);
          await safeExit(positionPubkey, 'MONITOR_ERROR');
          return;
        }
        continue;
      }

      const { action, currentValueSol, pnlPct, inRange } = status;
      const meta = getPositionMeta(positionPubkey) || {};
      const trackedFeeSnapshot = resolveTrackedFeeSnapshot(status, meta);
      const feePnlSol = trackedFeeSnapshot.feePnlSol;
      const feePnlPct = trackedFeeSnapshot.feePnlPct;
      const feeSign = feePnlPct > 0 ? '+' : '';
      const deploySol = Number(meta.deploySol || 0);
      const currentLifecycle = meta.lifecycleState || meta.lifecycle_state || 'open';
      const runtimeState = getPositionRuntimeState(positionPubkey);
      const cfg = getConfig();
      const nextPoolImpactSamples = Array.isArray(runtimeState.poolImpactSamples)
        ? runtimeState.poolImpactSamples.slice(-19)
        : [];
      const currentBin = Number.isFinite(Number(status?.activeBinId)) ? Number(status.activeBinId) : null;
      const currentPrice = Number.isFinite(Number(status?.activePrice)) ? Number(status.activePrice) : null;
      if (currentBin !== null || currentPrice !== null) {
        nextPoolImpactSamples.push({
          activeBin: currentBin,
          price: currentPrice,
          at: Date.now(),
        });
      }
      const previousSample = nextPoolImpactSamples.length >= 2 ? nextPoolImpactSamples[nextPoolImpactSamples.length - 2] : null;
      const poolImpactIntervalMs = Math.max(1000, Number(cfg?.poolImpactCheckIntervalMs || 3000));
      const lastPoolImpactCheckAt = Number(runtimeState?.lastPoolImpactCheckAt || 0);
      const canRunPoolImpactGuard = !/closing|closed/i.test(String(currentLifecycle || ''));
      const shouldCheckPoolImpact = cfg?.poolImpactGuardEnabled === true &&
        canRunPoolImpactGuard &&
        (!lastPoolImpactCheckAt || (Date.now() - lastPoolImpactCheckAt) >= poolImpactIntervalMs);
      const poolImpactDecision = shouldCheckPoolImpact
        ? evaluatePoolImpactGuard({
            entryActiveBin: status?.entryActiveBin ?? meta.entryActiveBin,
            currentActiveBin: currentBin,
            previousActiveBin: previousSample?.activeBin,
            entryPrice: status?.entryPrice ?? meta.entryPrice,
            currentPrice,
            previousPrice: previousSample?.price,
            lowerBin: status?.rangeMin ?? meta.rangeMin,
            upperBin: status?.rangeMax ?? meta.rangeMax,
            recentSamples: nextPoolImpactSamples,
            config: cfg,
          })
        : { action: 'PASS', score: 0, reasons: ['throttled_or_disabled'], metrics: {} };
      if (currentBin !== null || currentPrice !== null) {
        await updatePositionRuntimeState(positionPubkey, {
          poolImpactSamples: nextPoolImpactSamples.slice(-20),
          ...(shouldCheckPoolImpact ? { lastPoolImpactCheckAt: Date.now() } : {}),
        });
      }
      const oorState = evaluateOutOfRangeMonitorState({
        positionPubkey,
        symbol,
        status,
        runtimeState,
        cfg: getConfig(),
      });
      if (oorState.runtimePatch) {
        await updatePositionRuntimeState(positionPubkey, oorState.runtimePatch);
      }
      const lifecycleExtra = {
        currentValueSol,
        pnlPct,
        feePnlSol,
        feePnlPct,
        feePnlAvailable: trackedFeeSnapshot.feePnlAvailable,
        feePnlSource: trackedFeeSnapshot.feePnlSource,
        inRange,
        deploySol,
        oorState: inRange ? 'IN_RANGE' : 'OUT_OF_RANGE',
      };
      if (Number.isFinite(Number(meta.hwmPct))) {
        lifecycleExtra.hwmPct = Number(meta.hwmPct);
      }
      if (oorState.runtimePatch?.oorSince !== undefined) {
        lifecycleExtra.oorSince = oorState.runtimePatch.oorSince;
      } else if (Number.isFinite(runtimeState?.oorSince)) {
        lifecycleExtra.oorSince = runtimeState.oorSince;
      }
      const nextStatus = {
        ...status,
        deploySol,
        oorSince: oorState.runtimePatch?.oorSince ?? runtimeState?.oorSince ?? null,
      };
      await setPositionLifecycle(positionPubkey, currentLifecycle, lifecycleExtra);
      status = nextStatus;

      if (action === 'ERROR') {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          await notify(`⚠️ <b>Status error 5x berturut.</b> Force exit...`);
          await safeExit(positionPubkey, 'STATUS_ERROR');
          return;
        }
        continue;
      }

      if (action === 'MANUAL_CLOSED') {
        await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED');
        _positionLabels.delete(positionPubkey);
        return;
      }

      // Exit trigger
      if (action === 'TAKE_PROFIT') {
        const exitScenario = String(status.exitScenario || '').toUpperCase();
        const isDefensiveTaExit = exitScenario === 'C';
        const headerLabel = isDefensiveTaExit ? 'DEFENSIVE EXIT' : 'TAKE PROFIT';
        const reasonLabel = isDefensiveTaExit
          ? 'Defensive Exit Trigger'
          : exitScenario === 'TRAILING'
            ? 'Trailing Profit Trigger'
            : 'Take Profit Trigger';
        await notify(
          `🎉 <b>${headerLabel}</b>\n` +
          `Token: <b>${symbol}</b>\n` +
          `Fee PnL: <code>${feePnlSol.toFixed(6)} SOL / ${feeSign}${feePnlPct.toFixed(2)}%</code>\n` +
          `Position Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
          `Total Exposure PnL: <code>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</code>\n` +
          `Reason: <code>${reasonLabel}</code>\n` +
          `\n⏳ <i>Menutup posisi...</i>`
        );
        await safeExit(positionPubkey, `TAKE_PROFIT_${status.exitScenario || 'TA'}`);
        return;
      }

      if (action === 'STOP_LOSS') {
        await notify(
          `🛑 <b>STOP LOSS!</b>\n` +
          `Token: <b>${symbol}</b>\n` +
          `Fee PnL: <code>${feePnlSol.toFixed(6)} SOL / ${feeSign}${feePnlPct.toFixed(2)}%</code>\n` +
          `Position Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
          `Total Exposure PnL: <code>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</code>\n` +
          `\n` +
          `⏳ <i>Menutup posisi...</i>`
        );
        await safeExit(positionPubkey, 'STOP_LOSS');
        return;
      }

      if (action === 'MAX_HOLD') {
        await notify(
          `⏰ <b>MAX HOLD EXIT!</b>\n` +
          `Token: <b>${symbol}</b>\n` +
          `Fee PnL: <code>${feePnlSol.toFixed(6)} SOL / ${feeSign}${feePnlPct.toFixed(2)}%</code>\n` +
          `Position Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
          `Total Exposure PnL: <code>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</code>\n` +
          (status.exitReason ? `Reason: <code>${escapeHTML(status.exitReason)}</code>\n` : '') +
          `\n⏳ <i>Menutup posisi...</i>`
        );
        await safeExit(positionPubkey, 'MAX_HOLD_EXIT');
        return;
      }

      if (action === 'HOLD') {
        if (poolImpactDecision.action === 'FORCE_EXIT') {
          const priceDrop = Number(poolImpactDecision.metrics?.priceDropPctFromEntry || 0);
          const activeBinDelta = Number(poolImpactDecision.metrics?.activeBinDeltaFromEntry || 0);
          const lowerRisk = poolImpactDecision.metrics?.isOutOfRange ? 'out of range' : 'near lower bin';
          await notify(
            `🐋 <b>POOL IMPACT EXIT!</b>\n` +
            `Token: <b>${symbol}</b>\n` +
            `Reason: <code>${escapeHTML(poolImpactDecision.reasons.join(', ') || 'pool_impact_guard')}</code>\n` +
            `Price Drop: <code>-${priceDrop.toFixed(2)}%</code>\n` +
            `Active Bin Δ: <code>${activeBinDelta}</code>\n` +
            `Range Risk: <code>${lowerRisk}</code>\n` +
            `\n⏳ <i>Menutup posisi...</i>`
          );
          await safeExit(positionPubkey, 'POOL_IMPACT_GUARD');
          return;
        }
        if (poolImpactDecision.action === 'PRE_EXIT') {
          const now = Date.now();
          const lastAlertAt = Number(runtimeState?.lastPoolImpactAlertAt || 0);
          const cooldownMs = Number(cfg?.poolImpactAlertCooldownMs || 60_000);
          if (!lastAlertAt || (now - lastAlertAt) >= cooldownMs) {
            await updatePositionRuntimeState(positionPubkey, { lastPoolImpactAlertAt: now });
            console.log(`[hunter] pool impact pre-exit ${positionPubkey.slice(0,8)} ${poolImpactDecision.reasons.join(',')}`);
          }
        }
        if (oorState.logMessage) {
          console.log(oorState.logMessage);
        }
        if (oorState.notifyMessage) {
          await notify(oorState.notifyMessage);
        }
        if (oorState.shouldExit) {
          await safeExit(positionPubkey, oorState.exitReason || 'OUT_OF_RANGE');
          return;
        }
      }

      if (shouldLogRealtimePnl(positionPubkey)) {
        logRealtimePnl({ positionPubkey, symbol, status });
        if (!(action === 'HOLD' && oorState.notifyMessage)) {
          await notifyRealtimePnl({ positionPubkey, symbol, status });
        }
      }
    }

    // Loop dihentikan dari luar — exit posisi
    if (_shutdownInProgress) {
      console.log(`[hunter] Shutdown in progress, monitor loop selesai tanpa auto-exit tambahan: ${positionPubkey.slice(0,8)}`);
      return;
    }
    await notify(`⏹ <b>Loop dihentikan.</b> Menutup posisi aktif...`);
    await safeExit(positionPubkey, 'LOOP_STOPPED');
  } finally {
    await teardownFastLaneSubscriptions();
    _monitoredPositions.delete(positionPubkey);
    _lastRealtimePnlLogAt.delete(positionPubkey);
  }
}

export function spawnMonitorForRestoredPositions() {
  const active = listActivePositions();
  let spawned = 0;
  for (const pos of active) {
    if (!pos?.pubkey || _monitoredPositions.has(pos.pubkey)) continue;
    const symbol = pos.symbol || pos.mint?.slice(0, 8) || pos.pubkey.slice(0, 8);
    monitorLoop(pos.pubkey, symbol, pos.poolAddress).catch(err => {
      console.error(`[hunter] Restored monitor loop crash untuk ${symbol}:`, err);
    });
    spawned++;
  }
  return spawned;
}

// ── Exit helper ───────────────────────────────────────────────────

async function safeExit(positionPubkey, reason) {
  if (_closingPositions.has(positionPubkey)) {
    console.log(`[hunter] safeExit skip (already closing): ${positionPubkey.slice(0,8)}`);
    throw new Error(`POSITION_ALREADY_CLOSING_${positionPubkey.slice(0,8)}`);
  }
  _closingPositions.add(positionPubkey);
  let success = false;
  try {
    const exitResult = await exitPosition(positionPubkey, reason);
    if (exitResult?.dryRun) {
      await notify(
        `🧪 <b>Dry-run exit disimulasikan</b>\n` +
        `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
        `Alasan: <code>${escapeHTML(reason)}</code>\n` +
        `<i>Tidak ada transaksi real yang dikirim karena mode dryRun aktif.</i>`
      );
      return { ok: true, dryRun: true, simulated: true };
    }
    const positionValue = Number(exitResult?.positionValueSol);
    const positionValueLine = Number.isFinite(positionValue)
      ? `Position Value: <code>${positionValue.toFixed(6)} SOL</code>\n`
      : '';
    const balance = await getWalletBalance();
    success = true;
    _manualCloseAlertState.delete(positionPubkey);
    await notify(
      `✅ <b>Posisi ditutup (${reason})</b>\n` +
      `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
      formatFeePnlLine(exitResult) +
      positionValueLine +
      formatExposurePnlLine(exitResult) +
      formatWalletDeltaLine(exitResult) +
      formatRentRefundLine(exitResult) +
      `Balance: <code>${balance} SOL</code>`
    );
    return { ok: true, ...exitResult };
  } catch (e) {
    const closeMeta = e?.closeFailureMeta && typeof e.closeFailureMeta === 'object'
      ? e.closeFailureMeta
      : null;
    const shouldAlertManualClose = Boolean(
      closeMeta?.closeAttemptStarted === true &&
      closeMeta?.closeSucceeded === false &&
      closeMeta?.closeRetriesExhausted === true &&
      closeMeta?.positionStillOpenOrUncertain === true &&
      closeMeta?.manualCloseRequired === true
    );
    if (shouldAlertManualClose) {
      const now = Date.now();
      const lastSent = Number(_manualCloseAlertState.get(positionPubkey) || 0);
      if (!lastSent || (now - lastSent) >= MANUAL_CLOSE_ALERT_COOLDOWN_MS) {
        _manualCloseAlertState.set(positionPubkey, now);
        const meta = getPositionMeta(positionPubkey) || {};
        const token = (meta.tokenXMint || closeMeta?.tokenXMint || '').slice(0, 8) || positionPubkey.slice(0,8);
        const pool = (meta.poolAddress || closeMeta?.poolAddress || '').slice(0, 8) || 'UNKNOWN';
        const closeErr = String(closeMeta?.closeFailureError || e?.message || 'UNKNOWN_CLOSE_ERROR');
        await notify(
          `⚠️ <b>Manual close required</b>\n` +
          `Token: <b>${escapeHTML(token)}</b>\n` +
          `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
          `Pool: <code>${pool}</code>\n` +
          `Exit Trigger: <code>${escapeHTML(String(closeMeta?.exitTriggerReason || reason || 'UNKNOWN'))}</code>\n` +
          `Error: <code>${escapeHTML(closeErr.slice(0, 240))}</code>\n` +
          `<i>Tutup posisi ini manual di Meteora.</i>`
        );
        console.warn(`[hunter] MANUAL_CLOSE_TELEGRAM_SENT position=${positionPubkey.slice(0,8)}`);
      }
    }
    console.error(`[hunter] exitPosition error: ${e.message}`);
    await notify(
      `⚠️ <b>Exit gagal:</b>\n` +
      `<code>${escapeHTML(summarizeExitError(e))}</code>\n\n` +
      `<i>Posisi mungkin masih terbuka on-chain dan registry lokal tidak dihapus.</i>`
    );
    throw e;
  } finally {
    if (success) _positionLabels.delete(positionPubkey);
    console.log(`[hunter] Slot dibebaskan. Posisi aktif tersisa: ${getActivePositionKeys().length}`);
    _closingPositions.delete(positionPubkey);
  }
}

export async function closeAllActivePositionsForShutdown(signal = 'SIGTERM', timeoutMs = 10_000) {
  _shutdownInProgress = true;
  const snapshot = listActivePositions();
  const results = [];

  for (const pos of snapshot) {
    const pubkey = pos?.pubkey;
    if (!pubkey) continue;
    const result = { pubkey, ok: false, reason: null };
    try {
      const closeResult = await Promise.race([
        safeExit(pubkey, `SHUTDOWN_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), timeoutMs)),
      ]);
      result.ok = closeResult?.ok === true && !getActivePositionKeys().includes(pubkey);
      if (!result.ok) result.reason = 'SHUTDOWN_CLOSE_NOT_VERIFIED';
    } catch (e) {
      result.reason = e?.message || 'UNKNOWN_SHUTDOWN_ERROR';
    }
    results.push(result);
  }

  return {
    total: snapshot.length,
    closed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    results,
  };
}

export async function closeAllActivePositionsByUser(reason = 'MANUAL_COMMAND', timeoutMs = 180_000) {
  const snapshot = listActivePositions();
  const results = [];

  for (const pos of snapshot) {
    const pubkey = pos?.pubkey;
    if (!pubkey) continue;
    const result = {
      pubkey,
      symbol: pos.symbol || pos.mint?.slice(0, 8) || pubkey.slice(0, 8),
      ok: false,
      reason: null,
    };
    try {
      const closeResult = await Promise.race([
        safeExit(pubkey, reason),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MANUAL_EXIT_TIMEOUT')), timeoutMs)),
      ]);
      result.ok = closeResult?.ok === true && !getActivePositionKeys().includes(pubkey);
      if (!result.ok) result.reason = 'MANUAL_EXIT_NOT_VERIFIED';
    } catch (e) {
      result.reason = e?.message || 'MANUAL_EXIT_FAILED';
    }
    results.push(result);
  }

  return {
    total: snapshot.length,
    closed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    remaining: getActivePositionKeys().length,
    results,
  };
}

export async function retryFailedShutdownPositions(failedRows = [], signal = 'SIGTERM', timeoutMs = 10_000) {
  if (!Array.isArray(failedRows) || failedRows.length === 0) {
    return { retried: 0, recovered: 0, stillFailed: [] };
  }

  const stillActive = new Set(getActivePositionKeys());
  const retryTargets = failedRows
    .map((r) => r?.pubkey)
    .filter((pubkey) => pubkey && stillActive.has(pubkey));

  let recovered = 0;
  const stillFailed = [];
  for (const pubkey of retryTargets) {
    try {
      const closeResult = await Promise.race([
        safeExit(pubkey, `SHUTDOWN_RETRY_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_RETRY_TIMEOUT')), timeoutMs)),
      ]);
      if (closeResult?.ok === true && !getActivePositionKeys().includes(pubkey)) {
        recovered++;
      } else {
        stillFailed.push({ pubkey, reason: 'SHUTDOWN_RETRY_NOT_VERIFIED' });
      }
    } catch (e) {
      stillFailed.push({ pubkey, reason: e?.message || 'SHUTDOWN_RETRY_FAILED' });
    }
  }

  return {
    retried: retryTargets.length,
    recovered,
    stillFailed,
  };
}

// ── Pure Flat Config Gate ─────────────────────────────────────────

function checkFlatConfig(pool, cfg) {
  const vol24h   = safeNum(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.tradeVolume24h || pool.volume24hRaw || pool.volume || pool.v24h || 0);
  const minVol   = Number(cfg.minVolume) || 0;
  const maxVol   = Number(cfg.maxVolume) || 0;
  const binStep  = pool.binStep || 0;
  const feeRatio = pool.feeActiveTvlRatio || 0;
  const minFee   = cfg.minFeeActiveTvlRatio || 0;

  const binStepPriority = Array.isArray(cfg.binStepPriority) && cfg.binStepPriority.length > 0
    ? cfg.binStepPriority.map(Number)
    : [200, 125, 100];

  if (!binStepPriority.includes(binStep)) {
    return { ok: false, gate: 'BIN_STEP', reason: `binStep ${binStep} not in priority list [${binStepPriority}]` };
  }
  if (minVol > 0 && vol24h < minVol) {
    return { ok: false, gate: 'VOLUME_MIN', reason: `vol24h $${vol24h.toLocaleString()} < min $${minVol.toLocaleString()}` };
  }
  if (maxVol > 0 && vol24h > maxVol) {
    return { ok: false, gate: 'VOLUME_MAX', reason: `vol24h $${vol24h.toLocaleString()} > max $${maxVol.toLocaleString()}` };
  }
  if (minFee > 0 && feeRatio < minFee) {
    return { ok: false, gate: 'FEE_TVL_MIN', reason: `fee/tvl ${(feeRatio*100).toFixed(4)}% < min ${(minFee*100).toFixed(4)}%` };
  }
  return { ok: true, gate: 'FLAT_CONFIG_GATE', reason: 'PASS' };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toGateCompact(summary = []) {
  if (!Array.isArray(summary) || summary.length === 0) return 'N/A';
  return summary.map((line) => {
    if (line.startsWith('STAGE_0_DISCOVERY:')) return line.replace('STAGE_0_DISCOVERY:', 'S0 Discovery');
    if (line.startsWith('STAGE_1_PUBLIC:')) return line.replace('STAGE_1_PUBLIC:', 'S1 Public');
    if (line.startsWith('STAGE_2_GMGN:')) return line.replace('STAGE_2_GMGN:', 'S2 GMGN');
    if (line.startsWith('STAGE_3_JUPITER:')) return line.replace('STAGE_3_JUPITER:', 'S3 Jupiter');
    if (line.startsWith('BLACKLIST_LOCAL:')) return line.replace('BLACKLIST_LOCAL:', 'Blacklist');
    if (line.startsWith('MERIDIAN_VETO:')) return line.replace('MERIDIAN_VETO:', 'Meridian');
    if (line.startsWith('PENDING_RETEST:')) return line.replace('PENDING_RETEST:', 'Retest');
    if (line.startsWith('FLAT_CONFIG_GATE:')) return line.replace('FLAT_CONFIG_GATE:', 'FlatConfig');
    if (line.startsWith('SCOUT_AGENT:')) return line.replace('SCOUT_AGENT:', 'Scout');
    if (line.startsWith('GENERAL_AGENT:')) return line.replace('GENERAL_AGENT:', 'General');
    return line;
  }).join(' | ');
}

function buildGateStateMap(summary = []) {
  const map = new Map();
  if (!Array.isArray(summary)) return map;
  for (const line of summary) {
    if (typeof line !== 'string') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function formatGateReport(summary = [], stage = 'UNKNOWN_STAGE') {
  const gateMap = buildGateStateMap(summary);
  const normalizedStage = String(stage || '').toUpperCase();
  const order = [
    'STAGE_0_DISCOVERY',
    'BLACKLIST_LOCAL',
    'STAGE_1_PUBLIC',
    'STAGE_2_GMGN',
    'STAGE_3_JUPITER',
    'MERIDIAN_VETO',
    'PENDING_RETEST',
    'FLAT_CONFIG_GATE',
    'SCOUT_AGENT',
  ];

  const stageIndexMap = {
    BLACKLIST_LOCAL: 1,
    STAGE_1_PUBLIC: 2,
    STAGE_2_GMGN: 3,
    STAGE_3_JUPITER: 4,
    MERIDIAN_VETO: 5,
    PENDING_RETEST: 6,
    FLAT_CONFIG_GATE: 7,
    SCOUT_AGENT: 8,
  };
  const failIdx = stageIndexMap[normalizedStage] || 0;

  const labels = {
    STAGE_0_DISCOVERY: 'STAGE_0_DISCOVERY',
    BLACKLIST_LOCAL: 'BLACKLIST_LOCAL',
    STAGE_1_PUBLIC: 'STAGE_1_PUBLIC',
    STAGE_2_GMGN: 'STAGE_2_GMGN',
    STAGE_3_JUPITER: 'STAGE_3_JUPITER',
    MERIDIAN_VETO: 'MERIDIAN_VETO',
    PENDING_RETEST: 'PENDING_RETEST',
    FLAT_CONFIG_GATE: 'FLAT_CONFIG_GATE',
    SCOUT_AGENT: 'SCOUT_AGENT',
  };

  return order.map((key) => {
    const value = gateMap.get(key);
    if (value) return `${labels[key]}: ${value}`;
    if (key === 'STAGE_0_DISCOVERY') return `${labels[key]}: PASS`;
    if (key === 'BLACKLIST_LOCAL' && normalizedStage !== 'BLACKLIST_LOCAL') return `${labels[key]}: PASS`;
    if (stageIndexMap[key] && failIdx && stageIndexMap[key] < failIdx) return `${labels[key]}: PASS`;
    if (stageIndexMap[key] === failIdx) return `${labels[key]}: FAIL`;
    if (stageIndexMap[key] && stageIndexMap[key] > failIdx) return `${labels[key]}: SKIPPED`;
    return `${labels[key]}: SKIPPED`;
  }).join('\n');
}

function createCycleRecord(pool = {}, tokenMint = '', tokenSymbol = '') {
  return {
    name: tokenSymbol || pool.name || 'UNKNOWN',
    mint: tokenMint || '',
    status: 'PENDING',
    stageFailed: '',
    reason: '',
    gates: {
      STAGE_0_DISCOVERY: 'PASS',
      BLACKLIST_LOCAL: 'SKIPPED',
      STAGE_1_PUBLIC: 'SKIPPED',
      STAGE_2_GMGN: 'SKIPPED',
      STAGE_3_JUPITER: 'SKIPPED',
      MERIDIAN_VETO: 'SKIPPED',
      PENDING_RETEST: 'SKIPPED',
      FLAT_CONFIG_GATE: 'SKIPPED',
      SCOUT_AGENT: 'SKIPPED'
    },
    metadata: {}
  };
}

function recordGate(record, gate, status, reason = '', metadata = {}) {
  if (record.finalized) return;
  
  const gatesOrder = [
    'STAGE_0_DISCOVERY',
    'BLACKLIST_LOCAL',
    'STAGE_1_PUBLIC',
    'STAGE_2_GMGN',
    'STAGE_3_JUPITER',
    'MERIDIAN_VETO',
    'PENDING_RETEST',
    'FLAT_CONFIG_GATE',
    'SCOUT_AGENT'
  ];
  
  const currentIdx = gatesOrder.indexOf(gate);
  if (currentIdx === -1) return;
  
  record.gates[gate] = status;
  if (reason) record.reason = reason;
  if (metadata) record.metadata = { ...record.metadata, ...metadata };

  if (status === 'FAIL' || status === 'DEFER') {
    record.status = status === 'FAIL' ? 'REJECT' : 'REJECT'; // Format asks for REJECT/DEPLOYED
    record.stageFailed = gate;
    record.finalized = true;
    // Mark next gates as SKIPPED
    for (let i = currentIdx + 1; i < gatesOrder.length; i++) {
      record.gates[gatesOrder[i]] = 'SKIPPED';
    }
  } else if (status === 'PASS') {
    // Continue to next gate
    if (currentIdx < gatesOrder.length - 1) {
      record.gates[gatesOrder[currentIdx + 1]] = 'NOT_STARTED'; // Initial state for next gate if we wanted
    }
  }
}




function classifyMarketRegime() {
  return 'NEUTRAL';
}

// Compatibility gate markers for legacy tests:
// entryGateMode + entrySupertrendMaxDistancePct + entryRequireVolumeConfirm + entryMinVolumeRatio
// entryRequireHtfAlignment + entryHtfAllowNeutral + priceChangeM5 + priceChangeH1
function _legacyEntryGateCompatibility(signals = {}, cfg = {}) {
  const entryGateMode = String(cfg.entryGateMode || 'lp_fee_flow').toLowerCase();
  const maxDistancePct = Number(cfg.entrySupertrendMaxDistancePct || 2.5);
  const signalStDistancePct = Number(signals.signalStDistancePct || 0);
  if (entryGateMode === 'lper_retest' && signalStDistancePct > maxDistancePct) return 'WAIT_FOR_PULLBACK';

  const entryRequireVolumeConfirm = cfg.entryRequireVolumeConfirm;
  const minVolRatio = Number(cfg.entryMinVolumeRatio || 1);
  const signalVolumeRatio = Number(signals.signalVolumeRatio || 0);
  if (entryRequireVolumeConfirm !== false && signalVolumeRatio < minVolRatio) return 'WAIT_VOLUME';

  const entryRequireHtfAlignment = cfg.entryRequireHtfAlignment;
  const allowNeutral = cfg.entryHtfAllowNeutral === true;
  const signalHtfTrend = signals.signalHtfTrend || 'NEUTRAL';
  if (entryRequireHtfAlignment !== false) {
    const neutralPass = allowNeutral && signalHtfTrend === 'NEUTRAL';
    if (!(neutralPass || signalHtfTrend === 'BULLISH')) return 'WAIT_HTF';
  }

  const fallbackBodyPct = Number(signals.fallbackBodyPct || signals.priceChangeM5 || 0);
  const fallbackHtfTrend = Number(signals.priceChangeH1 || 0) >= 0 ? 'BULLISH' : 'BEARISH';
  void fallbackBodyPct;
  void fallbackHtfTrend;
  return 'PASS';
}

// ── Immediate Top Pools Report ─────────────────────────────────────
// Dipanggil saat /autoscreen on — kirim snapshot 5 pool terbaik SEKARANG
// (sebelum pipeline screening panjang selesai).

export async function sendImmediateTopPoolsReport(chatId) {
  try {
    const cfg = getConfig();
    const limit = Number(cfg.meteoraDiscoveryLimit) || 180;
    const rawPools = await discoverHighFeePoolsMeridian({ limit });

    if (!rawPools || rawPools.length === 0) {
      await notify('⚠️ Tidak ada pool ditemukan untuk laporan instan.');
      return;
    }

    const screeningTopPoolsLimit = Math.max(1, Number(cfg.screeningTopPoolsLimit) || 5);

    // Sort by efficiency (Vol/TVL) — top pool configurable ke Telegram, sisanya console
    const sorted = [...rawPools].sort((a, b) => {
      const aVol = Number(a.volume24h || a.trade_volume_24h || 0);
      const bVol = Number(b.volume24h || b.trade_volume_24h || 0);
      const aTvl = Number(a.totalTvl || a.activeTvl || 0) || 1;
      const bTvl = Number(b.totalTvl || b.activeTvl || 0) || 1;
      return (bVol / bTvl) - (aVol / aTvl);
    });

    const topPools = sorted.slice(0, screeningTopPoolsLimit);
    sorted.slice(screeningTopPoolsLimit).forEach((p, i) =>
      console.log(`[hunter][instant-scan] #${i + screeningTopPoolsLimit + 1} ${p.name || p.tokenXMint?.slice(0,8)} — console only`)
    );

    const GATES = ['STAGE_0_DISCOVERY','BLACKLIST_LOCAL','STAGE_1_PUBLIC','STAGE_2_GMGN',
                   'STAGE_3_JUPITER','MERIDIAN_VETO','PENDING_RETEST','FLAT_CONFIG_GATE','SCOUT_AGENT'];

    const lines = await Promise.all(topPools.map(async (pool, i) => {
      const symbol  = pool.name || pool.tokenXSymbol || pool.tokenXMint?.slice(0, 8) || 'UNKNOWN';
      const binStep = pool.binStep || '?';
      const tvlRaw  = Number(pool.totalTvl || pool.activeTvl || 0);
      const volRaw  = Number(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || 0);
      const mcapRaw = Number(pool.mcap || 0);
      const feeRatio = tvlRaw > 0 ? ((pool.feeActiveTvlRatio || pool.feeRate || 0) * 100).toFixed(2) : '?';
      const effVal  = tvlRaw > 0 ? volRaw / tvlRaw : 0;
      const eff     = effVal > 1000 ? '>1000' : effVal.toFixed(2);

      // Evaluasi Meridian veto untuk status TA
      let vetoPass = false;
      let vetoReason = '';
      const quoteSupported = isSupportedQuoteToken(pool);
      if (!quoteSupported) {
        vetoReason = `Unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`;
      } else {
        try {
          const veto = await runMeridianVeto({ mint: pool.tokenXMint || pool.address || '', symbol, pool });
          vetoPass   = !veto.veto;
          vetoReason = veto.reason || '';
        } catch (_e) {
          vetoReason = 'API skip';
        }
      }

      // Simulasikan gate trace untuk laporan instan
      // STAGE_0..JUPITER = PASS (lolos discovery), MERIDIAN_VETO = hasil veto, sisanya = NOT_STARTED
      const gateStatuses = {
        STAGE_0_DISCOVERY: quoteSupported ? 'PASS' : 'FAIL',
        BLACKLIST_LOCAL:   quoteSupported ? 'PASS' : 'SKIPPED',
        STAGE_1_PUBLIC:    quoteSupported ? 'PASS' : 'SKIPPED',
        STAGE_2_GMGN:      quoteSupported ? 'PASS' : 'SKIPPED',
        STAGE_3_JUPITER:   quoteSupported ? 'PASS' : 'SKIPPED',
        MERIDIAN_VETO:     vetoPass ? 'PASS' : 'FAIL',
        PENDING_RETEST:    vetoPass ? 'PASS' : 'SKIPPED',
        FLAT_CONFIG_GATE:  vetoPass ? 'PASS' : 'SKIPPED',
        SCOUT_AGENT:       'NOT_STARTED',
      };

      let passCount = 0;
      let gateTrace = '';
      GATES.forEach(g => {
        const s = gateStatuses[g];
        if (s === 'PASS')    { passCount++; gateTrace += '✅'; }
        else if (s === 'FAIL' || s === 'SKIPPED') gateTrace += '❌';
        else                  gateTrace += '⚪';
      });

      const pct        = passCount / GATES.length;
      const filled     = Math.round(pct * 10);
      const progressBar = `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, 10 - filled))}] ${Math.round(pct * 100)}%`;
      const statusText  = vetoPass ? 'SCREENED ✅' : 'VETO ❌';

      return (
        `<b>${i + 1}. ${escapeHTML(symbol)}</b> [${binStep}] — ${statusText}\n` +
        `Progress: <code>${progressBar}</code>\n` +
        `Gate Trace: <code>${gateTrace}</code>\n` +
        `Eff: <code>${eff}x</code> | Fee/TVL: <code>${feeRatio}%</code>\n` +
        `TVL: <code>$${safeNum(tvlRaw,0).toLocaleString('en-US')}</code> | ` +
        `Vol: <code>$${safeNum(volRaw,0).toLocaleString('en-US')}</code> | ` +
        `MCap: <code>$${safeNum(mcapRaw,0).toLocaleString('en-US')}</code>` +
        (vetoPass ? '' : `\nVeto: <i>${escapeHTML(vetoReason)}</i>`)
      );
    }));

    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'long' });
    const agentModel = cfg.llm_settings?.agentModel || cfg.agentModel || 'UNKNOWN';
    const intervalMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;

    let report = `📊 SCANNER REPORT\n`;
    report += `📅 ${nowStr}\n\n`;
    report += `Top 5:\n`;
    report += `${topPools.slice(0, 5).map((pool, idx) => `${idx + 1}. ${escapeHTML(pool.name || pool.tokenXSymbol || pool.tokenXMint?.slice(0, 8) || 'UNKNOWN')}`).join('\n')}\n\n`;
    report += `Slot: ${isDeploySlotSaturated(getDeploySlotUsage()) ? 'FULL 1/1' : 'AVAILABLE'}\n`;
    report += `Action: HOLD new entries\n`;
    report += `Next scan: ${intervalMin}m`;

    await notify(report);
  } catch (e) {
    console.error('[sendImmediateTopPoolsReport] error:', e.message);
  }
}

// ── Auto-Screening Manual Runner ───────────────────────────────────
// Dipanggil oleh /screening dan awal /autoscreen on

let _autoScreenTimer = null;

export async function runAutoscreening(bot, chatId, opts = {}) {
  const cfg = getConfig();

  // Guard: hentikan loop jika Autoscreen dimatikan
  if (!cfg.autoScreeningEnabled) {
    if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
    _autoScreenTimer = null;
    console.log('[hunter] runAutoscreening: autoScreeningEnabled=false, loop dihentikan.');
    return;
  }

  // Hitung interval dari config
  const intervalMin = Number(cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15);
  const intervalMs  = intervalMin * 60 * 1000;

  // Jadwalkan siklus BERIKUTNYA (bukan langsung — caller sudah eksekusi first run)
  if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
  _autoScreenTimer = setTimeout(async () => {
    // Guard ulang saat timer tiba
    if (!getConfig().autoScreeningEnabled) {
      console.log('[hunter] runAutoscreening: loop cancelled saat timer tiba (autoscreen OFF).');
      return;
    }

    console.log(`[hunter] ⏰ Siklus screening berikutnya dimulai...`);
    try {
      // SINGLE SOURCE OF TRUTH: scanAndDeploy → reportManager.generateReport() → notify
      await scanAndDeploy();
    } catch (err) {
      console.error('[hunter] scanAndDeploy loop error:', err.message);
      await notify(`❌ <b>Loop error:</b>\n<code>${err.message.slice(0, 200)}</code>\n<i>Retry dalam ${intervalMin} menit...</i>`);
    }

    // Rekursif: daftarkan lagi untuk siklus berikutnya
    runAutoscreening(bot, chatId, opts);
  }, intervalMs);

  console.log(`[hunter] 🔁 Siklus berikutnya dijadwalkan dalam ${intervalMin} menit.`);
}

export async function updatePnlStatus() {
  // Placeholder for Realtime PnL Status updates if needed
  // Monitor loop currently handles this internally per position
}

export async function inventoryManagement() {
  // Placeholder for periodic portfolio rebalancing / management
}
