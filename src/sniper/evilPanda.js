/**
 * src/sniper/evilPanda.js — Linear Sniper Executor (RPC-First)
 *
 * Satu-satunya eksekutor di arsitektur Linear Sniper.
 * Tiga fungsi, tidak lebih:
 *   1. deployPosition(poolAddress)  → buka posisi DLMM
 *   2. monitorPnL(positionPubkey)   → cek TP/SL langsung dari chain
 *   3. exitPosition(positionPubkey) → tutup posisi + swap ke SOL
 *
 * Tidak ada DB, tidak ada circuit breaker, tidak ada strategy loader.
 * State minimal disimpan di _activePositions (in-memory, process lifetime).
 */

'use strict';

import DLMM, { StrategyType, POSITION_FEE, getBinArraysRequiredByPositionRange, isOverflowDefaultBinArrayBitmap, deriveBinArrayBitmapExtension } from '@meteora-ag/dlmm';
import { PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, SystemProgram, SystemInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConnection, getWallet, getTokenBalanceRaw } from '../solana/wallet.js';
import { getConfig } from '../config.js';
import { getJupiterQuote } from '../solana/jupiter.js';
import { getSwapQuoteToSol, swapToSol } from '../utils/jupiter.js';
import { safeNum, withExponentialBackoff, fetchWithTimeout } from '../utils/safeJson.js';
import { resolveTokens, WSOL_MINT } from '../utils/tokenMeta.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { addToBlacklist } from '../learn/tokenBlacklist.js';
import { recordPoolPatternOutcome } from '../learn/poolPatternLearning.js';
import { getDynamicStopLoss } from '../market/atrGuard.js';
import { getDLMMPoolData } from '../market/oracle.js';
import { recordPoolDeploy, recordPoolOutcome, recordPoolRentFailure } from '../market/poolMemory.js';
import { flushRuntimeState, getRuntimeState, setRuntimeState } from '../runtime/state.js';
import { clearPositionRuntimeState } from '../app/positionRuntimeState.js';
import { checkGasGuard } from '../safety/gasGuard.js';
import { assertRangeDoesNotRequireBinArrayInit, inspectRangeBinArrayInitStatus } from '../solana/meteora.js';
import { BIN_ARRAY_SIZE, selectRentFreeRange } from '../utils/binRangePolicy.js';
import { normalizeExitReason } from '../utils/exitReasons.js';
import { buildClosedPositionReport } from '../utils/exitReport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARVEST_LOG = join(__dirname, '../../harvest.log');
const POSITION_LEDGER_LOG = join(__dirname, '../../position-ledger.jsonl');
const ACTIVE_POSITIONS_STATE_KEY = 'evilPandaActivePositions';
const QUOTE_ONLY_DEPLOY_MARKERS_STATE_KEY = 'evilPandaQuoteOnlyDeployMarkers';
const QUOTE_ONLY_DEPLOY_MARKER_TTL_MS = 30 * 60 * 1000;
const BOT_QUOTE_ONLY_DEPLOY_SOURCE = 'BOT_QUOTE_ONLY_POSITION_FIRST';
const PHASE_POSITION_INIT_PENDING = 'POSITION_INIT_PENDING';
const PHASE_POSITION_INIT_CONFIRMED = 'POSITION_INIT_CONFIRMED';
const PHASE_ADD_LIQUIDITY_PENDING = 'ADD_LIQUIDITY_PENDING';
const PHASE_ADD_LIQUIDITY_FAILED = 'ADD_LIQUIDITY_FAILED';
const PHASE_ADD_LIQUIDITY_CONFIRMED = 'ADD_LIQUIDITY_CONFIRMED';

// ── Evil Panda Hardcoded Strategy ────────────────────────────────
const EP_CONFIG = {
  PRICE_RANGE_PCT:    90,
  OFFSET_MIN_PCT:      0,
  OFFSET_MAX_PCT:     90,
  COMPUTE_UNITS:   400_000,
  EXIT_COMPUTE_UNITS: 1_200_000,
  EXIT_MAX_COMPUTE_UNITS: 1_400_000,
  MICRO_LAMPORTS:  200_000,
  STOP_LOSS_PCT:      10,    // Hard SL — prioritas utama, selalu aktif
  RSI_EXIT_THRESHOLD: 90,    // RSI(2) overbought threshold
  MONITOR_INTERVAL_MS: 15_000,
};

// ── In-process position registry ─────────────────────────────────
// Key: positionPubkey (string)
// Value: { poolAddress, deploySol, deployedAt, tokenXMint, tokenYMint,
//          rangeMin, rangeMax, hwmPct }  ← hwmPct = High Water Mark PnL%
const _activePositions = new Map();
const _quoteOnlyDeployMarkers = new Map();
let _quoteOnlyDeployMarkersLoaded = false;
let _exitAccountingLock = false;
let _notifyFn = null;
const _deployBudgetReservations = new Map();
// Bounded search radius for rent-free fallback slices on the same pool.
// This only affects pools that already tripped the rent guard.
const RENT_FREE_SEARCH_SLACK_ARRAYS = 100;
// SDK enum fallback to numeric Spot strategy for backward compatibility.
const SPOT_STRATEGY_TYPE = StrategyType?.Spot ?? 0;
const DLMM_SDK_PATH_STRATEGY = 'strategy';
const DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY = 'weight_quote_only';
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const DEPLOY_POSITION_SETUP_SOL = Math.max(0, Number(POSITION_FEE || 0.05740608));
const DEPLOY_BUDGET_RESERVATION_TTL_MS = 5 * 60 * 1000;
const FROZEN_INTENT_MAX_BIN_DRIFT = 4;
const FROZEN_INTENT_MAX_AGE_MS = 180_000;
// Defensive Supertrend exits use a short confirmation window so a fresh deploy
// is not immediately churned by a single delayed/stale bearish TA snapshot.
const DEFENSIVE_EXIT_MIN_POSITION_AGE_MS = 30_000;
const DEFENSIVE_EXIT_CONFIRM_MS = 30_000;

function isFiniteInteger(value) {
  return Number.isFinite(value) && Number.isSafeInteger(value);
}

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeTrackedTrendDirection(value = '') {
  const trend = String(value || '').toUpperCase();
  if (trend === 'BULLISH' || trend === 'BEARISH') return trend;
  return 'UNKNOWN';
}

export function normalizeExecutionMode(value = '') {
  return String(value || '').trim().toLowerCase() === 'paper' ? 'paper' : 'real';
}

export function getNewEntryExecutionMode(cfg = getConfig()) {
  return cfg?.dryRun === true ? 'paper' : 'real';
}

function isManualTaExitPosition(reg = {}, cfg = getConfig()) {
  if (!reg || typeof reg !== 'object') return false;
  if (cfg?.manualTAExitEnabled !== true) return false;
  const entryOrigin = String(
    reg?.entryOrigin ||
    reg?.entryCanonicalSnapshot?.entryOrigin ||
    reg?.entryCanonicalSnapshot?.source ||
    ''
  ).toLowerCase();
  return entryOrigin === 'manual_ca' || entryOrigin === 'telegram_ca' || entryOrigin === 'telegram_raw_ca';
}

function evaluateFrozenEntryIntentForDeploy({
  enabled = false,
  frozenEntryActiveBin = null,
  frozenEntryPrice = null,
  frozenSnapshotAt = null,
  liveActiveBinId = null,
  livePrice = null,
  binStep = null,
  maxDriftPct = null,
  nowMs = Date.now(),
} = {}) {
  if (!enabled) {
    return { useFrozen: false, reason: 'disabled', driftBins: null, snapshotAgeMs: null };
  }
  if (!isFiniteInteger(Number(frozenEntryActiveBin)) || !Number.isFinite(Number(frozenEntryPrice)) || Number(frozenEntryPrice) <= 0) {
    return { useFrozen: false, reason: 'invalid_intent_fields', driftBins: null, snapshotAgeMs: null };
  }
  const snapshotTs = Number(frozenSnapshotAt);
  if (!Number.isFinite(snapshotTs) || snapshotTs <= 0) {
    return { useFrozen: false, reason: 'missing_snapshot_at', driftBins: null, snapshotAgeMs: null };
  }
  const snapshotAgeMs = Math.max(0, nowMs - snapshotTs);
  if (snapshotAgeMs > FROZEN_INTENT_MAX_AGE_MS) {
    return { useFrozen: false, reason: 'stale_snapshot', driftBins: null, snapshotAgeMs };
  }
  if (!isFiniteInteger(Number(liveActiveBinId))) {
    return { useFrozen: false, reason: 'live_active_unavailable', driftBins: null, snapshotAgeMs };
  }
  const driftBins = Math.abs(Number(frozenEntryActiveBin) - Number(liveActiveBinId));
  const livePriceNum = Number(livePrice);
  const frozenPriceNum = Number(frozenEntryPrice);
  const driftPct = Number.isFinite(livePriceNum) && livePriceNum > 0 && Number.isFinite(frozenPriceNum) && frozenPriceNum > 0
    ? Math.abs(((livePriceNum - frozenPriceNum) / frozenPriceNum) * 100)
    : null;
  const safeMaxDriftPct = Number.isFinite(Number(maxDriftPct)) && Number(maxDriftPct) > 0
    ? Math.max(0.1, Number(maxDriftPct))
    : null;
  if (driftBins > FROZEN_INTENT_MAX_BIN_DRIFT) {
    return { useFrozen: false, reason: 'active_bin_drift_too_large', driftBins, snapshotAgeMs, driftPct };
  }
  if (safeMaxDriftPct !== null && Number.isFinite(driftPct) && driftPct > safeMaxDriftPct) {
    return { useFrozen: false, reason: 'price_drift_too_large', driftBins, snapshotAgeMs, driftPct };
  }
  return { useFrozen: true, reason: 'ok', driftBins, snapshotAgeMs, driftPct };
}

function getCanonicalEntrySnapshot(reg = {}) {
  return reg?.entryCanonicalSnapshot && typeof reg.entryCanonicalSnapshot === 'object'
    ? reg.entryCanonicalSnapshot
    : null;
}

function buildRuntimeCanonicalEntrySnapshot({
  baseSnapshot = null,
  entryActiveBin = null,
  entryPrice = null,
  finalTrendStamp = null,
  anchorMetadata = null,
  rangeAdjustReason = null,
} = {}) {
  const snapshot = baseSnapshot && typeof baseSnapshot === 'object'
    ? { ...baseSnapshot }
    : {};

  if (Number.isFinite(Number(entryActiveBin))) {
    snapshot.entryActiveBin = Number(entryActiveBin);
  }
  if (Number.isFinite(Number(entryPrice)) && Number(entryPrice) > 0) {
    snapshot.entryPrice = Number(entryPrice);
  }
  if (finalTrendStamp && typeof finalTrendStamp === 'object') {
    snapshot.finalTrendStamp = {
      direction: String(finalTrendStamp.direction || 'UNKNOWN'),
      source: String(finalTrendStamp.source || 'unknown'),
      reason: String(finalTrendStamp.reason || ''),
      checkedAt: Number.isFinite(Number(finalTrendStamp.checkedAt))
        ? Number(finalTrendStamp.checkedAt)
        : null,
    };
  }
  if (anchorMetadata && typeof anchorMetadata === 'object') {
    snapshot.runtimeAnchor = {
      source: String(anchorMetadata.anchorSource || 'unknown'),
      activeBinId: Number.isFinite(Number(anchorMetadata.anchorActiveBinId))
        ? Number(anchorMetadata.anchorActiveBinId)
        : null,
      price: Number.isFinite(Number(anchorMetadata.anchorPrice))
        ? Number(anchorMetadata.anchorPrice)
        : null,
      snapshotAt: Number.isFinite(Number(anchorMetadata.anchorSnapshotAt))
        ? Number(anchorMetadata.anchorSnapshotAt)
        : null,
      driftBins: Number.isFinite(Number(anchorMetadata.anchorDriftBins))
        ? Number(anchorMetadata.anchorDriftBins)
        : null,
      driftPct: Number.isFinite(Number(anchorMetadata.anchorDriftPct))
        ? Number(anchorMetadata.anchorDriftPct)
        : null,
      reason: String(anchorMetadata.anchorReason || ''),
      rangeAdjustReason: String(rangeAdjustReason || anchorMetadata.rangeAdjustReason || ''),
    };
  } else if (rangeAdjustReason) {
    snapshot.runtimeAnchor = {
      source: 'unknown',
      activeBinId: null,
      price: null,
      snapshotAt: null,
      driftBins: null,
      driftPct: null,
      reason: '',
      rangeAdjustReason: String(rangeAdjustReason),
    };
  }

  return snapshot;
}

function readCanonicalEntryContext(reg = {}) {
  const snapshot = getCanonicalEntrySnapshot(reg);
  return {
    entryActiveBin: Number.isFinite(Number(snapshot?.entryActiveBin))
      ? Number(snapshot.entryActiveBin)
      : Number.isFinite(Number(reg?.entryActiveBin))
        ? Number(reg.entryActiveBin)
        : null,
    entryPrice: Number.isFinite(Number(snapshot?.entryPrice))
      ? Number(snapshot.entryPrice)
      : Number.isFinite(Number(reg?.entryPrice))
        ? Number(reg.entryPrice)
        : null,
    entryFinalTrend: snapshot?.finalTrendStamp?.direction
      ? normalizeTrackedTrendDirection(snapshot.finalTrendStamp.direction)
      : normalizeTrackedTrendDirection(reg?.entryFinalSupertrend15m),
    entryFinalTrendSource: String(
      snapshot?.finalTrendStamp?.source ||
      reg?.entryFinalSupertrendSource ||
      'unknown'
    ).toLowerCase(),
    entryFinalTrendAt: Number.isFinite(Number(snapshot?.finalTrendStamp?.checkedAt))
      ? Number(snapshot.finalTrendStamp.checkedAt)
      : Number.isFinite(Number(reg?.entryFinalSupertrendAt))
        ? Number(reg.entryFinalSupertrendAt)
        : null,
    snapshotAt: Number.isFinite(Number(snapshot?.snapshotAt))
      ? Number(snapshot.snapshotAt)
      : null,
  };
}

function isAccountNotInitializedDlmmError(error) {
  if (!error) return false;
  const meta = extractDlmmSdkDeployErrorMeta(error);
  if (Number(meta?.anchorErrorCode) === 3012) return true;
  const text = `${String(error?.message || '')}\n${String(error?.stack || '')}`;
  return /accountnotinitialized/i.test(text) || /error code:\s*3012/i.test(text) || /custom program error:\s*0xbc4/i.test(text);
}

function extractInsufficientLamportsError(error) {
  const text = `${String(error?.message || '')}\n${String(error?.stack || '')}`;
  const match = text.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
  if (!match) return null;
  const availableLamports = Number(match[1]);
  const requiredLamports = Number(match[2]);
  return {
    availableLamports: Number.isFinite(availableLamports) ? availableLamports : null,
    requiredLamports: Number.isFinite(requiredLamports) ? requiredLamports : null,
  };
}

function isInsufficientLamportsDlmmError(error) {
  if (!error) return false;
  const text = `${String(error?.message || '')}\n${String(error?.stack || '')}`;
  return /insufficient lamports/i.test(text);
}

function pruneExpiredDeployBudgetReservations(now = Date.now()) {
  for (const [id, row] of [..._deployBudgetReservations.entries()]) {
    const expiresAt = Number(row?.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      _deployBudgetReservations.delete(id);
    }
  }
}

function reserveDeployBudget({
  owner = 'unknown',
  poolAddress = '',
  requestedLamports = 0,
  ttlMs = DEPLOY_BUDGET_RESERVATION_TTL_MS,
} = {}) {
  const lamports = Math.max(0, Math.floor(Number(requestedLamports) || 0));
  const now = Date.now();
  pruneExpiredDeployBudgetReservations(now);
  const id = `${owner}:${String(poolAddress || 'nopool')}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  _deployBudgetReservations.set(id, {
    id,
    owner: String(owner || 'unknown'),
    poolAddress: String(poolAddress || ''),
    requestedLamports: lamports,
    reservedAt: now,
    expiresAt: now + Math.max(30_000, Number(ttlMs) || DEPLOY_BUDGET_RESERVATION_TTL_MS),
  });
  return { ok: true, id, requestedLamports: lamports };
}

function releaseDeployBudget(reservationId = '') {
  const id = String(reservationId || '');
  if (!id) return false;
  return _deployBudgetReservations.delete(id);
}

function getReservedDeployBudgetLamports({ excludeId = null } = {}) {
  pruneExpiredDeployBudgetReservations();
  let total = 0;
  for (const [id, row] of _deployBudgetReservations.entries()) {
    if (excludeId && id === excludeId) continue;
    total += Math.max(0, Math.floor(Number(row?.requestedLamports) || 0));
  }
  return total;
}

function estimateDeployRequiredLamports({
  deploySol = 0,
  cfg = getConfig(),
  positionSetupSol = DEPLOY_POSITION_SETUP_SOL,
} = {}) {
  const safeDeploySol = Math.max(0, Number(deploySol) || 0);
  const minSolToOpen = Math.max(0, Number(cfg?.minSolToOpen) || 0);
  const gasReserveSol = Math.max(0, Number(cfg?.gasReserve) || 0);
  const safePositionSetupSol = Math.max(0, Number(positionSetupSol) || 0);
  const requiredSol = Math.max(safeDeploySol, minSolToOpen) + gasReserveSol + safePositionSetupSol;
  return Math.ceil(requiredSol * 1e9);
}

let _deployBudgetReservationLock = false;

async function reserveDeployBudgetAgainstWallet({
  connection,
  walletPublicKey,
  deploySol = 0,
  cfg = getConfig(),
  poolAddress = '',
  owner = 'deployPosition',
  positionSetupSol = DEPLOY_POSITION_SETUP_SOL,
} = {}) {
  const startedAt = Date.now();
  while (_deployBudgetReservationLock) {
    if ((Date.now() - startedAt) > 2_000) {
      return { ok: false, reason: 'DEPLOY_BUDGET_LOCK_TIMEOUT' };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  _deployBudgetReservationLock = true;
  try {
    const walletLamports = await connection.getBalance(walletPublicKey).catch(() => 0);
    const reservedLamports = getReservedDeployBudgetLamports();
    const requestedLamports = estimateDeployRequiredLamports({ deploySol, cfg, positionSetupSol });
    const walletCheck = evaluateDeployWalletFunds({
      walletLamports,
      deploySol,
      cfg,
      reservedLamports,
      positionSetupSol,
    });
    const totalNeededLamports = reservedLamports + requestedLamports;
    if (!walletCheck.ok || walletLamports < totalNeededLamports) {
      return {
        ok: false,
        walletLamports,
        reservedLamports,
        requestedLamports,
        walletCheck,
      };
    }
    const reservation = reserveDeployBudget({
      owner,
      poolAddress,
      requestedLamports,
    });
    return {
      ok: true,
      id: reservation.id,
      requestedLamports,
      walletLamports,
      reservedLamports,
    };
  } finally {
    _deployBudgetReservationLock = false;
  }
}

function evaluateDeployWalletFunds({
  walletLamports = 0,
  deploySol = 0,
  cfg = getConfig(),
  reservedLamports = 0,
  positionSetupSol = DEPLOY_POSITION_SETUP_SOL,
} = {}) {
  const walletLamportsSafe = Math.max(0, Number(walletLamports || 0));
  const reservedLamportsSafe = Math.max(0, Math.floor(Number(reservedLamports) || 0));
  const effectiveAvailableLamports = Math.max(0, walletLamportsSafe - reservedLamportsSafe);
  const availableSol = effectiveAvailableLamports / 1e9;
  const safeDeploySol = Math.max(0, Number(deploySol) || 0);
  const minSolToOpen = Math.max(0, Number(cfg?.minSolToOpen) || 0);
  const gasReserveSol = Math.max(0, Number(cfg?.gasReserve) || 0);
  const positionSetupSolSafe = Math.max(0, Number(positionSetupSol) || 0);
  const requiredSol = Math.max(safeDeploySol, minSolToOpen) + gasReserveSol + positionSetupSolSafe;
  const ok = availableSol >= requiredSol;
  return {
    ok,
    availableSol,
    walletSol: walletLamportsSafe / 1e9,
    requiredSol,
    deploySol: safeDeploySol,
    minSolToOpen,
    gasReserveSol,
    positionSetupSol: positionSetupSolSafe,
    reservedSol: reservedLamportsSafe / 1e9,
    shortfallSol: Math.max(0, requiredSol - availableSol),
  };
}

function buildInsufficientBalanceBlockedResult({
  walletCheck = {},
  poolAddress = '',
  strategyShape = 'spot',
  strategyType = null,
} = {}) {
  const detail =
    `available=${walletCheck.availableSol.toFixed(6)} SOL, ` +
    `required=${walletCheck.requiredSol.toFixed(6)} SOL ` +
    `(deploy=${walletCheck.deploySol.toFixed(6)} + reserve=${walletCheck.gasReserveSol.toFixed(6)} + setup=${Number(walletCheck.positionSetupSol || 0).toFixed(6)}` +
    `${Number(walletCheck.reservedSol || 0) > 0 ? ` + reserved=${Number(walletCheck.reservedSol || 0).toFixed(6)}` : ''}), ` +
    `shortfall=${walletCheck.shortfallSol.toFixed(6)} SOL, ` +
    `shape=${String(strategyShape || 'spot')}, strategyType=${Number.isFinite(Number(strategyType)) ? Number(strategyType) : 'na'}`;
  return {
    blocked: true,
    reason: 'INSUFFICIENT_SOL_BALANCE',
    detail,
    poolAddress,
    requiredSol: walletCheck.requiredSol,
    availableSol: walletCheck.availableSol,
    shortfallSol: walletCheck.shortfallSol,
    deploySol: walletCheck.deploySol,
    minSolToOpen: walletCheck.minSolToOpen,
    gasReserveSol: walletCheck.gasReserveSol,
    positionSetupSol: walletCheck.positionSetupSol,
    reservedSol: walletCheck.reservedSol,
    strategyShape: String(strategyShape || 'spot'),
    strategyType: Number.isFinite(Number(strategyType)) ? Number(strategyType) : null,
  };
}

function buildInvalidDlmmArgsError(message) {
  const err = new Error(`Invalid DLMM deploy args: ${message}`);
  err.code = 'INVALID_DLMM_DEPLOY_ARGS';
  err.isPermanent = true;
  return err;
}

function stringifyAmount(value) {
  try {
    if (BN.isBN(value)) return value.toString();
    if (value === null || value === undefined) return '0';
    return String(value);
  } catch {
    return '0';
  }
}

function isExplicitConfigTrue(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function normalizeDlmmLiquidityShape(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'bidask') return 'bidask';
  return 'spot';
}

function getDlmmLiquidityShapeDebug(cfg = {}) {
  const raw = cfg?.dlmmLiquidityShape;
  return {
    raw: raw === undefined || raw === null ? '' : String(raw),
    normalized: normalizeDlmmLiquidityShape(raw),
  };
}

export function getDlmmStrategyTypeFromConfig(cfg = {}) {
  const shape = normalizeDlmmLiquidityShape(cfg?.dlmmLiquidityShape);
  return shape === 'bidask'
    ? (StrategyType?.BidAsk ?? 2)
    : (StrategyType?.Spot ?? 0);
}

function toBnAmountSafe(value) {
  try {
    if (BN.isBN(value)) return value;
    if (typeof value === 'bigint') return new BN(value.toString());
    if (value === null || value === undefined) return new BN('0');
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) return new BN('0');
      return new BN(String(value));
    }
    const normalized = stringifyAmount(value).trim();
    if (!normalized || !/^-?\d+$/.test(normalized)) return new BN('0');
    return new BN(normalized);
  } catch {
    return new BN('0');
  }
}

function toBnAmountStrict(value, fieldName = 'amount') {
  if (BN.isBN(value)) return value;
  if (typeof value === 'bigint') return new BN(value.toString());
  if (value === null || value === undefined) return new BN('0');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw buildInvalidDlmmArgsError(`${fieldName} must be finite integer (got ${String(value)})`);
    }
    return new BN(String(value));
  }
  const normalized = stringifyAmount(value).trim();
  if (!normalized || !/^-?\d+$/.test(normalized)) {
    throw buildInvalidDlmmArgsError(`${fieldName} must be BN/number-like integer (got ${String(value)})`);
  }
  try {
    return new BN(normalized);
  } catch {
    throw buildInvalidDlmmArgsError(`${fieldName} must be BN/number-like integer (got ${String(value)})`);
  }
}

function classifyDlmmLiquiditySide(amountX, amountY) {
  const amountXPos = amountX.gt(new BN('0'));
  const amountYPos = amountY.gt(new BN('0'));
  if (!amountXPos && amountYPos) return 'QUOTE_ONLY';
  if (amountXPos && !amountYPos) return 'BASE_ONLY';
  if (amountXPos && amountYPos) return 'MIXED';
  return 'INVALID';
}

function enforceDlmmSideRangeInvariants({
  activeBinId,
  rangeMin,
  rangeMax,
  amountX,
  amountY,
} = {}) {
  let safeMin = rangeMin;
  let safeMax = rangeMax;
  const rangeWidth = safeMax - safeMin + 1;
  const side = classifyDlmmLiquiditySide(amountX, amountY);
  const includesActive = safeMin <= activeBinId && safeMax >= activeBinId;
  let adjustmentReason = null;
  let adjustedBelowActive = false;
  let adjustedAboveActive = false;

  if (!isFiniteInteger(activeBinId)) {
    throw buildInvalidDlmmArgsError(`activeBinId must be finite integer (got ${String(activeBinId)})`);
  }
  if (!isFiniteInteger(safeMin) || !isFiniteInteger(safeMax)) {
    throw buildInvalidDlmmArgsError(`rangeMin/rangeMax must be finite integers (got ${String(safeMin)}/${String(safeMax)})`);
  }
  if (safeMin > safeMax) {
    throw buildInvalidDlmmArgsError(`rangeMin must be <= rangeMax (got ${safeMin} > ${safeMax})`);
  }
  if (!isFiniteInteger(rangeWidth) || rangeWidth <= 0) {
    throw buildInvalidDlmmArgsError(`range width invalid (${String(rangeWidth)})`);
  }

  if (side === 'QUOTE_ONLY' && safeMax > activeBinId) {
    // Manual Meteora single-sided SOL can keep the top edge on the active bin.
    // We only clamp ranges that overshoot above active, while preserving width.
    safeMax = activeBinId;
    safeMin = safeMax - (rangeWidth - 1);
    adjustmentReason = 'clamp_to_active_quote_only';
    adjustedBelowActive = true;
  } else if (side === 'BASE_ONLY' && safeMin <= activeBinId) {
    safeMin = activeBinId + 1;
    safeMax = safeMin + (rangeWidth - 1);
    adjustmentReason = 'shift_above_active_base_only';
    adjustedAboveActive = true;
  }

  if (!isFiniteInteger(safeMin) || !isFiniteInteger(safeMax) || safeMin > safeMax) {
    throw buildInvalidDlmmArgsError(`single-side range adjustment invalid [${String(safeMin)},${String(safeMax)}]`);
  }
  if (side === 'QUOTE_ONLY' && safeMax > activeBinId) {
    throw buildInvalidDlmmArgsError('single-side quote final range must not exceed active bin');
  }
  if (side === 'BASE_ONLY' && safeMin <= activeBinId) {
    throw buildInvalidDlmmArgsError('single-side tokenX final range must be above active bin');
  }

  return {
    rangeMin: safeMin,
    rangeMax: safeMax,
    side,
    includesActive,
    adjustmentReason,
    adjustedBelowActive,
    adjustedAboveActive,
  };
}

export function rebuildDeployArgsWithRefreshedActiveBin({
  deployArgs = {},
  refreshedActiveBinId,
} = {}) {
  return buildDlmmDeployStrategyArgs({
    activeBinId: Number(refreshedActiveBinId),
    rangeMin: Number(deployArgs?.rangeMin),
    rangeMax: Number(deployArgs?.rangeMax),
    amountXBn: deployArgs?.amountXBn,
    amountYBn: deployArgs?.amountYBn,
    strategyType: deployArgs?.strategyType,
  });
}

export function wrapDlmmSdkInvalidArgumentsError({
  error,
  finalArgsContext = {},
} = {}) {
  const insufficientLamports = extractInsufficientLamportsError(error);
  if (insufficientLamports) {
    const availableSol = Number.isFinite(insufficientLamports.availableLamports)
      ? insufficientLamports.availableLamports / 1e9
      : null;
    const requiredSol = Number.isFinite(insufficientLamports.requiredLamports)
      ? insufficientLamports.requiredLamports / 1e9
      : null;
    const err = buildInvalidDlmmArgsError(
      `INSUFFICIENT_SOL_BALANCE: available=${availableSol !== null ? availableSol.toFixed(6) : 'unknown'} ` +
      `required=${requiredSol !== null ? requiredSol.toFixed(6) : 'unknown'} ` +
      `context=${JSON.stringify(finalArgsContext || {})}`
    );
    err.code = 'INSUFFICIENT_SOL_BALANCE';
    err.isPermanent = true;
    err.balanceMeta = {
      availableLamports: insufficientLamports.availableLamports,
      requiredLamports: insufficientLamports.requiredLamports,
      availableSol,
      requiredSol,
    };
    err.dlmmContextExtra = {
      ...(finalArgsContext || {}),
      balanceAvailableLamports: insufficientLamports.availableLamports,
      balanceRequiredLamports: insufficientLamports.requiredLamports,
      balanceAvailableSol: availableSol,
      balanceRequiredSol: requiredSol,
    };
    return err;
  }

  const sdkErrorMeta = extractDlmmSdkDeployErrorMeta(error);
  const hasInvalidCode = error?.code === 'INVALID_DLMM_DEPLOY_ARGS';
  if (!sdkErrorMeta?.isDlmmSdkDeployError && !hasInvalidCode) {
    return null;
  }
  const extraContext = (error && typeof error === 'object' && error.dlmmContextExtra && typeof error.dlmmContextExtra === 'object')
    ? error.dlmmContextExtra
    : {};
  const sdkPath = String(finalArgsContext?.sdkPath || DLMM_SDK_PATH_STRATEGY);
  const sdkMethod = String(
    finalArgsContext?.sdkMethod
    || extraContext?.sdkMethod
    || (sdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY
      ? 'initializePositionAndAddLiquidityByWeight'
      : 'initializePositionAndAddLiquidityByStrategy')
  );
  const context = {
    ...finalArgsContext,
    ...extraContext,
    sdkPath,
    sdkMethod,
    anchorErrorCode: Number.isFinite(Number(sdkErrorMeta?.anchorErrorCode))
      ? Number(sdkErrorMeta.anchorErrorCode)
      : null,
    anchorErrorHex: sdkErrorMeta?.anchorErrorHex || null,
    anchorErrorName: sdkErrorMeta?.anchorErrorName || null,
    instructionIndex: Number.isFinite(Number(sdkErrorMeta?.instructionIndex))
      ? Number(sdkErrorMeta.instructionIndex)
      : null,
  };
  const hasAnchorSignals =
    Number.isFinite(Number(sdkErrorMeta?.anchorErrorCode)) ||
    Boolean(sdkErrorMeta?.anchorErrorName) ||
    Number.isFinite(Number(sdkErrorMeta?.instructionIndex));
  const reasonLabel = ((sdkErrorMeta?.isInvalidArguments || hasInvalidCode) && !hasAnchorSignals)
    ? 'invalid arguments'
    : 'deploy simulation/account error';
  return buildInvalidDlmmArgsError(
    `SDK rejected ${sdkMethod} with ${reasonLabel} ` +
    `context=${JSON.stringify(context)}`
  );
}

export function isDlmmSdkInvalidArgumentsError(error) {
  if (!error) return false;
  if (error?.code === 'INVALID_DLMM_DEPLOY_ARGS') return true;
  return extractDlmmSdkDeployErrorMeta(error).isDlmmSdkDeployError;
}

function safeStringifyErrorObject(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getTxInstructions(tx) {
  if (!tx) return [];
  if (Array.isArray(tx?.instructions)) return tx.instructions;
  const msg = tx?.message;
  if (Array.isArray(msg?.compiledInstructions) && Array.isArray(msg?.staticAccountKeys)) {
    return msg.compiledInstructions.map((compiledIx) => {
      const programId = msg.staticAccountKeys?.[compiledIx?.programIdIndex];
      return {
        programId,
        data: compiledIx?.data,
        accounts: Array.isArray(compiledIx?.accountKeyIndexes)
          ? compiledIx.accountKeyIndexes.map((idx) => msg.staticAccountKeys?.[idx]).filter(Boolean)
          : [],
      };
    });
  }
  return [];
}

function instructionDataToBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === 'string') {
    try { return Buffer.from(data, 'base64'); } catch { return Buffer.from(data); }
  }
  return Buffer.alloc(0);
}

const INITIALIZE_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);
const INITIALIZE_BIN_ARRAY_BITMAP_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]);

function inspectTxForBinArrayInit(tx) {
  const instructions = getTxInstructions(tx);
  let hasInitBinArray = false;
  let hasInitBitmap = false;
  for (const ix of instructions) {
    const programId = String(ix?.programId?.toString?.() || ix?.programId || '');
    const data = instructionDataToBuffer(ix?.data);
    const discriminator = data.length >= 8 ? data.subarray(0, 8) : Buffer.alloc(0);
    if (discriminator.length === 8 && discriminator.equals(INITIALIZE_BIN_ARRAY_DISCRIMINATOR)) {
      hasInitBinArray = true;
    }
    if (discriminator.length === 8 && discriminator.equals(INITIALIZE_BIN_ARRAY_BITMAP_DISCRIMINATOR)) {
      hasInitBitmap = true;
    }
    if (/initializeBinArrayBitmapExtension/i.test(programId) || /initializeBinArrayBitmapExtension/i.test(String(ix?.name || ''))) {
      hasInitBitmap = true;
    }
    if (/initializeBinArray/i.test(String(ix?.name || ''))) {
      hasInitBinArray = true;
    }
  }
  return { hasInitBinArray, hasInitBitmap, instructionCount: instructions.length };
}

function buildBinArrayGuardContext({
  poolAddress = '',
  sdkPath = '',
  rangeMin = null,
  rangeMax = null,
  missingCount = 0,
  missingIndexes = [],
  hasInitBinArray = false,
  hasInitBitmap = false,
  action = 'ALLOW',
  reason = '',
  instructionCount = 0,
} = {}) {
  return {
    pool: String(poolAddress || ''),
    sdkPath: String(sdkPath || ''),
    rangeMin: Number.isFinite(Number(rangeMin)) ? Number(rangeMin) : null,
    rangeMax: Number.isFinite(Number(rangeMax)) ? Number(rangeMax) : null,
    bins: Number.isFinite(Number(rangeMin)) && Number.isFinite(Number(rangeMax))
      ? (Number(rangeMax) - Number(rangeMin) + 1)
      : null,
    hasMissingBinArray: Number(missingCount || 0) > 0,
    hasInitBinArray: Boolean(hasInitBinArray),
    hasInitBitmap: Boolean(hasInitBitmap),
    action,
    reason,
    preflightMissingBinArrayCount: Number(missingCount || 0),
    preflightMissingBinArrayIndexes: Array.isArray(missingIndexes) ? missingIndexes : [],
    instructionCount,
  };
}

async function guardDlmmCostBeforeSend({
  connection,
  poolPubkey,
  poolAddress = '',
  dlmmPool = null,
  deployArgs = {},
  sdkPath = '',
  txs = [],
  positionPubkey = '',
  cleanupFn = null,
  finalArgsContext = {},
  strictPreflightVeto = false,
} = {}) {
  const rangeMin = Number(deployArgs?.rangeMin);
  const rangeMax = Number(deployArgs?.rangeMax);
  const programId = dlmmPool?.program?.programId || dlmmPool?.programId || DLMM_PROGRAM_ID;
  const preflightStatus = await inspectRangeBinArrayInitStatus(connection, poolPubkey, rangeMin, rangeMax).catch(() => null);
  const preflightMissingIndexes = Array.isArray(preflightStatus?.arrayStatuses)
    ? preflightStatus.arrayStatuses.filter((s) => s?.initialized === false).map((s) => Number(s?.idx))
    : [];
  const requiredBinArrays = getBinArraysRequiredByPositionRange(
    poolPubkey,
    new BN(String(rangeMin)),
    new BN(String(rangeMax)),
    programId,
  ) || [];
  const requiredIndexes = requiredBinArrays.map((item) => Number(item?.index?.toString?.() || item?.index || 0));
  const requiredKeys = requiredBinArrays.map((item) => item?.key).filter(Boolean);
  const accounts = requiredKeys.length > 0 && connection?.getMultipleAccountsInfo
    ? await connection.getMultipleAccountsInfo(requiredKeys).catch(() => [])
    : [];
  const missingIndexes = [];
  for (let i = 0; i < requiredBinArrays.length; i++) {
    if (!accounts[i]) missingIndexes.push(requiredIndexes[i]);
  }
  if (preflightMissingIndexes.length > 0) {
    for (const idx of preflightMissingIndexes) {
      if (!missingIndexes.includes(idx)) missingIndexes.push(idx);
    }
  }
  let hasInitBinArray = false;
  let hasInitBitmap = false;
  let instructionCount = 0;
  for (const tx of Array.isArray(txs) ? txs : [txs]) {
    const txInfo = inspectTxForBinArrayInit(tx);
    instructionCount += txInfo.instructionCount;
    hasInitBinArray = hasInitBinArray || txInfo.hasInitBinArray;
    hasInitBitmap = hasInitBitmap || txInfo.hasInitBitmap;
  }
  const bitmapNeeded = requiredIndexes.some((idx) => isOverflowDefaultBinArrayBitmap(new BN(String(idx))));
  let bitmapMissing = false;
  if (bitmapNeeded && connection?.getAccountInfo) {
    try {
      const [bitmapPda] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const bitmapAcc = await connection.getAccountInfo(bitmapPda);
      bitmapMissing = !bitmapAcc;
    } catch {
      bitmapMissing = false;
    }
  }
  const effectiveHasInitBitmap = hasInitBitmap || bitmapMissing;
  const hasPreflightMissing = missingIndexes.length > 0 || bitmapMissing;
  const hasGeneratedInitProof = hasInitBinArray || hasInitBitmap;
  const strictPreflightMode = Boolean(strictPreflightVeto);
  const action = hasGeneratedInitProof
    ? 'VETO'
    : (strictPreflightMode && hasPreflightMissing
      ? 'VETO'
      : (hasPreflightMissing ? 'DIAG_ONLY' : 'ALLOW'));
  let reason = 'ALLOW';
  if (hasGeneratedInitProof) {
    reason = hasInitBitmap
      ? 'VETO_BIN_ARRAY_BITMAP_RENT_REQUIRED'
      : 'VETO_BIN_ARRAY_RENT_REQUIRED';
  } else if (strictPreflightMode && hasPreflightMissing) {
    reason = bitmapMissing
      ? 'VETO_BIN_ARRAY_BITMAP_RENT_REQUIRED'
      : 'VETO_BIN_ARRAY_RENT_REQUIRED';
  } else if (hasPreflightMissing) {
    reason = 'TX_CLEAN_PREFLIGHT_ONLY';
  }
  const context = buildBinArrayGuardContext({
    poolAddress,
    sdkPath,
    rangeMin,
    rangeMax,
    missingCount: missingIndexes.length,
    missingIndexes,
    hasInitBinArray,
    hasInitBitmap: effectiveHasInitBitmap,
    action,
    reason,
    instructionCount,
  });
  console.log(
    `[evilPanda] DLMM_COST_GUARD pool=${String(poolAddress || '').slice(0,8)} sdkPath=${sdkPath} ` +
      `range=[${rangeMin},${rangeMax}] bins=${context.bins} hasMissingBinArray=${context.hasMissingBinArray} ` +
      `hasInitBinArray=${hasInitBinArray} hasInitBitmap=${effectiveHasInitBitmap} ` +
      `preflightMissingBinArrayCount=${missingIndexes.length} preflightEstimatedRentSol=${String(preflightStatus?.estimatedRentSol || 'unknown')} ` +
      `strictPreflightVeto=${strictPreflightMode ? 'true' : 'false'} action=${action} reason=${reason}`
  );
  if (action === 'VETO') {
    const err = buildInvalidDlmmArgsError(
      `${reason}: preflightMissingCount=${missingIndexes.length} preflightMissingIndexes=${missingIndexes.join(',') || 'none'} ` +
      `bitmapNeeded=${bitmapNeeded ? 'true' : 'false'} bitmapMissing=${bitmapMissing ? 'true' : 'false'} ` +
      `estimatedRentSol=${String(preflightStatus?.estimatedRentSol || 'unknown')}`
    );
    err.code = reason;
    err.isPermanent = true;
    err.dlmmContextExtra = {
      ...finalArgsContext,
      ...context,
      strictPreflightVeto: strictPreflightMode,
    };
    if (typeof cleanupFn === 'function') {
      await cleanupFn({ reason, context: err.dlmmContextExtra }).catch(() => {});
    }
    throw err;
  }
  return context;
}

export function extractDlmmSdkDeployErrorMeta(error) {
  if (!error) {
    return {
      isDlmmSdkDeployError: false,
      isInvalidArguments: false,
      anchorErrorCode: null,
      anchorErrorHex: null,
      anchorErrorName: null,
      instructionIndex: null,
    };
  }

  const logs = getErrorLogs(error);
  const blobs = [
    String(error?.message || ''),
    String(error?.stack || ''),
    logs.join('\n'),
    safeStringifyErrorObject(error),
    safeStringifyErrorObject(error?.cause),
    safeStringifyErrorObject(error?.err),
    safeStringifyErrorObject(error?.error),
    safeStringifyErrorObject(error?.data),
    safeStringifyErrorObject(error?.simulationResponse),
    safeStringifyErrorObject(error?.value),
  ].filter(Boolean);
  const text = blobs.join('\n');
  const lower = text.toLowerCase();
  const isWrappedDlmmDeployArgs = /^Invalid DLMM deploy args:/i.test(String(error?.message || ''));

  const invalidArguments = !isWrappedDlmmDeployArgs && /invalid arguments/i.test(text);
  const instructionIndexMatch =
    text.match(/instructionerror"\s*:\s*\[\s*(-?\d+)/i)
    || text.match(/instructionerror\s*:\s*\[\s*(-?\d+)/i)
    || text.match(/error processing instruction\s+(-?\d+)\s*:\s*custom program error/i);
  const instructionIndex = instructionIndexMatch
    ? Number.parseInt(instructionIndexMatch[1], 10)
    : null;

  const customCodeMatch =
    text.match(/"custom"\s*:\s*(-?\d+)/i)
    || text.match(/custom"\s*:\s*(-?\d+)/i);
  const customCode = customCodeMatch
    ? Number.parseInt(customCodeMatch[1], 10)
    : null;

  const hexMatch = text.match(/custom program error:\s*(0x[0-9a-f]+)/i);
  let anchorErrorHex = hexMatch ? String(hexMatch[1]).toLowerCase() : null;

  const parsedHexCode = anchorErrorHex
    ? Number.parseInt(anchorErrorHex, 16)
    : null;

  const hasInstructionError = lower.includes('instructionerror');
  const hasCode3012 = customCode === 3012 || /"custom"\s*:\s*3012/i.test(text);
  const hasHex0bc4 = anchorErrorHex === '0xbc4' || /custom program error:\s*0xbc4/i.test(text);
  const hasCode3007 = customCode === 3007 || /"custom"\s*:\s*3007/i.test(text);
  const hasHex0bbf = anchorErrorHex === '0xbbf' || /custom program error:\s*0xbbf/i.test(text);
  const hasOwnedByWrongProgram = /accountownedbywrongprogram/i.test(text);
  const hasAccountNotInitialized = /accountnotinitialized/i.test(text);

  let anchorErrorCode = Number.isFinite(customCode) ? customCode : null;
  if (anchorErrorCode === null && hasCode3012) anchorErrorCode = 3012;
  if (anchorErrorCode === null && hasCode3007) anchorErrorCode = 3007;
  if (anchorErrorCode === null && Number.isFinite(parsedHexCode)) anchorErrorCode = Number(parsedHexCode);
  if (anchorErrorCode === null && anchorErrorHex === '0xbc4') anchorErrorCode = 3012;
  if (anchorErrorCode === null && anchorErrorHex === '0xbbf') anchorErrorCode = 3007;
  if (!anchorErrorHex && anchorErrorCode === 3012) anchorErrorHex = '0xbc4';
  if (!anchorErrorHex && anchorErrorCode === 3007) anchorErrorHex = '0xbbf';

  let anchorErrorName = null;
  if (hasOwnedByWrongProgram || anchorErrorCode === 3007 || anchorErrorHex === '0xbbf') {
    anchorErrorName = 'AccountOwnedByWrongProgram';
  } else if (hasAccountNotInitialized || anchorErrorCode === 3012 || anchorErrorHex === '0xbc4') {
    anchorErrorName = 'AccountNotInitialized';
  } else if (anchorErrorCode === 6002 || anchorErrorHex === '0x1772') {
    anchorErrorName = 'InvalidInput';
  }

  const hasProcessingInstructionCustomProgramError = /error processing instruction\s+\d+\s*:\s*custom program error/i.test(lower);
  const hasKnownAnchorHex = anchorErrorHex === '0xbbf' || anchorErrorHex === '0xbc4';
  const hasHighCustomProgramCode = Number.isFinite(anchorErrorCode) && Number(anchorErrorCode) >= 6000;

  const isSimulationAccountError =
    hasHex0bbf ||
    hasHex0bc4 ||
    hasCode3007 ||
    hasCode3012 ||
    hasProcessingInstructionCustomProgramError && (hasKnownAnchorHex || hasHighCustomProgramCode) ||
    hasOwnedByWrongProgram ||
    hasAccountNotInitialized ||
    (hasInstructionError && (anchorErrorCode !== null || /custom program error/i.test(lower)));

  return {
    isDlmmSdkDeployError: Boolean(error?.code === 'INVALID_DLMM_DEPLOY_ARGS') || invalidArguments || isSimulationAccountError,
    isInvalidArguments: invalidArguments,
    anchorErrorCode,
    anchorErrorHex,
    anchorErrorName,
    instructionIndex: Number.isFinite(Number(instructionIndex)) ? Number(instructionIndex) : null,
  };
}

export function buildDlmmFinalArgsContext({
  poolAddress = '',
  xMint = '',
  yMint = '',
  deployArgs = {},
  sdkStrategy = null,
  initialActiveBinId = null,
  refreshedActiveBinId = null,
  adjustmentReason = null,
  anchorSource = null,
  anchorActiveBinId = null,
  anchorPrice = null,
  anchorSnapshotAt = null,
  anchorDriftBins = null,
  anchorDriftPct = null,
  anchorReason = null,
  rangeAdjustReason = null,
} = {}) {
  const activeBinId = Number(deployArgs?.activeBinId);
  const rangeMin = Number(deployArgs?.rangeMin);
  const rangeMax = Number(deployArgs?.rangeMax);
  const amountX = toBnAmountSafe(deployArgs?.amountXBn);
  const amountY = toBnAmountSafe(deployArgs?.amountYBn);
  const strategyType = Number(sdkStrategy?.strategyType ?? deployArgs?.strategyType);
  const side = classifyDlmmLiquiditySide(amountX, amountY);
  const activeInsideRange = Number.isFinite(activeBinId) && Number.isFinite(rangeMin) && Number.isFinite(rangeMax)
    ? (rangeMin <= activeBinId && rangeMax >= activeBinId)
    : false;
  return {
    pool: String(poolAddress || ''),
    tokenXMint: String(xMint || ''),
    tokenYMint: String(yMint || ''),
    activeBinId: Number.isFinite(activeBinId) ? activeBinId : null,
    rangeMin: Number.isFinite(rangeMin) ? rangeMin : null,
    rangeMax: Number.isFinite(rangeMax) ? rangeMax : null,
    rangeWidth: (Number.isFinite(rangeMin) && Number.isFinite(rangeMax)) ? (rangeMax - rangeMin + 1) : null,
    initialActiveBinId: isFiniteInteger(Number(initialActiveBinId)) ? Number(initialActiveBinId) : null,
    refreshedActiveBinId: isFiniteInteger(Number(refreshedActiveBinId)) ? Number(refreshedActiveBinId) : null,
    amountX: amountX.toString(),
    amountY: amountY.toString(),
    amountXIsZero: amountX.isZero(),
    amountYIsZero: amountY.isZero(),
    singleSide: side,
    activeInsideRange,
    strategyType: Number.isFinite(strategyType) ? strategyType : null,
    quoteSide: String(yMint || '') === WSOL_MINT ? 'SOL' : 'QUOTE',
    adjustedReason: adjustmentReason || deployArgs?.adjustmentReason || null,
    rangeAdjustReason: rangeAdjustReason || adjustmentReason || deployArgs?.adjustmentReason || null,
    sdkMinBinId: Number.isFinite(Number(sdkStrategy?.minBinId)) ? Number(sdkStrategy.minBinId) : null,
    sdkMaxBinId: Number.isFinite(Number(sdkStrategy?.maxBinId)) ? Number(sdkStrategy.maxBinId) : null,
    anchorSource: anchorSource ? String(anchorSource) : null,
    anchorActiveBinId: isFiniteInteger(Number(anchorActiveBinId)) ? Number(anchorActiveBinId) : null,
    anchorPrice: Number.isFinite(Number(anchorPrice)) ? Number(anchorPrice) : null,
    anchorSnapshotAt: Number.isFinite(Number(anchorSnapshotAt)) ? Number(anchorSnapshotAt) : null,
    anchorDriftBins: Number.isFinite(Number(anchorDriftBins)) ? Number(anchorDriftBins) : null,
    anchorDriftPct: Number.isFinite(Number(anchorDriftPct)) ? Number(anchorDriftPct) : null,
    anchorReason: anchorReason ? String(anchorReason) : null,
  };
}

export async function prepareFinalDlmmDeployAttemptState({
  dlmmPool = null,
  connection = null,
  poolPubkey = null,
  poolAddress = '',
  xMint = '',
  yMint = '',
  deployArgs = {},
  currentRentGuard = null,
  hasNonRefundableFees = false,
  rangeMaxBins = 0,
  checkedRangeMin = null,
  checkedRangeMax = null,
  initialActiveBinId = null,
  attempt = 1,
  refetchStatesFn = null,
  getActiveBinFn = null,
  ensureFinalRentCheckedDeployArgsFn = ensureFinalRentCheckedDeployArgs,
  assertDlmmFinalSdkArgsFn = assertDlmmFinalSdkArgs,
  buildDlmmSdkStrategyFromDeployArgsFn = buildDlmmSdkStrategyFromDeployArgs,
  skipActiveBinRefresh = false,
  anchorMetadata = null,
} = {}) {
  let refreshedActiveBinId = Number(deployArgs?.activeBinId);
  let activeRefreshReason = null;

  if (!skipActiveBinRefresh) {
    try {
      if (typeof refetchStatesFn === 'function') {
        await refetchStatesFn();
      } else if (dlmmPool?.refetchStates) {
        await dlmmPool.refetchStates();
      }
      const refreshedActiveBin = typeof getActiveBinFn === 'function'
        ? await getActiveBinFn()
        : (dlmmPool?.getActiveBin ? await dlmmPool.getActiveBin() : null);
      if (isFiniteInteger(Number(refreshedActiveBin?.binId))) {
        refreshedActiveBinId = Number(refreshedActiveBin.binId);
        if (refreshedActiveBinId !== Number(initialActiveBinId)) {
          activeRefreshReason = 'active_bin_moved_before_final_args';
          console.log(
            `[evilPanda] ACTIVE_BIN_REFRESH pool=${poolAddress.slice(0,8)} ` +
            `initial=${Number(initialActiveBinId)} refreshed=${refreshedActiveBinId} attempt=${attempt}`
          );
        }
      }
    } catch (refreshErr) {
      console.warn(`[evilPanda] ACTIVE_BIN_REFRESH_FAIL pool=${poolAddress.slice(0,8)} reason=${refreshErr?.message || 'unknown'} attempt=${attempt}`);
    }
  } else {
    refreshedActiveBinId = Number(deployArgs?.activeBinId);
    activeRefreshReason = 'frozen_entry_intent';
  }

  const beforeRefreshRangeMin = Number(deployArgs.rangeMin);
  const beforeRefreshRangeMax = Number(deployArgs.rangeMax);
  let finalDeployArgs = rebuildDeployArgsWithRefreshedActiveBin({
    deployArgs,
    refreshedActiveBinId,
  });
  const refreshedRangeChanged =
    Number(finalDeployArgs.rangeMin) !== beforeRefreshRangeMin ||
    Number(finalDeployArgs.rangeMax) !== beforeRefreshRangeMax;
  if (refreshedRangeChanged && !finalDeployArgs.adjustmentReason) {
    finalDeployArgs.adjustmentReason = activeRefreshReason || 'active_bin_refresh_rebuild';
  } else if (!finalDeployArgs.adjustmentReason && activeRefreshReason) {
    finalDeployArgs.adjustmentReason = activeRefreshReason;
  }

  let finalRentGuard = currentRentGuard || { ok: true, deployArgs: finalDeployArgs, finalRangeChanged: false, guard: 'SKIP_PRECHECK' };
  if (hasNonRefundableFees && refreshedRangeChanged) {
    finalRentGuard = await ensureFinalRentCheckedDeployArgsFn({
      hasNonRefundableFees,
      connection,
      poolPubkey,
      poolAddress,
      tokenXMint: xMint,
      symbol: poolAddress.slice(0, 8),
      activeBinId: refreshedActiveBinId,
      rangeMaxBins,
      checkedRangeMin,
      checkedRangeMax,
      deployArgs: finalDeployArgs,
    });
    if (!finalRentGuard.ok) {
      return {
        ...finalRentGuard,
        attempt,
        refreshedActiveBinId,
        initialActiveBinId,
        deployArgs: finalDeployArgs,
        currentRentGuard,
      };
    }
    finalDeployArgs = finalRentGuard.deployArgs;
  }

  const safeRangeMin = Number(finalDeployArgs.rangeMin);
  const safeRangeMax = Number(finalDeployArgs.rangeMax);
  const finalTotalBins = safeRangeMax - safeRangeMin + 1;
  const sdkStrategy = buildDlmmSdkStrategyFromDeployArgsFn(finalDeployArgs);
  const finalArgsContext = assertDlmmFinalSdkArgsFn({
    deployArgs: finalDeployArgs,
    sdkStrategy,
    xMint,
    yMint,
    poolAddress,
    initialActiveBinId: Number(initialActiveBinId),
    refreshedActiveBinId,
    anchorSource: anchorMetadata?.anchorSource || null,
    anchorActiveBinId: anchorMetadata?.anchorActiveBinId ?? null,
    anchorPrice: anchorMetadata?.anchorPrice ?? null,
    anchorSnapshotAt: anchorMetadata?.anchorSnapshotAt ?? null,
    anchorDriftBins: anchorMetadata?.anchorDriftBins ?? null,
    anchorDriftPct: anchorMetadata?.anchorDriftPct ?? null,
    anchorReason: anchorMetadata?.anchorReason || null,
    rangeAdjustReason: finalDeployArgs.adjustmentReason || anchorMetadata?.rangeAdjustReason || null,
  });

  if (finalDeployArgs.adjustedBelowActive || finalDeployArgs.adjustedAboveActive) {
    console.warn(
      `[evilPanda] DLMM_RANGE_ADJUST_SINGLE_SIDE pool=${poolAddress.slice(0,8)} ` +
      `active=${finalDeployArgs.activeBinId} original=[${beforeRefreshRangeMin},${beforeRefreshRangeMax}] adjusted=[${safeRangeMin},${safeRangeMax}] reason=${finalDeployArgs.adjustmentReason || 'none'} attempt=${attempt}`
    );
  }

  console.log(
    `[evilPanda] DLMM_PRECHECK_OK pool=${poolAddress} active=${finalDeployArgs.activeBinId} ` +
    `range=[${safeRangeMin},${safeRangeMax}] amountX=${finalDeployArgs.amountXBn.toString()} amountY=${finalDeployArgs.amountYBn.toString()} ` +
    `strategyType=${finalDeployArgs.strategyType} anchor=${finalArgsContext.anchorSource || 'unknown'} ` +
    `rangeAdjust=${finalArgsContext.rangeAdjustReason || 'none'} attempt=${attempt}`
  );
  console.log(
    `[evilPanda] FINAL_SDK_RANGE pool=${poolAddress.slice(0,8)} ` +
    `rentGuard=${finalRentGuard.guard || 'UNKNOWN'} checked=[${checkedRangeMin},${checkedRangeMax}] ` +
    `strategy=[${sdkStrategy.minBinId},${sdkStrategy.maxBinId}] ` +
    `anchor=${finalArgsContext.anchorSource || 'unknown'} anchorBin=${finalArgsContext.anchorActiveBinId ?? 'na'} ` +
    `rangeAdjust=${finalArgsContext.rangeAdjustReason || 'none'} attempt=${attempt}`
  );
  console.log(
    `[evilPanda] bins=${finalTotalBins} range=[${safeRangeMin},${safeRangeMax}] attempt=${attempt}`
  );

  return {
    ok: true,
    attempt,
    deployArgs: finalDeployArgs,
    sdkStrategy,
    finalArgsContext,
    finalRentGuard,
    refreshedActiveBinId,
    initialActiveBinId: Number(initialActiveBinId),
    finalTotalBins,
    currentRentGuard: finalRentGuard,
  };
}

export async function executeDlmmInitializePositionWithRetry({
  initialState = null,
  buildRetryStateFn = async ({ previousState }) => previousState,
  sdkCallFn = async () => { throw new Error('sdkCallFn not provided'); },
  wrapInvalidArgsFn = wrapDlmmSdkInvalidArgumentsError,
} = {}) {
  const firstState = initialState || {};
  try {
    const txOrTxs = await sdkCallFn(firstState);
    return { txOrTxs, state: firstState, attempt: 1 };
  } catch (firstErr) {
    if (firstErr?.isPermanent) {
      throw firstErr;
    }
    if (!isDlmmSdkInvalidArgumentsError(firstErr)) {
      throw firstErr;
    }

    const retryState = await buildRetryStateFn({
      previousState: firstState,
      firstError: firstErr,
      attempt: 2,
    });

    try {
      const txOrTxs = await sdkCallFn(retryState);
      return { txOrTxs, state: retryState, attempt: 2 };
    } catch (retryErr) {
      if (retryErr?.isPermanent) {
        throw retryErr;
      }
      if (!isDlmmSdkInvalidArgumentsError(retryErr)) {
        throw retryErr;
      }
      throw wrapInvalidArgsFn({
        error: retryErr,
        finalArgsContext: {
          ...(retryState?.finalArgsContext || {}),
          attempt: 2,
          retryAttempt: 1,
        },
      });
    }
  }
}

export function assertDlmmFinalSdkArgs({
  deployArgs = {},
  sdkStrategy = null,
  xMint = '',
  yMint = '',
  poolAddress = '',
  initialActiveBinId = null,
  refreshedActiveBinId = null,
  anchorSource = null,
  anchorActiveBinId = null,
  anchorPrice = null,
  anchorSnapshotAt = null,
  anchorDriftBins = null,
  anchorDriftPct = null,
  anchorReason = null,
  rangeAdjustReason = null,
} = {}) {
  const activeBinId = Number(deployArgs?.activeBinId);
  const rangeMin = Number(deployArgs?.rangeMin);
  const rangeMax = Number(deployArgs?.rangeMax);
  const strategyMin = Number(sdkStrategy?.minBinId);
  const strategyMax = Number(sdkStrategy?.maxBinId);
  const strategyType = Number(sdkStrategy?.strategyType ?? deployArgs?.strategyType);
  const amountX = toBnAmountStrict(deployArgs?.amountXBn, 'amountX');
  const amountY = toBnAmountStrict(deployArgs?.amountYBn, 'amountY');

  if (!isFiniteInteger(activeBinId)) {
    throw buildInvalidDlmmArgsError(`activeBinId must be finite integer (got ${String(deployArgs?.activeBinId)})`);
  }
  if (!isFiniteInteger(rangeMin) || !isFiniteInteger(rangeMax)) {
    throw buildInvalidDlmmArgsError(`rangeMin/rangeMax must be finite integers (got ${String(deployArgs?.rangeMin)}/${String(deployArgs?.rangeMax)})`);
  }
  if (rangeMin > rangeMax) {
    throw buildInvalidDlmmArgsError(`rangeMin must be <= rangeMax (got ${rangeMin} > ${rangeMax})`);
  }
  if (amountX.isNeg() || amountY.isNeg()) {
    throw buildInvalidDlmmArgsError('amountX/amountY must be >= 0');
  }
  if (amountX.add(amountY).isZero()) {
    throw buildInvalidDlmmArgsError('amountX + amountY must be > 0');
  }
  if (!isFiniteInteger(strategyType) || strategyType < 0) {
    throw buildInvalidDlmmArgsError(`strategyType invalid (got ${String(strategyType)})`);
  }
  if (!isFiniteInteger(strategyMin) || !isFiniteInteger(strategyMax)) {
    throw buildInvalidDlmmArgsError(`strategy min/max bin invalid (got ${String(sdkStrategy?.minBinId)}/${String(sdkStrategy?.maxBinId)})`);
  }
  if (strategyMin !== rangeMin || strategyMax !== rangeMax) {
    throw buildInvalidDlmmArgsError(`strategy range mismatch deployArgs [${rangeMin},${rangeMax}] vs sdk [${strategyMin},${strategyMax}]`);
  }
  if (!xMint || !yMint) {
    throw buildInvalidDlmmArgsError('tokenX/tokenY mint is missing');
  }

  const sideInvariant = enforceDlmmSideRangeInvariants({
    activeBinId,
    rangeMin,
    rangeMax,
    amountX,
    amountY,
  });
  if (sideInvariant.rangeMin !== rangeMin || sideInvariant.rangeMax !== rangeMax) {
    throw buildInvalidDlmmArgsError(
      `range violates final side invariant and needs adjustment [${rangeMin},${rangeMax}] -> [${sideInvariant.rangeMin},${sideInvariant.rangeMax}]`
    );
  }

  const debug = buildDlmmFinalArgsContext({
    poolAddress,
    xMint,
    yMint,
    deployArgs: { ...deployArgs, amountXBn: amountX, amountYBn: amountY },
    sdkStrategy,
    initialActiveBinId,
    refreshedActiveBinId,
    anchorSource,
    anchorActiveBinId,
    anchorPrice,
    anchorSnapshotAt,
    anchorDriftBins,
    anchorDriftPct,
    anchorReason,
    rangeAdjustReason,
  });
  console.log(
    `[DLMM_FINAL_ARGS] pool=${debug.pool} tokenXMint=${debug.tokenXMint} tokenYMint=${debug.tokenYMint} ` +
    `activeBinId=${debug.activeBinId} initialActiveBinId=${debug.initialActiveBinId ?? 'na'} refreshedActiveBinId=${debug.refreshedActiveBinId ?? 'na'} ` +
    `range=[${debug.rangeMin},${debug.rangeMax}] width=${debug.rangeWidth} ` +
    `amountX=${debug.amountX} amountY=${debug.amountY} amountXIsZero=${debug.amountXIsZero} amountYIsZero=${debug.amountYIsZero} ` +
    `strategyType=${debug.strategyType} side=${debug.singleSide} quoteSide=${debug.quoteSide} activeInside=${debug.activeInsideRange} ` +
    `anchor=${debug.anchorSource || 'unknown'} anchorBin=${debug.anchorActiveBinId ?? 'na'} ` +
    `rangeAdjust=${debug.rangeAdjustReason || 'none'} reason=${debug.adjustedReason || 'none'}`
  );
  return debug;
}

async function withPermanentAwareBackoff(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 10000 } = {}) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.isPermanent || e?.code === 'INVALID_DLMM_DEPLOY_ARGS') {
        throw e;
      }
      lastError = e;
      if (i < maxRetries - 1) {
        const delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
        const jitter = Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay + jitter));
      }
    }
  }
  throw lastError;
}

function buildPermanentExitError(message, code = 'EXIT_PERMANENT_ERROR') {
  const err = new Error(message);
  err.code = code;
  err.isPermanent = true;
  return err;
}

export function buildDlmmDeployStrategyArgs({
  activeBinId,
  rangeMin,
  rangeMax,
  amountXBn,
  amountYBn,
  strategyType = SPOT_STRATEGY_TYPE,
} = {}) {
  if (!isFiniteInteger(activeBinId)) {
    throw buildInvalidDlmmArgsError(`activeBin.binId must be finite integer (got ${String(activeBinId)})`);
  }
  if (!isFiniteInteger(rangeMin) || !isFiniteInteger(rangeMax)) {
    throw buildInvalidDlmmArgsError(`rangeMin/rangeMax must be finite integers (got ${String(rangeMin)}/${String(rangeMax)})`);
  }
  if (rangeMin > rangeMax) {
    throw buildInvalidDlmmArgsError(`rangeMin must be <= rangeMax (got ${rangeMin} > ${rangeMax})`);
  }

  const amountX = toBnAmountStrict(amountXBn, 'amountX');
  const amountY = toBnAmountStrict(amountYBn, 'amountY');
  if (amountX.isNeg() || amountY.isNeg()) {
    throw buildInvalidDlmmArgsError('amountX/amountY must be >= 0');
  }
  if (amountX.add(amountY).isZero()) {
    throw buildInvalidDlmmArgsError('amountX + amountY must be > 0');
  }

  const sideInvariant = enforceDlmmSideRangeInvariants({
    activeBinId,
    rangeMin,
    rangeMax,
    amountX,
    amountY,
  });
  const safeMin = sideInvariant.rangeMin;
  const safeMax = sideInvariant.rangeMax;

  return {
    activeBinId,
    rangeMin: safeMin,
    rangeMax: safeMax,
    amountXBn: amountX,
    amountYBn: amountY,
    strategyType: (Number.isFinite(Number(strategyType)) && Number(strategyType) >= 0) ? Number(strategyType) : SPOT_STRATEGY_TYPE,
    adjustedBelowActive: sideInvariant.adjustedBelowActive,
    adjustedAboveActive: sideInvariant.adjustedAboveActive,
    adjustmentReason: sideInvariant.adjustmentReason,
    singleSide: sideInvariant.side,
  };
}

export function buildDlmmSdkStrategyFromDeployArgs(deployArgs = {}) {
  return {
    maxBinId: Number(deployArgs.rangeMax),
    minBinId: Number(deployArgs.rangeMin),
    strategyType: Number.isFinite(Number(deployArgs.strategyType))
      ? Number(deployArgs.strategyType)
      : SPOT_STRATEGY_TYPE,
  };
}

export function deriveSpotBidAskSeedPlan({
  cfg = {},
  activeBinId,
  rangeMin,
  rangeMax,
  totalLamports = 0,
} = {}) {
  const rangeIncludesActiveBin =
    isFiniteInteger(activeBinId) &&
    isFiniteInteger(rangeMin) &&
    isFiniteInteger(rangeMax) &&
    rangeMin <= activeBinId &&
    rangeMax >= activeBinId;

  const spotBidAskSeedEnabled = isExplicitConfigTrue(cfg?.spotBidAskSeedEnabled);
  const shouldSeedTokenX = spotBidAskSeedEnabled && rangeIncludesActiveBin;
  const rangeWidth = Math.max(1, Number(rangeMax) - Number(rangeMin));
  const activeRatio = shouldSeedTokenX
    ? Math.max(0, Math.min(1, (Number(activeBinId) - Number(rangeMin)) / rangeWidth))
    : 0;
  const seedPctOverride = Number(cfg?.deployTokenXSeedPct || cfg?.deployXSeedPct || 0);
  const defaultSeedPct = shouldSeedTokenX
    ? Math.max(10, Math.min(40, Math.round(40 - (activeRatio * 30))))
    : 0;
  const seedPct = Number.isFinite(seedPctOverride) && seedPctOverride > 0
    ? Math.max(1, Math.min(60, seedPctOverride))
    : defaultSeedPct;
  const safeTotalLamports = Math.max(0, Number(totalLamports) || 0);
  const seedLamports = Math.max(0, Math.floor(safeTotalLamports * (seedPct / 100)));

  return {
    spotBidAskSeedEnabled,
    shouldSeedTokenX,
    rangeIncludesActiveBin,
    seedPct,
    seedLamports,
    activeRatio,
  };
}

export function getDlmmLiquidityShapeFromConfig(cfg = {}) {
  return normalizeDlmmLiquidityShape(cfg?.dlmmLiquidityShape);
}

export function selectDlmmSdkPathForDeployArgs(deployArgs = {}) {
  const amountX = toBnAmountSafe(deployArgs?.amountXBn);
  const amountY = toBnAmountSafe(deployArgs?.amountYBn);
  const activeBinId = Number(deployArgs?.activeBinId);
  const rangeMax = Number(deployArgs?.rangeMax);
  const side = classifyDlmmLiquiditySide(amountX, amountY);
  const isStrictQuoteOnly =
    side === 'QUOTE_ONLY' &&
    isFiniteInteger(activeBinId) &&
    isFiniteInteger(rangeMax) &&
    rangeMax <= activeBinId;
  return isStrictQuoteOnly
    ? DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY
    : DLMM_SDK_PATH_STRATEGY;
}

export function buildQuoteOnlyWeightDistribution({
  rangeMin,
  rangeMax,
} = {}) {
  if (!isFiniteInteger(rangeMin) || !isFiniteInteger(rangeMax)) {
    throw buildInvalidDlmmArgsError(`quote-only weight range must be finite integers (got ${String(rangeMin)}/${String(rangeMax)})`);
  }
  if (rangeMin > rangeMax) {
    throw buildInvalidDlmmArgsError(`quote-only weight range invalid (min ${rangeMin} > max ${rangeMax})`);
  }
  const totalBins = rangeMax - rangeMin + 1;
  if (!isFiniteInteger(totalBins) || totalBins <= 0) {
    throw buildInvalidDlmmArgsError(`quote-only weight total bins invalid (${String(totalBins)})`);
  }

  const TOTAL_BPS = 10_000;
  const baseYBps = Math.floor(TOTAL_BPS / totalBins);
  const remainder = TOTAL_BPS - (baseYBps * totalBins);
  const distribution = [];

  for (let i = 0; i < totalBins; i++) {
    const binId = rangeMin + i;
    const yBps = i === (totalBins - 1)
      ? (baseYBps + remainder)
      : baseYBps;
    distribution.push({
      binId,
      xAmountBpsOfTotal: new BN('0'),
      yAmountBpsOfTotal: new BN(String(yBps)),
    });
  }

  const totalYBps = distribution.reduce((acc, item) => acc.add(item.yAmountBpsOfTotal), new BN('0'));
  if (totalYBps.lte(new BN('0'))) {
    throw buildInvalidDlmmArgsError('quote-only weight distribution must have positive Y allocation');
  }
  return distribution;
}

export function assertNoCombinedWeightForQuoteOnly({
  deployArgs = {},
  sdkPath = '',
  sdkMethod = '',
} = {}) {
  const path = String(sdkPath || '');
  const method = String(sdkMethod || '');
  const side = classifyDlmmLiquiditySide(
    toBnAmountSafe(deployArgs?.amountXBn),
    toBnAmountSafe(deployArgs?.amountYBn),
  );
  if (path === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY && side === 'QUOTE_ONLY' && method === 'initializePositionAndAddLiquidityByWeight') {
    throw buildInvalidDlmmArgsError('quote-only path must not call initializePositionAndAddLiquidityByWeight; use position-first flow');
  }
}

export function buildQuoteOnlyDryRunPlan({
  poolAddress = '',
  deployArgs = {},
  xYAmountDistribution = [],
  finalArgsContext = {},
} = {}) {
  const rangeMin = Number(deployArgs?.rangeMin);
  const rangeMax = Number(deployArgs?.rangeMax);
  const amountY = toBnAmountSafe(deployArgs?.amountYBn).toString();
  const bins = Array.isArray(xYAmountDistribution) ? xYAmountDistribution.length : 0;
  console.log(
    `[evilPanda] DLMM_QUOTE_ONLY_DRY_RUN_PLAN pool=${String(poolAddress || '').slice(0,8)} ` +
    `range=[${rangeMin},${rangeMax}] amountY=${amountY} bins=${bins}`
  );
  return {
    quoteOnlyDryRunPlan: true,
    sdkPath: DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY,
    sdkFlow: 'quote_only_dry_run_plan',
    sdkMethod: 'dryRunPlan',
    rangeMin: Number.isFinite(rangeMin) ? rangeMin : null,
    rangeMax: Number.isFinite(rangeMax) ? rangeMax : null,
    amountY,
    bins,
    context: {
      ...finalArgsContext,
      sdkPath: DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY,
      sdkFlow: 'quote_only_dry_run_plan',
      sdkMethod: 'dryRunPlan',
    },
  };
}

async function ensurePositionOwnerPrecheck({
  connection,
  positionPubKey,
  expectedProgramId,
  context = {},
} = {}) {
  if (!connection || !positionPubKey || !expectedProgramId) return;
  const accountInfo = await connection.getAccountInfo(positionPubKey).catch(() => null);
  if (!accountInfo) return;
  const owner = String(accountInfo?.owner?.toString?.() || '');
  const expected = String(expectedProgramId?.toString?.() || '');
  if (!owner || !expected || owner === expected) return;
  const err = buildInvalidDlmmArgsError(
    `position account owner mismatch before quote-only add liquidity: owner=${owner} expected=${expected}`
  );
  err.dlmmContextExtra = {
    ...context,
    positionOwner: owner,
    expectedPositionOwner: expected,
  };
  throw err;
}

export async function executeQuoteOnlyPositionFirstFlow({
  dlmmPool,
  connection,
  walletPublicKey,
  positionKeypair,
  deployArgs = {},
  xYAmountDistribution = [],
  slippagePct = 0,
  microLamports = EP_CONFIG.MICRO_LAMPORTS,
  finalArgsContext = {},
  sendTxFn = null,
  pollTxConfirmFn = pollTxConfirm,
  sendAddLiquidityTxFn = null,
  isDryRunMode = false,
} = {}) {
  if (!dlmmPool || !connection || !walletPublicKey || !positionKeypair) {
    throw buildInvalidDlmmArgsError('quote-only position-first flow missing required dependencies');
  }
  const positionPubKey = positionKeypair.publicKey;
  const positionPubkey = positionPubKey.toString();
  const expectedPositionOwner = String(dlmmPool?.program?.programId?.toString?.() || '');
  let addLiquidityAttempted = false;

  const existingAccInfo = await connection.getAccountInfo(positionPubKey).catch(() => null);
  const existingOwner = String(existingAccInfo?.owner?.toString?.() || '');
  if (existingAccInfo && expectedPositionOwner && existingOwner !== expectedPositionOwner) {
    const err = buildInvalidDlmmArgsError(
      `position account owner mismatch before quote-only deploy: owner=${existingOwner} expected=${expectedPositionOwner}`
    );
    err.dlmmContextExtra = {
      ...finalArgsContext,
      positionPubkey,
      positionOwner: existingOwner || null,
      expectedPositionOwner: expectedPositionOwner || null,
      sdkFlow: 'quote_only_position_first',
      sdkMethod: 'positionOwnerCheck',
    };
    throw err;
  }

  let initSig = null;
  if (!existingAccInfo) {
    upsertQuoteOnlyDeployMarker({
      positionPubkey,
      poolAddress: finalArgsContext?.pool || '',
      tokenXMint: finalArgsContext?.tokenXMint || '',
      phase: PHASE_POSITION_INIT_PENDING,
      source: BOT_QUOTE_ONLY_DEPLOY_SOURCE,
      ttlMs: QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      liquidityConfirmed: false,
    });
    let initTx;
    try {
      initTx = await dlmmPool.createEmptyPosition({
        positionPubKey,
        minBinId: Number(deployArgs.rangeMin),
        maxBinId: Number(deployArgs.rangeMax),
        user: walletPublicKey,
      });
    } catch (initErr) {
      if (initErr && typeof initErr === 'object') {
        initErr.dlmmContextExtra = {
          ...(initErr.dlmmContextExtra || {}),
          ...finalArgsContext,
          positionPubkey,
          expectedPositionOwner: expectedPositionOwner || null,
          sdkFlow: 'quote_only_position_first',
          sdkMethod: 'createEmptyPosition',
        };
      }
      throw initErr;
    }
    injectPriorityFee(initTx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
    const sendTx = typeof sendTxFn === 'function'
      ? sendTxFn
      : async (tx) => sendQuoteOnlyTxWithFilteredSigners({
        connection,
        wallet: getWallet(),
        tx,
        extraSigners: [positionKeypair],
        txStage: 'createPosition',
        finalArgsContext,
      });
    initSig = await sendTx(initTx, [positionKeypair]);
    if (typeof pollTxConfirmFn === 'function') {
      await pollTxConfirmFn(connection, initSig);
    }
    upsertQuoteOnlyDeployMarker({
      positionPubkey,
      poolAddress: finalArgsContext?.pool || '',
      tokenXMint: finalArgsContext?.tokenXMint || '',
      phase: PHASE_POSITION_INIT_CONFIRMED,
      source: BOT_QUOTE_ONLY_DEPLOY_SOURCE,
      ttlMs: QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      liquidityConfirmed: false,
    });
    console.log(
      `[evilPanda] QUOTE_ONLY_POSITION_INIT_CONFIRMED pool=${String(finalArgsContext?.pool || '').slice(0,8)} ` +
      `position=${positionPubkey.slice(0,8)}`
    );
  }

  const postInitAccInfo = await connection.getAccountInfo(positionPubKey).catch(() => null);
  const postInitOwner = String(postInitAccInfo?.owner?.toString?.() || '');
  if (!postInitAccInfo || (expectedPositionOwner && postInitOwner !== expectedPositionOwner)) {
    const err = buildInvalidDlmmArgsError(
      `position account not owned by DLMM program before one-side add: owner=${postInitOwner || 'unknown'} expected=${expectedPositionOwner || 'unknown'}`
    );
    err.dlmmContextExtra = {
      ...finalArgsContext,
      positionPubkey,
      positionOwner: postInitOwner || null,
      expectedPositionOwner: expectedPositionOwner || null,
      sdkFlow: 'quote_only_position_first',
      sdkMethod: 'positionOwnerCheck',
    };
    throw err;
  }
  let addTxOrTxs;
  try {
    addLiquidityAttempted = true;
    upsertQuoteOnlyDeployMarker({
      positionPubkey,
      poolAddress: finalArgsContext?.pool || '',
      tokenXMint: finalArgsContext?.tokenXMint || '',
      phase: PHASE_ADD_LIQUIDITY_PENDING,
      source: BOT_QUOTE_ONLY_DEPLOY_SOURCE,
      ttlMs: QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      liquidityConfirmed: false,
    });
    addTxOrTxs = await dlmmPool.addLiquidityByWeight({
      positionPubKey,
      user: walletPublicKey,
      totalXAmount: deployArgs.amountXBn,
      totalYAmount: deployArgs.amountYBn,
      xYAmountDistribution,
      slippage: slippagePct,
    });
    if (isDryRunMode) {
      const txList = Array.isArray(addTxOrTxs) ? addTxOrTxs : [addTxOrTxs];
      for (const tx of txList) {
        if (!tx) continue;
        injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
        if (typeof sendAddLiquidityTxFn === 'function') {
          await sendAddLiquidityTxFn(tx, [positionKeypair], {
            txStage: 'addLiquidity',
            finalArgsContext,
            positionPubkey,
          });
        } else {
          const signerList = filterKnownTransactionSigners(tx, [positionKeypair], { txStage: 'addLiquidity' });
          try {
            if (tx instanceof VersionedTransaction) {
              tx.sign([getWallet(), ...signerList]);
            } else {
              tx.sign(...signerList, getWallet());
            }
          } catch (dryErr) {
            throw wrapQuoteOnlySignerError({
              error: dryErr,
              finalArgsContext,
              txStage: 'addLiquidity',
              attemptedSigner: positionPubkey,
            });
          }
        }
      }
    }
  } catch (addErr) {
    upsertQuoteOnlyDeployMarker({
      positionPubkey,
      poolAddress: finalArgsContext?.pool || '',
      tokenXMint: finalArgsContext?.tokenXMint || '',
      phase: PHASE_ADD_LIQUIDITY_FAILED,
      source: BOT_QUOTE_ONLY_DEPLOY_SOURCE,
      ttlMs: QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      liquidityConfirmed: false,
      extra: {
        addLiquidityFailedAt: Date.now(),
        addLiquidityError: String(addErr?.message || 'unknown'),
      },
    });
    console.warn(
      `[evilPanda] QUOTE_ONLY_ADD_LIQUIDITY_FAILED pool=${String(finalArgsContext?.pool || '').slice(0,8)} ` +
      `position=${positionPubkey.slice(0,8)} reason=${String(addErr?.message || 'unknown')}`
    );
    if (isAccountNotInitializedDlmmError(addErr)) {
      const wrapped = buildInvalidDlmmArgsError(
        `quote-only addLiquidity prerequisite failed: user token account not initialized ` +
        `context=${JSON.stringify({
          ...(finalArgsContext || {}),
          positionPubkey,
          sdkFlow: 'quote_only_position_first',
          sdkMethod: 'addLiquidityByWeight',
          anchorErrorCode: 3012,
          anchorErrorHex: '0xbc4',
          anchorErrorName: 'AccountNotInitialized',
        })}`
      );
      wrapped.code = 'INVALID_DLMM_DEPLOY_ARGS';
      wrapped.isPermanent = true;
      wrapped.dlmmContextExtra = {
        ...(addErr?.dlmmContextExtra || {}),
        ...(finalArgsContext || {}),
        positionPubkey,
        sdkFlow: 'quote_only_position_first',
        sdkMethod: 'addLiquidityByWeight',
        anchorErrorCode: 3012,
        anchorErrorHex: '0xbc4',
        anchorErrorName: 'AccountNotInitialized',
      };
      throw wrapped;
    }
    if (addErr && typeof addErr === 'object') {
      addErr.dlmmContextExtra = {
        ...(addErr.dlmmContextExtra || {}),
        ...finalArgsContext,
        positionPubkey,
        positionOwner: postInitOwner || null,
        expectedPositionOwner: expectedPositionOwner || null,
        sdkFlow: 'quote_only_position_first',
        sdkMethod: 'addLiquidityByWeight',
      };
    }
    throw addErr;
  }

  return {
    quoteOnlyPositionFirst: true,
    sdkFlow: 'quote_only_position_first',
    initSig,
    addTxOrTxs,
    positionPubkey,
    positionOwner: postInitOwner || null,
    expectedPositionOwner: expectedPositionOwner || null,
    addLiquidityAttempted,
  };
}

function isRentRequiredError(error) {
  return String(error?.message || '').startsWith('BIN_ARRAY_RENT_REQUIRED');
}

function buildRentVetoResult({
  poolAddress = '',
  tokenXMint = '',
  symbol = '',
  detail = '',
  rangeMin = 0,
  rangeMax = 0,
  rangeMaxBins = 0,
  source = 'DEPLOY_RENT_GUARD_FINAL',
} = {}) {
  const rentMemory = recordPoolRentFailure({
    pool: { tokenXMint, address: poolAddress },
    tokenMint: tokenXMint,
    poolAddress,
    symbol: symbol || poolAddress.slice(0, 8),
    detail,
    rangeMin,
    rangeMax,
    snapshot: {
      taTrend: 'UNKNOWN',
      priceChangeM5: 0,
      entryReadiness: 'HIGH',
      breakoutQuality: 'VALID',
      entryTimingState: 'LP_LIVE',
    },
    source,
  });
  const rentCooldownUntil = Number(rentMemory?.rentCooldownUntil || 0);
  return {
    blocked: true,
    reason: 'VETO_NON_REFUNDABLE_RENT',
    detail,
    rangeMin,
    rangeMax,
    rangeMaxBins,
    cooldownUntil: rentCooldownUntil,
    cooldownMs: rentCooldownUntil > Date.now()
      ? Math.max(0, rentCooldownUntil - Date.now())
      : 0,
  };
}

export async function ensureFinalRentCheckedDeployArgs({
  hasNonRefundableFees = false,
  connection,
  poolPubkey,
  poolAddress = '',
  tokenXMint = '',
  symbol = '',
  activeBinId = 0,
  rangeMaxBins = 0,
  checkedRangeMin = null,
  checkedRangeMax = null,
  deployArgs = null,
  assertRangeFn = assertRangeDoesNotRequireBinArrayInit,
  findAdaptiveFn = findAdaptiveRentFreeRange,
} = {}) {
  if (!hasNonRefundableFees) {
    return { ok: true, deployArgs, finalRangeChanged: false, guard: 'SKIP_NON_REFUNDABLE_FALSE' };
  }

  const safeMin = Number(deployArgs?.rangeMin);
  const safeMax = Number(deployArgs?.rangeMax);
  const hasCheckedRange =
    Number.isFinite(Number(checkedRangeMin)) &&
    Number.isFinite(Number(checkedRangeMax));
  const finalRangeChanged =
    hasCheckedRange &&
    (safeMin !== Number(checkedRangeMin) || safeMax !== Number(checkedRangeMax));

  console.log(
    `[evilPanda] FINAL_RENT_GUARD pool=${poolAddress.slice(0,8)} ` +
    `checked=[${checkedRangeMin},${checkedRangeMax}] preflight=[${safeMin},${safeMax}] changed=${finalRangeChanged}`
  );

  if (hasCheckedRange && !finalRangeChanged) {
    console.log(`[evilPanda] FINAL_RENT_GUARD_PASS pool=${poolAddress.slice(0,8)} reason=unchanged_range`);
    return { ok: true, deployArgs, finalRangeChanged, guard: 'UNCHANGED_RANGE_PASS' };
  }

  try {
    await assertRangeFn(connection, poolPubkey, safeMin, safeMax);
    console.log(`[evilPanda] FINAL_RENT_GUARD_PASS pool=${poolAddress.slice(0,8)} range=[${safeMin},${safeMax}]`);
    return { ok: true, deployArgs, finalRangeChanged, guard: 'ASSERT_PASS' };
  } catch (e) {
    if (!isRentRequiredError(e)) throw e;
    const detail = e.message;
    console.warn(`[evilPanda] FINAL_RENT_GUARD_UNSAFE pool=${poolAddress.slice(0,8)} range=[${safeMin},${safeMax}] ${detail}`);

    const adaptive = await findAdaptiveFn({
      connection,
      poolPubkey,
      desiredMin: safeMin,
      desiredMax: safeMax,
      maxBins: rangeMaxBins,
      initialStatus: null,
    });
    const adjusted = adaptive?.adjusted || null;
    if (!adjusted) {
      return {
        ok: false,
        ...buildRentVetoResult({
          poolAddress,
          tokenXMint,
          symbol,
          detail,
          rangeMin: safeMin,
          rangeMax: safeMax,
          rangeMaxBins,
          source: 'DEPLOY_RENT_GUARD_FINAL',
        }),
      };
    }

    console.warn(
      `[evilPanda] FINAL_RENT_GUARD_ADJUST pool=${poolAddress.slice(0,8)} ` +
      `unsafe=[${safeMin},${safeMax}] adjusted=[${adjusted.rangeMin},${adjusted.rangeMax}]`
    );

    const rebuilt = buildDlmmDeployStrategyArgs({
      activeBinId: Number(activeBinId),
      rangeMin: Number(adjusted.rangeMin),
      rangeMax: Number(adjusted.rangeMax),
      amountXBn: deployArgs.amountXBn,
      amountYBn: deployArgs.amountYBn,
      strategyType: deployArgs.strategyType,
    });
    rebuilt.adjustmentReason = 'rent_guard_final_adjust';

    try {
      await assertRangeFn(connection, poolPubkey, Number(rebuilt.rangeMin), Number(rebuilt.rangeMax));
      console.log(
        `[evilPanda] FINAL_RENT_GUARD_PASS pool=${poolAddress.slice(0,8)} ` +
        `range=[${Number(rebuilt.rangeMin)},${Number(rebuilt.rangeMax)}] reason=adjusted_recheck_ok`
      );
    } catch (finalErr) {
      if (!isRentRequiredError(finalErr)) throw finalErr;
      return {
        ok: false,
        ...buildRentVetoResult({
          poolAddress,
          tokenXMint,
          symbol,
          detail: finalErr.message,
          rangeMin: Number(rebuilt.rangeMin),
          rangeMax: Number(rebuilt.rangeMax),
          rangeMaxBins,
          source: 'DEPLOY_RENT_GUARD_FINAL_RECHECK',
        }),
      };
    }

    return { ok: true, deployArgs: rebuilt, finalRangeChanged: true, guard: 'ADJUSTED_PASS' };
  }
}

async function resolveNonRefundableFeeFlag(poolAddress, explicitFlag = null) {
  if (explicitFlag === true) return true;
  if (explicitFlag === false) return false;

  try {
    const poolData = await getDLMMPoolData(poolAddress);
    return Boolean(poolData?.hasNonRefundableFees);
  } catch {
    return false;
  }
}

export function setEvilPandaNotifyFn(fn) {
  _notifyFn = typeof fn === 'function' ? fn : null;
}

async function notify(msg) {
  if (!_notifyFn) return;
  await _notifyFn(msg).catch(() => {});
}

export async function calculateFeeOnlyPnl({
  feeXRaw = '0',
  feeYRaw = '0',
  xDec = 9,
  yDec = 9,
  tokenXMint = '',
  deploySol = 0,
  activeBinPrice = 0,
  quoteFn = getJupiterQuote,
} = {}) {
  const feeXRawStr = String(feeXRaw || '0');
  const safeXDec = Number.isFinite(Number(xDec)) ? Number(xDec) : 9;
  const safeYDec = Number.isFinite(Number(yDec)) ? Number(yDec) : 9;
  const feeYUi = Math.max(0, safeNum(feeYRaw, 0) / Math.pow(10, safeYDec));
  let feeXSol = 0;
  let feePnlSource = feeXRawStr === '0' ? 'none' : 'pool_price';

  if (feeXRawStr !== '0') {
    if (typeof quoteFn === 'function') {
      try {
        const quote = await quoteFn(tokenXMint, WSOL_MINT, feeXRawStr);
        feeXSol = Math.max(0, Number(quote?.outAmount || 0) / 1e9);
        feePnlSource = 'jupiter';
      } catch {
        // fall through ke pool price fallback
      }
    }
    if (feePnlSource !== 'jupiter') {
      const feeXUi = Math.max(0, safeNum(feeXRawStr, 0) / Math.pow(10, safeXDec));
      feeXSol = Math.max(0, feeXUi * safeNum(activeBinPrice, 0));
      feePnlSource = feeXSol > 0 ? 'pool_price' : 'none';
    }
  }

  const feePnlSol = Math.max(0, feeYUi + feeXSol);
  if (feePnlSource === 'none' && feeYUi > 0) feePnlSource = 'position_fee_y';
  const feePnlPct = Number(deploySol) > 0 ? (feePnlSol / Number(deploySol)) * 100 : 0;
  return {
    feePnlSol,
    feePnlPct,
    feeXUi: Math.max(0, safeNum(feeXRawStr, 0) / Math.pow(10, safeXDec)),
    feeYUi,
    feePnlSource,
    feePnlAvailable: true,
  };
}

export async function estimatePositionValueSolFromPositionData({
  positionData = {},
  tokenXMint = '',
  xDec = 9,
  yDec = 9,
  activeBinPrice = 0,
  quoteFn = getJupiterQuote,
} = {}) {
  const pd = positionData || {};
  const safeXDec = Number.isFinite(Number(xDec)) ? Number(xDec) : 9;
  const safeYDec = Number.isFinite(Number(yDec)) ? Number(yDec) : 9;
  const totalXRaw = toBnAmountSafe(pd.totalXAmount).add(toBnAmountSafe(pd.feeX));
  const totalYRaw = toBnAmountSafe(pd.totalYAmount).add(toBnAmountSafe(pd.feeY));
  const totalYUi = Number(totalYRaw.toString()) / Math.pow(10, safeYDec);
  const totalXRawToSell = totalXRaw.toString();
  let xValueSol = 0;
  let valueSource = 'position_y_only';

  if (totalXRaw.gt(new BN('0'))) {
    if (typeof quoteFn === 'function') {
      try {
        const quote = await quoteFn(tokenXMint, WSOL_MINT, totalXRawToSell);
        xValueSol = Math.max(0, Number(quote?.outAmount || 0) / 1e9);
        valueSource = 'jupiter_quote';
      } catch {
        // fall through ke pool price fallback
      }
    }
    if (valueSource !== 'jupiter_quote') {
      const totalXUi = Number(totalXRaw.toString()) / Math.pow(10, safeXDec);
      xValueSol = Math.max(0, totalXUi * safeNum(activeBinPrice, 0));
      valueSource = xValueSol > 0 ? 'pool_price' : 'position_y_only';
    }
  }

  const positionValueSol = Math.max(0, totalYUi + xValueSol);
  return {
    positionValueSol,
    totalYUi: Math.max(0, totalYUi),
    xValueSol: Math.max(0, xValueSol),
    totalXRawToSell,
    valueSource,
  };
}

export function computeFinalExitAccounting({
  deploySol = 0,
  positionValueSol = 0,
  walletNetDeltaSol = 0,
  txFeesSol = 0,
} = {}) {
  const safeDeploySol = Math.max(0, safeNum(deploySol, 0));
  const safePositionValueSol = safeNum(positionValueSol, 0);
  const safeWalletNetDeltaSol = safeNum(walletNetDeltaSol, 0);
  const safeTxFeesSol = Math.max(0, safeNum(txFeesSol, 0));
  const realizedTradingPnlSol = safePositionValueSol - safeDeploySol;
  const realizedTradingPnlPct = safeDeploySol > 0
    ? (realizedTradingPnlSol / safeDeploySol) * 100
    : 0;
  const rentRefundSol = safeWalletNetDeltaSol - safePositionValueSol + safeTxFeesSol;
  return {
    deploySol: safeDeploySol,
    positionValueSol: safePositionValueSol,
    walletNetDeltaSol: safeWalletNetDeltaSol,
    txFeesSol: safeTxFeesSol,
    rentRefundSol,
    realizedTradingPnlSol,
    realizedTradingPnlPct,
    accountingStatus: 'estimated_rent_refund_from_wallet_delta',
  };
}

function toSafeBigIntRaw(value) {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return 0n;
  }
}

function isValidPositiveIntegerString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && value !== '0';
}

function buildExitSwapPolicy(cfg = {}, isUrgent = false) {
  const modeRaw = String(cfg.closeSwapMode ?? 'fee_only').trim().toLowerCase();
  const swapMode = modeRaw === 'off' ? 'off' : (modeRaw === 'all' ? 'all' : 'fee_only');
  return {
    swapMode,
    allowResidualSwap: cfg.closeResidualSwapEnabled === true,
    maxImpactPct: Math.max(0.1, Number(cfg.maxExitPriceImpactPct ?? 5.0)),
    minOutSol: Math.max(0, Number(cfg.closeAutoSwapMinOutSol ?? 0.0003)),
    minNetSol: Math.max(0, Number(cfg.closeAutoSwapMinNetSol ?? 0.00015)),
    estimatedCostSol: Math.max(
      0,
      Number(cfg.closeEstimatedSwapCostSol ?? (isUrgent ? 0.0002 : 0.00012)),
    ),
  };
}

function buildTakeProfitExitSwapPolicy(cfg = {}, isEmergencyExit = false) {
  const basePolicy = buildExitSwapPolicy(cfg, isEmergencyExit);
  return {
    ...basePolicy,
    swapMode: 'all',
    allowResidualSwap: true,
  };
}

function isTakeProfitExitReason(reason = '', normalizedReason = '') {
  if (normalizedReason === 'TAKE_PROFIT') return true;
  const text = String(reason || '').trim().toUpperCase();
  return text.startsWith('TAKE_PROFIT');
}

async function waitForExitTokenBalanceSettle({
  mint,
  baselineRaw = '0',
  attempts = 4,
  delayMs = 800,
} = {}) {
  const baseline = toSafeBigIntRaw(baselineRaw);
  let lastRaw = String(baselineRaw || '0');

  for (let i = 0; i < attempts; i++) {
    const currentRaw = await getTokenBalanceRaw(mint).catch(() => '0');
    lastRaw = String(currentRaw || '0');
    const current = toSafeBigIntRaw(lastRaw);
    if (current > baseline) {
      return {
        rawAmount: lastRaw,
        settled: true,
        attemptsUsed: i + 1,
      };
    }
    if (i < attempts - 1) await sleep(delayMs);
  }

  return {
    rawAmount: lastRaw,
    settled: false,
    attemptsUsed: attempts,
  };
}

async function auditExitResidualTokenBalances({
  mints = [],
  attempts = 3,
  delayMs = 600,
} = {}) {
  const candidates = mints.filter((mint, index, arr) => {
    const normalizedMint = String(mint || '');
    if (!normalizedMint || normalizedMint === WSOL_MINT) return false;
    return arr.findIndex((candidate) => String(candidate || '') === normalizedMint) === index;
  });
  const balances = [];

  for (const mint of candidates) {
    let rawAmount = '0';
    let readOk = false;
    let error = null;

    for (let i = 0; i < attempts; i++) {
      try {
        rawAmount = String(await getTokenBalanceRaw(mint) || '0');
        readOk = true;
        error = null;
        if (!isValidPositiveIntegerString(rawAmount)) break;
      } catch (err) {
        readOk = false;
        error = err?.message || String(err);
      }
      if (i < attempts - 1) await sleep(delayMs);
    }

    balances.push({
      mint: String(mint),
      rawAmount,
      hasResidual: readOk && isValidPositiveIntegerString(rawAmount),
      readOk,
      error,
    });
  }

  return balances;
}

async function attemptGatedExitSwapToSol({
  mint,
  rawAmount,
  slippageBps,
  isUrgent,
  isEmergencyExit,
  emergencySlippageBps,
  maxImpactPct,
  minOutSol,
  minNetSol,
  estimatedCostSol,
  label,
} = {}) {
  const amountStr = String(rawAmount || '0');
  if (!mint || mint === WSOL_MINT || !isValidPositiveIntegerString(amountStr)) {
    return { skipped: true, reason: `${label}_INVALID_AMOUNT_OR_MINT` };
  }

  let quote;
  try {
    quote = await getSwapQuoteToSol(mint, amountStr, slippageBps);
  } catch (err) {
    return { skipped: true, reason: `${label}_QUOTE_FAILED`, error: err.message };
  }

  const outSol = Number(quote?.outAmount || 0) / 1e9;
  const impact = Number(quote?.priceImpactPct || 0);
  const netOutSol = outSol - estimatedCostSol;

  if (!Number.isFinite(outSol) || outSol <= 0) {
    return { skipped: true, reason: `${label}_ZERO_OUT` };
  }
  if (!Number.isFinite(impact) || impact > maxImpactPct) {
    return { skipped: true, reason: `${label}_HIGH_IMPACT_${impact.toFixed(2)}%` };
  }
  if (outSol < minOutSol) {
    return { skipped: true, reason: `${label}_OUT_BELOW_MIN_${outSol.toFixed(6)}` };
  }
  if (netOutSol < minNetSol) {
    return { skipped: true, reason: `${label}_NET_BELOW_MIN_${netOutSol.toFixed(6)}` };
  }

  try {
    const swapRes = await swapToSol(mint, amountStr, slippageBps, {
      isUrgent,
      isEmergencyExit,
      emergencySlippageBps,
    });
    if (swapRes?.success) {
      return {
        success: true,
        txHash: swapRes.txHash,
        outSol: Number(swapRes.outSol || outSol),
        priceImpactPct: Number(swapRes.priceImpactPct || impact),
      };
    }
    return {
      skipped: true,
      reason: `${label}_${swapRes?.reason || 'SWAP_NOT_EXECUTED'}`,
      error: swapRes?.error || null,
    };
  } catch (err) {
    return { skipped: true, reason: `${label}_SWAP_FAILED`, error: err.message };
  }
}

async function findAdaptiveRentFreeRange({
  connection,
  poolPubkey,
  desiredMin,
  desiredMax,
  maxBins,
  initialStatus = null,
} = {}) {
  const plans = [
    {
      slackArrays: 0,
      searchMin: desiredMin,
      searchMax: desiredMax,
      status: initialStatus,
    },
  ];

  for (let slackArrays = 1; slackArrays <= RENT_FREE_SEARCH_SLACK_ARRAYS; slackArrays++) {
    plans.push({
      slackArrays,
      searchMin: desiredMin - (BIN_ARRAY_SIZE * slackArrays),
      searchMax: desiredMax + (BIN_ARRAY_SIZE * slackArrays),
      status: null,
    });
  }

  for (const plan of plans) {
    let status = plan.status;
    if (!status) {
      try {
        status = await inspectRangeBinArrayInitStatus(connection, poolPubkey, plan.searchMin, plan.searchMax);
      } catch (e) {
        if (!String(e?.message || '').startsWith('BIN_ARRAY_RENT_REQUIRED')) {
          throw e;
        }
        continue;
      }
    }

    if (!status || status.unchecked) continue;

    const adjusted = selectRentFreeRange({
      desiredMin: plan.searchMin,
      desiredMax: plan.searchMax,
      maxBins,
      arrayStatuses: status.arrayStatuses,
    });

    if (adjusted) {
      return {
        adjusted,
        searchSlackArrays: plan.slackArrays,
        searchMin: plan.searchMin,
        searchMax: plan.searchMax,
        status,
      };
    }
  }

  return null;
}

async function persistActivePositionsState() {
  const rows = [..._activePositions.entries()].map(([pubkey, meta]) => ({
    pubkey,
    ...meta,
  }));
  setRuntimeState(ACTIVE_POSITIONS_STATE_KEY, rows);
}

function loadQuoteOnlyDeployMarkers() {
  if (_quoteOnlyDeployMarkersLoaded) return;
  _quoteOnlyDeployMarkersLoaded = true;
  const saved = getRuntimeState(QUOTE_ONLY_DEPLOY_MARKERS_STATE_KEY, []);
  const rows = Array.isArray(saved) ? saved : [];
  const now = Date.now();
  _quoteOnlyDeployMarkers.clear();
  for (const row of rows) {
    const positionPubkey = String(row?.positionPubkey || '');
    if (!positionPubkey) continue;
    const expiresAt = Number(row?.expiresAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) continue;
    _quoteOnlyDeployMarkers.set(positionPubkey, {
      poolAddress: String(row?.poolAddress || ''),
      tokenXMint: String(row?.tokenXMint || ''),
      positionPubkey,
      startedAt: Number.isFinite(Number(row?.startedAt)) ? Number(row.startedAt) : now,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : (now + QUOTE_ONLY_DEPLOY_MARKER_TTL_MS),
      ttlMs: Number.isFinite(Number(row?.ttlMs)) ? Number(row.ttlMs) : QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      source: String(row?.source || BOT_QUOTE_ONLY_DEPLOY_SOURCE),
      phase: String(row?.phase || PHASE_POSITION_INIT_PENDING),
      liquidityConfirmed: row?.liquidityConfirmed === true,
      updatedAt: Number.isFinite(Number(row?.updatedAt)) ? Number(row.updatedAt) : now,
      addLiquidityFailedAt: Number.isFinite(Number(row?.addLiquidityFailedAt)) ? Number(row.addLiquidityFailedAt) : null,
      addLiquidityError: row?.addLiquidityError ? String(row.addLiquidityError) : null,
      cleanupStatus: row?.cleanupStatus ? String(row.cleanupStatus) : null,
    });
  }
}

function pruneExpiredQuoteOnlyDeployMarkers(now = Date.now()) {
  loadQuoteOnlyDeployMarkers();
  let changed = false;
  for (const [positionPubkey, marker] of [..._quoteOnlyDeployMarkers.entries()]) {
    const expiresAt = Number(marker?.expiresAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
      _quoteOnlyDeployMarkers.delete(positionPubkey);
      changed = true;
    }
  }
  return changed;
}

function persistQuoteOnlyDeployMarkersState() {
  pruneExpiredQuoteOnlyDeployMarkers();
  const rows = [..._quoteOnlyDeployMarkers.values()].map((marker) => ({
    ...marker,
  }));
  setRuntimeState(QUOTE_ONLY_DEPLOY_MARKERS_STATE_KEY, rows);
}

function getQuoteOnlyDeployMarker(positionPubkey = '') {
  loadQuoteOnlyDeployMarkers();
  pruneExpiredQuoteOnlyDeployMarkers();
  return _quoteOnlyDeployMarkers.get(String(positionPubkey || '')) || null;
}

function isBotQuoteOnlyPartialMarker(marker = null) {
  if (!marker) return false;
  const phase = String(marker?.phase || '');
  return marker?.source === BOT_QUOTE_ONLY_DEPLOY_SOURCE && (
    phase === PHASE_POSITION_INIT_CONFIRMED ||
    phase === PHASE_ADD_LIQUIDITY_PENDING ||
    phase === PHASE_ADD_LIQUIDITY_FAILED
  ) && marker?.liquidityConfirmed !== true;
}

function upsertQuoteOnlyDeployMarker({
  positionPubkey = '',
  poolAddress = '',
  tokenXMint = '',
  phase = PHASE_POSITION_INIT_PENDING,
  source = BOT_QUOTE_ONLY_DEPLOY_SOURCE,
  ttlMs = QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
  liquidityConfirmed = false,
  extra = {},
} = {}) {
  const safePosition = String(positionPubkey || '');
  if (!safePosition) return null;
  loadQuoteOnlyDeployMarkers();
  const now = Date.now();
  const current = _quoteOnlyDeployMarkers.get(safePosition) || {};
  const safeTtl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : QUOTE_ONLY_DEPLOY_MARKER_TTL_MS;
  const next = {
    poolAddress: String(poolAddress || current.poolAddress || ''),
    tokenXMint: String(tokenXMint || current.tokenXMint || ''),
    positionPubkey: safePosition,
    startedAt: Number.isFinite(Number(current.startedAt)) ? Number(current.startedAt) : now,
    expiresAt: now + safeTtl,
    ttlMs: safeTtl,
    source: String(source || current.source || BOT_QUOTE_ONLY_DEPLOY_SOURCE),
    phase: String(phase || current.phase || PHASE_POSITION_INIT_PENDING),
    liquidityConfirmed: liquidityConfirmed === true || current.liquidityConfirmed === true,
    updatedAt: now,
    addLiquidityFailedAt: extra?.addLiquidityFailedAt ?? current.addLiquidityFailedAt ?? null,
    addLiquidityError: extra?.addLiquidityError ?? current.addLiquidityError ?? null,
    cleanupStatus: extra?.cleanupStatus ?? current.cleanupStatus ?? null,
  };
  _quoteOnlyDeployMarkers.set(safePosition, next);
  persistQuoteOnlyDeployMarkersState();
  return next;
}

function clearQuoteOnlyDeployMarker(positionPubkey = '') {
  const safePosition = String(positionPubkey || '');
  if (!safePosition) return;
  loadQuoteOnlyDeployMarkers();
  if (_quoteOnlyDeployMarkers.delete(safePosition)) {
    persistQuoteOnlyDeployMarkersState();
  }
}

function hasPositivePositionLiquidity(positionData = null) {
  const pd = positionData || {};
  const totalX = Number(pd.totalXAmount?.toString() || '0');
  const totalY = Number(pd.totalYAmount?.toString() || '0');
  const feeX = Number(pd.feeX?.toString() || '0');
  const feeY = Number(pd.feeY?.toString() || '0');
  return (totalX + totalY + feeX + feeY) > 0;
}

async function verifyQuoteOnlyLiquidityOnChain({
  connection,
  wallet,
  poolAddress = '',
  positionPubkey = '',
  attempts = 3,
  delayMs = 800,
  getFreshPositionFn = null,
} = {}) {
  const safePositionPubkey = String(positionPubkey || '');
  if (!connection || !wallet || !poolAddress || !safePositionPubkey) {
    return { confirmed: false, exists: false, hasLiquidity: false };
  }

  const fetchFn = typeof getFreshPositionFn === 'function' ? getFreshPositionFn : getFreshActivePosition;
  let lastExists = false;
  let lastHasLiquidity = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const fresh = await fetchFn(connection, wallet, poolAddress, safePositionPubkey);
      const activePos = fresh?.activePos || null;
      lastExists = Boolean(activePos);
      lastHasLiquidity = activePos ? hasPositivePositionLiquidity(activePos?.positionData || {}) : false;
      if (lastExists && lastHasLiquidity) {
        return { confirmed: true, exists: true, hasLiquidity: true };
      }
    } catch {
      // retry
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { confirmed: false, exists: lastExists, hasLiquidity: lastHasLiquidity };
}

function markQuoteOnlyLiquidityConfirmed({
  positionPubkey = '',
  poolAddress = '',
  tokenXMint = '',
} = {}) {
  upsertQuoteOnlyDeployMarker({
    positionPubkey,
    poolAddress,
    tokenXMint,
    phase: PHASE_ADD_LIQUIDITY_CONFIRMED,
    source: BOT_QUOTE_ONLY_DEPLOY_SOURCE,
    ttlMs: QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
    liquidityConfirmed: true,
  });
}

async function unlockFailedEmptyDeployPosition(positionPubkey, {
  reason = 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
  cleanupStatus = null,
} = {}) {
  const reg = _activePositions.get(positionPubkey);
  if (reg) {
    _activePositions.delete(positionPubkey);
    clearPositionRuntimeState(positionPubkey);
    await persistActivePositionsStateNow();
    console.warn(
      `[evilPanda] DEPLOY_PARTIAL_EMPTY_POSITION_UNLOCK pool=${String(reg?.poolAddress || '').slice(0,8)} ` +
      `position=${String(positionPubkey || '').slice(0,8)} reason=${reason}`
    );
  }
  const marker = getQuoteOnlyDeployMarker(positionPubkey);
  if (marker) {
    upsertQuoteOnlyDeployMarker({
      positionPubkey,
      poolAddress: marker.poolAddress,
      tokenXMint: marker.tokenXMint,
      phase: PHASE_ADD_LIQUIDITY_FAILED,
      source: marker.source || BOT_QUOTE_ONLY_DEPLOY_SOURCE,
      ttlMs: marker.ttlMs || QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
      liquidityConfirmed: false,
      extra: {
        cleanupStatus: cleanupStatus || marker.cleanupStatus || null,
      },
    });
  }
}

async function cleanupQuoteOnlyPartialEmptyPosition({
  connection,
  wallet,
  dlmmPool,
  poolAddress = '',
  positionPubkey = '',
  marker = null,
  microLamports = EP_CONFIG.MICRO_LAMPORTS,
  getFreshPositionFn = null,
  verifyClosedFn = null,
} = {}) {
  const safePositionPubkey = String(positionPubkey || '');
  if (!connection || !wallet || !dlmmPool || !safePositionPubkey) {
    return {
      cleaned: false,
      skipped: true,
      reason: 'MISSING_CLEANUP_DEPENDENCIES',
      hasLiquidity: false,
    };
  }

  console.warn(
    `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_START pool=${String(poolAddress || '').slice(0,8)} ` +
    `position=${safePositionPubkey.slice(0,8)} phase=${String(marker?.phase || 'unknown')}`
  );

  let activePos = null;
  try {
    const fetchFn = typeof getFreshPositionFn === 'function'
      ? getFreshPositionFn
      : getFreshActivePosition;
    const fresh = await fetchFn(connection, wallet, poolAddress, safePositionPubkey);
    activePos = fresh?.activePos || null;
  } catch (err) {
    return {
      cleaned: false,
      skipped: true,
      reason: `FETCH_POSITION_FAILED:${String(err?.message || 'unknown')}`,
      hasLiquidity: false,
    };
  }

  if (!activePos) {
    console.log(
      `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_SKIPPED pool=${String(poolAddress || '').slice(0,8)} ` +
      `position=${safePositionPubkey.slice(0,8)} reason=POSITION_NOT_FOUND`
    );
    return { cleaned: true, skipped: false, reason: 'POSITION_NOT_FOUND', hasLiquidity: false };
  }

  const pd = activePos?.positionData || {};
  const totalX = Number(pd.totalXAmount?.toString() || '0');
  const totalY = Number(pd.totalYAmount?.toString() || '0');
  const feeX = Number(pd.feeX?.toString() || '0');
  const feeY = Number(pd.feeY?.toString() || '0');
  const hasLiquidity = (totalX + totalY + feeX + feeY) > 0;

  if (hasLiquidity) {
    console.warn(
      `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_SKIPPED pool=${String(poolAddress || '').slice(0,8)} ` +
      `position=${safePositionPubkey.slice(0,8)} reason=HAS_LIQUIDITY`
    );
    return { cleaned: false, skipped: true, reason: 'HAS_LIQUIDITY', hasLiquidity: true };
  }

  let closeSignatures = [];
  try {
    const closeTxOrTxs = await dlmmPool.closePosition({
      owner: wallet.publicKey,
      position: new PublicKey(safePositionPubkey),
    });
    closeSignatures = await sendCloseEmptyPositionTxs(connection, wallet, closeTxOrTxs, microLamports);
  } catch (err) {
    console.warn(
      `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLOSE_FAILED pool=${String(poolAddress || '').slice(0,8)} ` +
      `position=${safePositionPubkey.slice(0,8)} reason=${String(err?.message || 'unknown')}`
    );
    return {
      cleaned: false,
      skipped: true,
      reason: `CLOSE_EMPTY_POSITION_FAILED:${String(err?.message || 'unknown')}`,
      hasLiquidity: false,
      closeAttempted: true,
      closeConfirmed: false,
      closeSignatures,
    };
  }

  const verifyFn = typeof verifyClosedFn === 'function'
    ? verifyClosedFn
    : verifyPositionClosedOnChain;
  const closed = await verifyFn(connection, wallet, poolAddress, safePositionPubkey, {
    attempts: 2,
    delayMs: 800,
  });
  if (!closed) {
    console.warn(
      `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_SKIPPED pool=${String(poolAddress || '').slice(0,8)} ` +
      `position=${safePositionPubkey.slice(0,8)} reason=CLOSE_NOT_CONFIRMED`
    );
    return {
      cleaned: false,
      skipped: true,
      reason: 'CLOSE_NOT_CONFIRMED',
      hasLiquidity: false,
      closeAttempted: true,
      closeConfirmed: false,
      closeSignatures,
    };
  }

  console.log(
    `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_OK pool=${String(poolAddress || '').slice(0,8)} ` +
    `position=${safePositionPubkey.slice(0,8)} verified=ON_CHAIN`
  );
  return {
    cleaned: true,
    skipped: false,
    reason: 'CLOSED_EMPTY_POSITION',
    hasLiquidity: false,
    closeAttempted: true,
    closeConfirmed: true,
    closeSignatures,
  };
}

async function handleQuoteOnlyPartialDeployFailure({
  connection,
  wallet,
  dlmmPool,
  poolAddress = '',
  positionPubkey = '',
  microLamports = EP_CONFIG.MICRO_LAMPORTS,
  error = null,
  getFreshPositionFn = null,
  verifyClosedFn = null,
} = {}) {
  const marker = getQuoteOnlyDeployMarker(positionPubkey);
  if (!isBotQuoteOnlyPartialMarker(marker)) return null;
  const safePositionPubkey = String(positionPubkey || '');
  const cleanup = await cleanupQuoteOnlyPartialEmptyPosition({
    connection,
    wallet,
    dlmmPool,
    poolAddress,
    positionPubkey,
    marker,
    microLamports,
    getFreshPositionFn,
    verifyClosedFn,
  });

  const tokenLabel = String(marker?.tokenXMint || poolAddress || 'unknown').slice(0, 8) || 'UNKNOWN';
  const poolLabel = String(poolAddress || marker?.poolAddress || 'unknown').slice(0, 8) || 'UNKNOWN';
  const positionConfirmedClosed = cleanup?.cleaned === true ||
    cleanup?.closeConfirmed === true ||
    cleanup?.reason === 'POSITION_NOT_FOUND';
  await notify(positionConfirmedClosed
    ? (
      `❌ <b>DEPLOY FAILED | ${escapeHTML(tokenLabel)}-SOL</b>\n` +
      `Position: <code>${safePositionPubkey.slice(0,8)}</code>\n` +
      `Pool: <code>${escapeHTML(poolLabel)}</code>\n` +
      `Status: <code>NO ACTIVE POSITION</code>\n` +
      `Reason: <code>${escapeHTML(cleanup?.reason || 'DEPLOY_FAILED')}</code>\n` +
      `<i>Tidak ada posisi aktif yang perlu ditutup.</i>`
    )
    : (
      `⚠️ <b>DEPLOY INCOMPLETE | ${escapeHTML(tokenLabel)}-SOL</b>\n` +
      `Position: <code>${safePositionPubkey.slice(0,8)}</code>\n` +
      `Pool: <code>${escapeHTML(poolLabel)}</code>\n` +
      `Status: <code>POSITION STILL OPEN OR UNCERTAIN</code>\n` +
      `Reason: <code>${escapeHTML(cleanup?.reason || 'DEPLOY_INCOMPLETE')}</code>\n` +
      `<b>Action:</b> <i>cek wallet, unwrap, lalu close manual di Meteora.</i>`
    )
  );

  if (cleanup?.cleaned === true || cleanup?.reason === 'POSITION_NOT_FOUND') {
    await unlockFailedEmptyDeployPosition(positionPubkey, {
      reason: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
      cleanupStatus: cleanup?.reason || null,
    });
  }

  if (error && typeof error === 'object') {
    error.dlmmContextExtra = {
      ...(error.dlmmContextExtra || {}),
      botDeployPartialCleanup: cleanup?.reason || 'UNKNOWN',
      cleanupHasLiquidity: cleanup?.hasLiquidity === true,
      cleanupSkipped: cleanup?.skipped === true,
    };
  }
  return cleanup;
}

async function persistActivePositionsStateNow() {
  await persistActivePositionsState();
  await flushRuntimeState();
}

export async function setPositionLifecycle(positionPubkey, lifecycleState, extra = {}, { flush = false } = {}) {
  const current = _activePositions.get(positionPubkey) || {};
  _activePositions.set(positionPubkey, {
    ...current,
    ...extra,
    lifecycleState,
    lifecycle_state: lifecycleState,
    lifecycleUpdatedAt: nowIso(),
  });
  if (flush) await persistActivePositionsStateNow();
  else await persistActivePositionsState();
  return _activePositions.get(positionPubkey);
}

function hasTrackedPoolPosition(poolAddress) {
  if (!poolAddress) return false;
  return [..._activePositions.values()].some((meta) => {
    const trackedPool = String(meta?.poolAddress || '');
    const lifecycle = String(meta?.lifecycleState || meta?.lifecycle_state || '').toLowerCase();
    return trackedPool === String(poolAddress) && lifecycle !== 'closed';
  });
}

async function withExitAccountingLock(fn) {
  while (_exitAccountingLock) await new Promise((resolve) => setTimeout(resolve, 100));
  _exitAccountingLock = true;
  try {
    return await fn();
  } finally {
    _exitAccountingLock = false;
  }
}

function nowIso() { return new Date().toISOString(); }

function getConfiguredStopLossPct() {
  const cfg = getConfig();
  const value = Number(cfg.stopLossPct);
  return Number.isFinite(value) && value > 0 ? value : EP_CONFIG.STOP_LOSS_PCT;
}

function getConfiguredSmartExitRsi() {
  const cfg = getConfig();
  const value = Number(cfg.smartExitRsi);
  return Number.isFinite(value) && value > 0 ? value : EP_CONFIG.RSI_EXIT_THRESHOLD;
}

function getConfiguredMaxHoldHours() {
  const cfg = getConfig();
  const value = Number(cfg.maxHoldHours);
  return Number.isFinite(value) && value > 0 ? value : 72;
}

function getConfiguredTrailingTriggerPct() {
  const cfg = getConfig();
  const value = Number(cfg.trailingTriggerPct);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function getConfiguredTrailingStopPct() {
  const cfg = getConfig();
  const value = Number(cfg.trailingStopPct);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getConfiguredTrailingDropPct() {
  const cfg = getConfig();
  const value = Number(cfg.trailingDropPct);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getConfiguredTakeProfitMinNetPnlPct() {
  const cfg = getConfig();
  const value = Number(cfg.takeProfitMinNetPnlPct);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function getConfiguredDeployRangeBinOffsets(cfg = getConfig()) {
  const rawMin = Number(cfg.deployRangeMinBinOffset);
  const rawMax = Number(cfg.deployRangeMaxBinOffset);
  const minOffset = Number.isFinite(rawMin) ? Math.max(-500, Math.min(500, Math.floor(rawMin))) : -60;
  const maxOffset = Number.isFinite(rawMax) ? Math.max(-500, Math.min(500, Math.floor(rawMax))) : 0;
  if (minOffset > maxOffset) {
    return {
      minOffset: -60,
      maxOffset: 0,
      fallbackReason: `invalid_offset_order_${minOffset}_${maxOffset}`,
    };
  }
  return {
    minOffset,
    maxOffset,
    fallbackReason: null,
  };
}

function getConfiguredDeployRangeMaxBins(cfg = getConfig()) {
  const { minOffset, maxOffset } = getConfiguredDeployRangeBinOffsets(cfg);
  return Math.max(1, (maxOffset - minOffset) + 1);
}

function buildActiveBinRelativeDeployRange({
  activeBinId,
  minOffset,
  maxOffset,
} = {}) {
  if (!isFiniteInteger(activeBinId)) {
    throw buildInvalidDlmmArgsError(`activeBinId must be finite integer (got ${String(activeBinId)})`);
  }
  if (!isFiniteInteger(minOffset) || !isFiniteInteger(maxOffset)) {
    throw buildInvalidDlmmArgsError(`deployRange offsets must be finite integers (got ${String(minOffset)}/${String(maxOffset)})`);
  }

  const desiredRangeMin = activeBinId + minOffset;
  const desiredRangeMax = activeBinId + maxOffset;
  const rangeMin = desiredRangeMin;
  const rangeMax = desiredRangeMax;

  if (!isFiniteInteger(rangeMin) || !isFiniteInteger(rangeMax) || rangeMin > rangeMax) {
    throw buildInvalidDlmmArgsError(`active-bin relative range invalid [${String(rangeMin)},${String(rangeMax)}]`);
  }

  return {
    desiredRangeMin,
    desiredRangeMax,
    rangeMin,
    rangeMax,
    totalBins: rangeMax - rangeMin + 1,
  };
}

function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Harvest Log ───────────────────────────────────────────────────
// Tulis satu baris CSV ke harvest.log tiap posisi ditutup.
// Format: timestamp,token,pubkey8,pnlPct,deploySol,reason

function appendHarvestLog({ token = 'UNKNOWN', positionPubkey = '', pnlPct = 0, deploySol = 0, reason = 'MANUAL' } = {}) {
  try {
    const line = [
      nowIso(),
      token,
      positionPubkey.slice(0, 8),
      pnlPct.toFixed(4),
      deploySol.toFixed(6),
      reason,
    ].join(',') + '\n';
    appendFileSync(HARVEST_LOG, line, 'utf8');
    console.log(`[evilPanda] 📝 Harvest log: ${line.trim()}`);
  } catch (e) {
    console.warn(`[evilPanda] harvest.log write error: ${e.message}`);
  }
}

function hasManualCloseAccountingSnapshot(reg = {}) {
  const feeSource = String(reg?.feePnlSource || 'none');
  if (reg?.feePnlAvailable === true) return true;
  if (feeSource === 'none' || feeSource === 'fast_path') return false;
  const feePnlSol = Math.max(0, safeNum(reg?.feePnlSol, 0));
  const feePnlPct = Math.max(0, safeNum(reg?.feePnlPct, 0));
  return feePnlSol > 0 || feePnlPct > 0;
}

function buildManualCloseAccounting(reg = {}) {
  const canonicalEntry = readCanonicalEntryContext(reg);
  const deploySol = Math.max(0, safeNum(reg?.deploySol, 0));
  const positionValueSol = Math.max(0, safeNum(reg?.currentValueSol, reg?.positionValueSol || 0));
  const currentValueSol = safeNum(reg?.currentValueSol, null);
  const currentPnlPct = safeNum(reg?.pnlPct, null);
  const feePnlSol = safeNum(reg?.feePnlSol, null);
  const feePnlPct = safeNum(reg?.feePnlPct, null);
  const feePnlSource = String(reg?.feePnlSource || 'snapshot');
  const hasSnapshot = Number.isFinite(currentValueSol) && Number.isFinite(currentPnlPct);
  const hasFeeSnapshot = Number.isFinite(feePnlSol) && Number.isFinite(feePnlPct);
  const accountingStatus = hasSnapshot
    ? 'manual_close_reconciled_from_snapshot'
    : 'manual_close_pnl_unknown';
  const pnlTotalSol = hasSnapshot ? safeNum(currentValueSol, 0) - deploySol : 0;
  const pnlTotalPct = hasSnapshot ? safeNum(currentPnlPct, 0) : 0;
  const pricePnlSol = hasSnapshot && Number.isFinite(feePnlSol)
    ? pnlTotalSol - safeNum(feePnlSol, 0)
    : 0;
  return {
    deploySol,
    positionValueSol,
    feePnlSol: hasFeeSnapshot ? safeNum(feePnlSol, 0) : 0,
    feePnlPct: hasFeeSnapshot ? safeNum(feePnlPct, 0) : 0,
    pricePnlSol,
    pnlTotalSol,
    pnlTotalPct,
    walletNetDeltaSol: null,
    rentRefundSol: null,
    accountingStatus,
    feePnlAvailable: hasFeeSnapshot,
    feePnlSource,
    entryActiveBin: canonicalEntry.entryActiveBin,
    entryPrice: canonicalEntry.entryPrice,
    entrySnapshotAt: canonicalEntry.snapshotAt,
  };
}

function appendPositionLedger({
  positionPubkey = '',
  poolAddress = '',
  tokenMint = '',
  openedAt = null,
  closedAt = null,
  reason = 'MANUAL',
  capitalInSol = 0,
  capitalOutSol = 0,
  pnlTotalSol = 0,
  pnlTotalPct = 0,
  feePnlSol = 0,
  pricePnlSol = 0,
  txCostSol = 0,
  walletNetDeltaSol = null,
  rentRefundSol = null,
  positionValueSol = null,
  realizedTradingPnlSol = null,
  realizedTradingPnlPct = null,
  accountingStatus = 'final',
  manualCloseDetected = false,
  normalizedReason = '',
} = {}) {
  try {
    const capitalIn = safeNum(capitalInSol, 0);
    const capitalOut = safeNum(capitalOutSol, 0);
    const pnlSol = safeNum(pnlTotalSol, 0);
    const pnlPct = safeNum(pnlTotalPct, 0);
    const feeSol = safeNum(feePnlSol, 0);
    const priceSol = safeNum(pricePnlSol, 0);
    const costSol = safeNum(txCostSol, 0);
    const walletDelta = Number.isFinite(Number(walletNetDeltaSol))
      ? Number(safeNum(walletNetDeltaSol, 0).toFixed(9))
      : null;
    const rentRefund = Number.isFinite(Number(rentRefundSol))
      ? Number(safeNum(rentRefundSol, 0).toFixed(9))
      : null;
    const positionValue = Number.isFinite(Number(positionValueSol))
      ? Number(safeNum(positionValueSol, 0).toFixed(9))
      : null;
    const realizedPnlSol = Number.isFinite(Number(realizedTradingPnlSol))
      ? Number(safeNum(realizedTradingPnlSol, 0).toFixed(9))
      : null;
    const realizedPnlPct = Number.isFinite(Number(realizedTradingPnlPct))
      ? Number(safeNum(realizedTradingPnlPct, 0).toFixed(6))
      : null;
    const row = {
      ts: nowIso(),
      positionPubkey,
      poolAddress,
      tokenMint,
      openedAt,
      closedAt,
      reason,
      normalizedReason: normalizedReason || normalizeExitReason(reason),
      accountingStatus,
      manualCloseDetected,
      cashflow: {
        capitalInSol: Number(capitalIn.toFixed(9)),
        capitalOutSol: Number(capitalOut.toFixed(9)),
        pnlTotalSol: Number(pnlSol.toFixed(9)),
        pnlTotalPct: Number(pnlPct.toFixed(6)),
        feePnlSol: Number(feeSol.toFixed(9)),
        pricePnlSol: Number(priceSol.toFixed(9)),
        txCostSol: Number(costSol.toFixed(9)),
        positionValueSol: positionValue,
        walletNetDeltaSol: walletDelta,
        rentRefundSol: rentRefund,
        realizedTradingPnlSol: realizedPnlSol,
        realizedTradingPnlPct: realizedPnlPct,
      },
    };
    appendFileSync(POSITION_LEDGER_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[evilPanda] position-ledger write error: ${e.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function injectPriorityFee(tx, { units, microLamports } = {}) {
  const cu   = units        || EP_CONFIG.COMPUTE_UNITS;
  const mLam = microLamports || EP_CONFIG.MICRO_LAMPORTS;

  if (tx instanceof VersionedTransaction) {
    try {
      const msg = TransactionMessage.decompile(tx.message);
      const CB  = ComputeBudgetProgram.programId.toString();
      msg.instructions = msg.instructions.filter(ix => ix.programId.toString() !== CB);
      msg.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: mLam }),
      );
      tx.message = msg.compileToV0Message();
    } catch (e) {
      console.warn(`[evilPanda] Priority fee inject failed: ${e.message}`);
    }
    return;
  }
  // Legacy TX
  const CB = ComputeBudgetProgram.programId.toString();
  tx.instructions = (tx.instructions || []).filter(ix => ix.programId.toString() !== CB);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: mLam }),
  );
}

async function getPriorityFee() {
  try {
    const fee = await getRecommendedPriorityFee();
    return Math.max(EP_CONFIG.MICRO_LAMPORTS, Number(fee) || EP_CONFIG.MICRO_LAMPORTS);
  } catch {
    return EP_CONFIG.MICRO_LAMPORTS;
  }
}

async function pollTxConfirm(connection, sig, maxWaitMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (value?.err) throw new Error(`TX on-chain error: ${JSON.stringify(value.err)}`);
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
        return sig;
      }
    } catch (e) {
      if (e.message.startsWith('TX on-chain')) throw e;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error(`TX ${sig.slice(0, 8)}… not confirmed after ${maxWaitMs / 1000}s`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorLogs(error) {
  if (!error) return [];
  if (Array.isArray(error.logs)) return error.logs;
  if (typeof error.getLogs === 'function') {
    try {
      const logs = error.getLogs();
      if (Array.isArray(logs)) return logs;
    } catch {}
  }
  return [];
}

function isComputeUnitExhausted(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  const logs = getErrorLogs(error).join('\n').toLowerCase();
  return msg.includes('exceeded cus meter')
    || msg.includes('computational budget exceeded')
    || msg.includes('compute units')
    || logs.includes('exceeded cus meter')
    || logs.includes('computational budget exceeded');
}

function logSendTxError(prefix, error) {
  const logs = getErrorLogs(error);
  console.warn(`[evilPanda] ${prefix}: ${error?.message || error}`);
  if (logs.length > 0) {
    console.warn(`[evilPanda] ${prefix} logs:\n${logs.slice(-12).join('\n')}`);
  }
}

function extractRequiredSignerPubkeys(tx) {
  const required = new Set();
  if (!tx) return required;

  try {
    if (tx instanceof VersionedTransaction) {
      const msg = tx.message;
      const keys = Array.isArray(msg?.staticAccountKeys) ? msg.staticAccountKeys : [];
      const count = Number(msg?.header?.numRequiredSignatures || 0);
      for (let i = 0; i < Math.min(count, keys.length); i++) {
        const key = keys[i];
        const pubkey = String(key?.toString?.() || '');
        if (pubkey) required.add(pubkey);
      }
      return required;
    }
  } catch {}

  try {
    if (typeof tx?.compileMessage === 'function') {
      const msg = tx.compileMessage();
      const keys = Array.isArray(msg?.accountKeys) ? msg.accountKeys : [];
      const count = Number(msg?.header?.numRequiredSignatures || 0);
      for (let i = 0; i < Math.min(count, keys.length); i++) {
        const key = keys[i];
        const pubkey = String(key?.toString?.() || '');
        if (pubkey) required.add(pubkey);
      }
    }
  } catch {}

  if (required.size > 0) return required;
  if (Array.isArray(tx?.signatures)) {
    for (const sig of tx.signatures) {
      const pubkey = String(sig?.publicKey?.toString?.() || '');
      if (pubkey) required.add(pubkey);
    }
  }
  return required;
}

export function filterKnownTransactionSigners(tx, extraSigners = [], { txStage = 'unknown' } = {}) {
  const extras = Array.isArray(extraSigners) ? extraSigners.filter(Boolean) : [];
  if (extras.length === 0) return [];

  const requiredSignerPubkeys = extractRequiredSignerPubkeys(tx);
  if (requiredSignerPubkeys.size === 0) {
    return extras;
  }

  const filtered = [];
  for (const signer of extras) {
    const signerPubkey = String(signer?.publicKey?.toString?.() || '');
    if (!signerPubkey) continue;
    if (requiredSignerPubkeys.has(signerPubkey)) {
      filtered.push(signer);
      continue;
    }
    console.warn(
      `[evilPanda] SKIP_UNKNOWN_TX_SIGNER tx=${String(txStage || 'unknown')} signer=${signerPubkey.slice(0,8)}`
    );
  }
  return filtered;
}

function extractUnknownSignerFromError(error) {
  const msg = String(error?.message || error || '');
  const direct = msg.match(/unknown signer:\s*([1-9A-HJ-NP-Za-km-z]{32,64})/i);
  if (direct?.[1]) return direct[1];
  return null;
}

function getInstructionAccountPubkeys(ix) {
  if (!ix) return [];
  if (Array.isArray(ix.keys) && ix.keys.length > 0) {
    return ix.keys
      .map((k) => String(k?.pubkey?.toString?.() || ''))
      .filter(Boolean);
  }
  if (Array.isArray(ix.accounts) && ix.accounts.length > 0) {
    return ix.accounts
      .map((k) => String(k?.toString?.() || ''))
      .filter(Boolean);
  }
  return [];
}

function getTransferLamportsFromSystemInstruction(ix) {
  try {
    const decoded = SystemInstruction.decodeTransfer(ix);
    const lamports = Number(decoded?.lamports || 0);
    return Number.isFinite(lamports) ? lamports : 0;
  } catch {
    return 0;
  }
}

function getCompiledInstructionAccountPubkeys(tx, cix) {
  const out = [];
  if (!tx || !cix) return out;
  const indexes = Array.isArray(cix.accountKeyIndexes) ? cix.accountKeyIndexes : [];
  if (indexes.length < 2) return out;
  let keysResolver = null;
  try {
    keysResolver = tx?.message?.getAccountKeys?.();
  } catch {
    keysResolver = null;
  }
  for (const idx of indexes.slice(0, 2)) {
    const fromResolver = keysResolver?.get?.(idx);
    if (fromResolver?.toString?.()) {
      out.push(String(fromResolver.toString()));
      continue;
    }
    const fromStatic = tx?.message?.staticAccountKeys?.[idx];
    out.push(String(fromStatic?.toString?.() || ''));
  }
  return out;
}

function getTransferLamportsFromCompiledInstruction(cix) {
  const data = cix?.data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length < 12) return 0;
  const tag = buf.readUInt32LE(0);
  if (tag !== 2) return 0; // SystemInstruction::Transfer
  const lamports = Number(buf.readBigUInt64LE(4));
  return Number.isFinite(lamports) ? lamports : 0;
}

function normalizeExpectedLiquidityLamports(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function isExpectedSolLiquidityTransfer({
  txStage = 'unknown',
  lamports = 0,
  expectedLiquidityLamports = null,
} = {}) {
  if (String(txStage || '') !== 'addLiquidity') return false;
  const expectedLamports = normalizeExpectedLiquidityLamports(expectedLiquidityLamports);
  if (!Number.isFinite(lamports) || lamports <= 0 || expectedLamports === null) return false;
  return lamports === expectedLamports;
}

function assertNoUnexpectedSolTransferInTx({
  tx,
  walletPublicKey,
  minLamports = 100_000,
  allowedToPubkeys = [],
  txStage = 'unknown',
  expectedLiquidityLamports = null,
} = {}) {
  if (!tx || !walletPublicKey) return;
  const walletKey = String(walletPublicKey?.toString?.() || '');
  if (!walletKey) return;
  const allowed = new Set(
    (Array.isArray(allowedToPubkeys) ? allowedToPubkeys : [])
      .map((k) => String(k || ''))
      .filter(Boolean)
  );
  allowed.add(walletKey);

  const instructions = Array.isArray(tx?.instructions) ? tx.instructions : [];
  for (const ix of instructions) {
    const programId = String(ix?.programId?.toString?.() || '');
    if (programId !== SystemProgram.programId.toString()) continue;
    const accountPubkeys = getInstructionAccountPubkeys(ix);
    const fromPubkey = accountPubkeys[0] || '';
    const toPubkey = accountPubkeys[1] || '';
    const lamports = getTransferLamportsFromSystemInstruction(ix);
    if (!fromPubkey || !toPubkey || !Number.isFinite(lamports)) continue;
    if (fromPubkey !== walletKey) continue;
    if (lamports < minLamports) continue;
    if (allowed.has(toPubkey)) continue;
    if (isExpectedSolLiquidityTransfer({ txStage, lamports, expectedLiquidityLamports })) {
      console.log(
        `[evilPanda] EXPECTED_SOL_LIQUIDITY_TRANSFER_ALLOWED stage=${String(txStage || 'unknown')} lamports=${lamports}`
      );
      continue;
    }

    const err = new Error(
      `VETO_UNEXPECTED_SOL_TRANSFER: wallet->${toPubkey} lamports=${lamports}`
    );
    err.code = 'VETO_UNEXPECTED_SOL_TRANSFER';
    err.isPermanent = true;
    console.warn(
      `[evilPanda] UNEXPECTED_SOL_TRANSFER_VETO from=${walletKey.slice(0,8)} to=${toPubkey.slice(0,8)} ` +
      `lamports=${lamports} stage=${String(txStage || 'unknown')} reason=unexpected_wallet_transfer`
    );
    throw err;
  }

  if (tx instanceof VersionedTransaction) {
    const compiled = Array.isArray(tx?.message?.compiledInstructions)
      ? tx.message.compiledInstructions
      : [];
    const systemProgramId = SystemProgram.programId.toString();
    for (const cix of compiled) {
      const programIdIndex = Number(cix?.programIdIndex);
      const staticProgram = tx?.message?.staticAccountKeys?.[programIdIndex];
      const resolvedProgram = (() => {
        try {
          return tx?.message?.getAccountKeys?.().get?.(programIdIndex) || staticProgram;
        } catch {
          return staticProgram;
        }
      })();
      const programId = String(resolvedProgram?.toString?.() || '');
      if (programId !== systemProgramId) continue;
      const accountPubkeys = getCompiledInstructionAccountPubkeys(tx, cix);
      const fromPubkey = accountPubkeys[0] || '';
      const toPubkey = accountPubkeys[1] || '';
      const lamports = getTransferLamportsFromCompiledInstruction(cix);
      if (!fromPubkey || !toPubkey || !Number.isFinite(lamports) || lamports <= 0) continue;
      if (fromPubkey !== walletKey) continue;
      if (lamports < minLamports) continue;
      if (allowed.has(toPubkey)) continue;
      if (isExpectedSolLiquidityTransfer({ txStage, lamports, expectedLiquidityLamports })) {
        console.log(
          `[evilPanda] EXPECTED_SOL_LIQUIDITY_TRANSFER_ALLOWED stage=${String(txStage || 'unknown')} lamports=${lamports}`
        );
        continue;
      }
      const err = new Error(
        `VETO_UNEXPECTED_SOL_TRANSFER: wallet->${toPubkey} lamports=${lamports}`
      );
      err.code = 'VETO_UNEXPECTED_SOL_TRANSFER';
      err.isPermanent = true;
      console.warn(
        `[evilPanda] UNEXPECTED_SOL_TRANSFER_VETO from=${walletKey.slice(0,8)} to=${toPubkey.slice(0,8)} ` +
        `lamports=${lamports} stage=${String(txStage || 'unknown')} reason=unexpected_wallet_transfer`
      );
      throw err;
    }
  }
}

function wrapQuoteOnlySignerError({
  error,
  finalArgsContext = {},
  txStage = 'unknown',
  attemptedSigner = null,
} = {}) {
  const raw = String(error?.message || error || '');
  if (!/unknown signer/i.test(raw)) return error;
  const wrapped = buildInvalidDlmmArgsError(`quote-only transaction signer mismatch at ${txStage}: ${raw}`);
  wrapped.dlmmContextExtra = {
    ...(finalArgsContext || {}),
    sdkFlow: 'quote_only_position_first',
    txStage,
    attemptedSigner: attemptedSigner || extractUnknownSignerFromError(error),
  };
  return wrapped;
}

async function sendQuoteOnlyTxWithFilteredSigners({
  connection,
  wallet,
  tx,
  extraSigners = [],
  txStage = 'unknown',
  finalArgsContext = {},
  expectedLiquidityLamports = null,
} = {}) {
  assertNoUnexpectedSolTransferInTx({
    tx,
    walletPublicKey: wallet?.publicKey,
    txStage,
    expectedLiquidityLamports,
  });
  const filteredSigners = filterKnownTransactionSigners(tx, extraSigners, { txStage });
  try {
    if (tx instanceof VersionedTransaction) {
      tx.sign([wallet, ...filteredSigners]);
      return await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    }
    return await connection.sendTransaction(tx, [wallet, ...filteredSigners], { skipPreflight: false, maxRetries: 3 });
  } catch (sendErr) {
    const wrapped = wrapQuoteOnlySignerError({
      error: sendErr,
      finalArgsContext,
      txStage,
      attemptedSigner: extractUnknownSignerFromError(sendErr),
    });
    throw wrapped;
  }
}

async function sendSignedTx(connection, wallet, tx) {
  assertNoUnexpectedSolTransferInTx({
    tx,
    walletPublicKey: wallet?.publicKey,
    txStage: 'sendSignedTx',
  });
  if (tx instanceof VersionedTransaction) {
    tx.sign([wallet]);
    return await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  }
  return await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
}

async function sendExitTx(connection, wallet, tx, microLamports) {
  injectPriorityFee(tx, { units: EP_CONFIG.EXIT_COMPUTE_UNITS, microLamports });
  assertNoUnexpectedSolTransferInTx({
    tx,
    walletPublicKey: wallet?.publicKey,
    txStage: 'exit',
  });

  let sig;
  try {
    sig = await sendSignedTx(connection, wallet, tx);
  } catch (e) {
    logSendTxError('exit send failed', e);
    throw e;
  }

  await pollTxConfirm(connection, sig, 90_000);
  return sig;
}

async function sendCloseEmptyPositionTxs(connection, wallet, txOrTxs, microLamports) {
  const txList = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const sigs = [];
  for (const tx of txList) {
    if (!tx) continue;
    const sig = await sendExitTx(connection, wallet, tx, microLamports);
    sigs.push(sig);
  }
  if (sigs.length === 0) {
    throw new Error('CLOSE_EMPTY_POSITION_EMPTY_TX_LIST');
  }
  return sigs;
}

function isValidPublicKeyString(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    new PublicKey(text);
    return true;
  } catch {
    return false;
  }
}

async function getPositionAccountExists(connection, positionPubkey = '') {
  if (!connection || !isValidPublicKeyString(positionPubkey)) return null;
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(positionPubkey));
    return accountInfo !== null;
  } catch {
    return null;
  }
}

async function resolveInvalidTrackedPositionStatus({
  connection,
  positionPubkey = '',
  poolAddress = '',
  marker = null,
} = {}) {
  if (isValidPublicKeyString(poolAddress)) return null;

  const poolIssue = String(poolAddress || '').trim()
    ? 'POSITION_REGISTRY_POOL_INVALID'
    : 'POSITION_REGISTRY_POOL_MISSING';
  const accountExists = await getPositionAccountExists(connection, positionPubkey);

  if (marker && isBotQuoteOnlyPartialMarker(marker) && accountExists === false) {
    return {
      tracked: true,
      exists: false,
      hasLiquidity: false,
      manualWithdrawn: false,
      reason: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
      registryIssue: poolIssue,
    };
  }

  if (accountExists === false) {
    return {
      tracked: true,
      exists: false,
      hasLiquidity: false,
      manualWithdrawn: true,
      reason: poolIssue,
      registryIssue: poolIssue,
    };
  }

  return {
    tracked: true,
    exists: accountExists === true,
    hasLiquidity: false,
    manualWithdrawn: false,
    reason: poolIssue,
    registryIssue: poolIssue,
  };
}

async function getFreshActivePosition(connection, wallet, poolAddress, positionPubkey) {
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates().catch(() => {});
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const activePos = userPositions.find((p) => p.publicKey.toString() === positionPubkey);
  return { dlmmPool, activePos };
}

async function buildZapOutCloseTxs(dlmmPool, wallet, activePos) {
  const pd = activePos?.positionData || {};
  const lowerBinId = pd.lowerBinId;
  const upperBinId = pd.upperBinId;
  if (lowerBinId === undefined || upperBinId === undefined) {
    throw new Error(`ZAP_OUT_RANGE_UNAVAILABLE_${activePos?.publicKey?.toString?.().slice(0, 8) || 'UNKNOWN'}`);
  }

  const removeTxs = await dlmmPool.removeLiquidity({
    position: activePos.publicKey,
    user: wallet.publicKey,
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10000),
    shouldClaimAndClose: true,
  });
  const txList = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
  if (!txList.length) {
    throw new Error(`ZAP_OUT_EMPTY_TX_LIST_${activePos.publicKey.toString().slice(0, 8)}`);
  }
  return txList;
}

async function executeExitCloseWithZapPreferred({
  connection,
  wallet,
  dlmmPool,
  activePos,
  microLamports,
  removeSignatures,
  stage = 'primary',
  notifyOnFallback = true,
  fallbackMode = 'legacy',
} = {}) {
  try {
    const zapTxList = await buildZapOutCloseTxs(dlmmPool, wallet, activePos);
    for (const tx of zapTxList) {
      const sig = await sendExitTx(connection, wallet, tx, microLamports);
      removeSignatures.push(sig);
      console.log(`[evilPanda] ZAP_OUT TX confirmed (${stage}): ${sig.slice(0,8)}`);
    }
    return { path: 'ZAP_OUT', usedFallback: false, txCount: zapTxList.length };
  } catch (zapErr) {
    const zapReason = String(zapErr?.message || zapErr || 'UNKNOWN_ZAP_ERROR');
    console.warn(`[evilPanda] ZAP_OUT_FAIL stage=${stage} reason=${zapReason}`);

    if (fallbackMode === 'none') {
      throw buildPermanentExitError(
        `EXIT_ZAP_ONLY_FAILED stage=${stage} zap=${zapReason}`,
        'EXIT_ZAP_ONLY_FAILED'
      );
    }

    if (notifyOnFallback) {
      await notify(
        `⚠️ <b>Zap-Out gagal, fallback darurat aktif</b>\n` +
        `Stage: <code>${stage}</code>\n` +
        `Posisi: <code>${activePos.publicKey.toString().slice(0, 8)}</code>\n` +
        `Reason: <code>${escapeHTML(zapReason)}</code>`
      );
    }
    throw buildPermanentExitError(
      `EXIT_ZAP_ONLY_FAILED stage=${stage} zap=${zapReason}`,
      'EXIT_ZAP_ONLY_FAILED'
    );
  }
}

async function verifyPositionClosedOnChain(connection, wallet, poolAddress, positionPubkey, {
  attempts = 3,
  delayMs = 1200,
} = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const stillOpen = userPositions.some((p) => p.publicKey.toString() === positionPubkey);
      const accountInfo = await connection.getAccountInfo(new PublicKey(positionPubkey));
      if (!stillOpen && accountInfo === null) return true;
    } catch {
      // non-fatal during verification; retry a few times
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

async function estimateTxFeeLamports(connection, signatures = []) {
  let total = 0;
  for (const sig of signatures) {
    if (!sig) continue;
    try {
      const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      total += Number(tx?.meta?.fee || 0);
    } catch {
      // non-fatal
    }
  }
  return total;
}

// ── 1. deployPosition ─────────────────────────────────────────────

/**
 * Buka posisi DLMM Evil Panda (single-side SOL, 90% range di bawah harga aktif).
 *
 * @param {string} poolAddress  - Pubkey pool DLMM
 * @param {object} [deployOptions]
 * @param {boolean|null} [deployOptions.hasNonRefundableFees]
 * @returns {Promise<string>}   - positionPubkey (string)
 */
export async function deployPosition(poolAddress, deployOptions = {}) {
  const cfg        = getConfig();
  const deploySol  = cfg.deployAmountSol || 0.1;
  const connection = getConnection();
  const executionMode = normalizeExecutionMode(
    deployOptions?.executionMode || getNewEntryExecutionMode(cfg)
  );
  const paperMode = executionMode === 'paper';
  const wallet = paperMode ? null : getWallet();
  let deployBudgetReservation = null;
  if (!paperMode) {
    deployBudgetReservation = await reserveDeployBudgetAgainstWallet({
      connection,
      walletPublicKey: wallet.publicKey,
      deploySol,
      cfg,
      poolAddress,
      owner: 'deployPosition',
    });
    if (!deployBudgetReservation.ok) {
      const walletCheck = deployBudgetReservation.walletCheck || evaluateDeployWalletFunds({
        walletLamports: Number(deployBudgetReservation.walletLamports || 0),
        deploySol,
        cfg,
        reservedLamports: Number(deployBudgetReservation.reservedLamports || 0),
      });
      return buildInsufficientBalanceBlockedResult({
        walletCheck,
        poolAddress,
        strategyShape: normalizeDlmmLiquidityShape(cfg.dlmmLiquidityShape),
        strategyType: getDlmmStrategyTypeFromConfig(cfg),
      });
    }
  }
  const poolPubkey = new PublicKey(poolAddress);
  const hasNonRefundableFees = await resolveNonRefundableFeeFlag(
    poolAddress,
    deployOptions?.hasNonRefundableFees ?? null,
  );
  const frozenIntent = (deployOptions && typeof deployOptions.frozenEntryIntent === 'object')
    ? deployOptions.frozenEntryIntent
    : null;
  const frozenEntryActiveBin = isFiniteInteger(Number(frozenIntent?.entryActiveBin))
    ? Number(frozenIntent.entryActiveBin)
    : null;
  const frozenEntryPrice = toFiniteNumber(frozenIntent?.entryPrice, null);
  const frozenMaxDriftPct = Math.max(0.1, Number(frozenIntent?.maxDriftPct) || Number(cfg?.entryFreshBreakoutMaxDriftPct) || 8);
  const frozenIntentRequired = frozenIntent?.required === true;
  const frozenIntentEnabled = frozenIntent?.enabled === true &&
    Number.isFinite(frozenEntryActiveBin) &&
    Number.isFinite(frozenEntryPrice) &&
    frozenEntryPrice > 0;
  const finalTrendStamp = (deployOptions && typeof deployOptions.finalTrendStamp === 'object')
    ? deployOptions.finalTrendStamp
    : null;
  const finalTrendDirection = normalizeTrackedTrendDirection(finalTrendStamp?.direction);
  const finalTrendSource = String(finalTrendStamp?.source || 'unknown');
  const finalTrendReason = String(finalTrendStamp?.reason || '');
  const finalTrendAt = Number.isFinite(Number(finalTrendStamp?.checkedAt))
    ? Number(finalTrendStamp.checkedAt)
    : Date.now();
  const entryCanonicalSnapshot = (deployOptions && typeof deployOptions.entryCanonicalSnapshot === 'object')
    ? deployOptions.entryCanonicalSnapshot
    : null;

  console.log(`[evilPanda] ▶ deployPosition pool=${poolAddress.slice(0,8)} sol=${deploySol}`);

  try {
    return await withPermanentAwareBackoff(async () => {
      console.log('[evilPanda] TIP_TRANSFER_DISABLED');
      if (!paperMode) {
        await reconcileZombiePositions().catch((e) => {
          console.warn(`[evilPanda] Zombie reconcile non-fatal: ${e.message}`);
        });
      }

    if (!paperMode && hasTrackedPoolPosition(poolAddress)) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} already has an active or pending position`);
    }

    const dlmmPool  = await DLMM.create(connection, poolPubkey);
    await dlmmPool.refetchStates();
    const initialActiveBin = await dlmmPool.getActiveBin();
    const frozenIntentDecision = evaluateFrozenEntryIntentForDeploy({
      enabled: frozenIntentEnabled,
      frozenEntryActiveBin,
      frozenEntryPrice,
      frozenSnapshotAt: frozenIntent?.snapshotAt,
      liveActiveBinId: Number(initialActiveBin?.binId),
      livePrice: Number(initialActiveBin?.pricePerToken),
      binStep: Number(dlmmPool?.lbPair?.binStep || 0),
      maxDriftPct: frozenMaxDriftPct,
    });
    const shouldUseFrozenIntent = frozenIntentDecision.useFrozen === true;
    const frozenIntentEnabledForDeploy = shouldUseFrozenIntent;
    if (frozenIntentRequired && !shouldUseFrozenIntent) {
      const reason = `ENTRY_ANCHOR_UNSAFE: ${frozenIntentDecision.reason || 'unknown'} ` +
        `driftBins=${Number.isFinite(frozenIntentDecision?.driftBins) ? Number(frozenIntentDecision.driftBins) : 'na'} ` +
        `driftPct=${Number.isFinite(frozenIntentDecision?.driftPct) ? Number(frozenIntentDecision.driftPct).toFixed(3) : 'na'} ` +
        `ageMs=${Number.isFinite(frozenIntentDecision?.snapshotAgeMs) ? Number(frozenIntentDecision.snapshotAgeMs) : 'na'}`;
      console.warn(`[evilPanda] DEPLOY_BLOCK_FROZEN_ANCHOR_UNSAFE pool=${poolAddress.slice(0,8)} ${reason}`);
      return {
        blocked: true,
        reason: 'ENTRY_ANCHOR_UNSAFE',
        detail: reason,
      };
    }
    let activeBin = initialActiveBin;
    const anchorMetadata = {
      anchorSource: shouldUseFrozenIntent ? 'frozen' : 'live_fallback',
      anchorActiveBinId: shouldUseFrozenIntent ? Number(frozenEntryActiveBin) : Number(initialActiveBin?.binId),
      anchorPrice: shouldUseFrozenIntent
        ? (Number.isFinite(frozenEntryPrice) ? Number(frozenEntryPrice) : Number(initialActiveBin?.pricePerToken))
        : Number(initialActiveBin?.pricePerToken),
      anchorSnapshotAt: Number.isFinite(Number(frozenIntent?.snapshotAt)) ? Number(frozenIntent.snapshotAt) : null,
      anchorDriftBins: Number.isFinite(frozenIntentDecision?.driftBins) ? Number(frozenIntentDecision.driftBins) : null,
      anchorDriftPct: Number.isFinite(frozenIntentDecision?.driftPct) ? Number(frozenIntentDecision.driftPct) : null,
      anchorReason: shouldUseFrozenIntent
        ? 'frozen_entry_intent'
        : String(frozenIntentDecision?.reason || 'live_fallback'),
      rangeAdjustReason: null,
    };
    if (shouldUseFrozenIntent && Number.isFinite(frozenEntryActiveBin)) {
      activeBin = {
        ...initialActiveBin,
        binId: Number(frozenEntryActiveBin),
        pricePerToken: Number.isFinite(frozenEntryPrice)
          ? Number(frozenEntryPrice)
          : initialActiveBin?.pricePerToken,
      };
      console.log(
        `[evilPanda] ENTRY_INTENT_FROZEN pool=${poolAddress.slice(0,8)} ` +
        `bin=${Number(activeBin.binId)} price=${Number.isFinite(Number(activeBin.pricePerToken)) ? Number(activeBin.pricePerToken).toFixed(10) : 'na'} ` +
        `driftBins=${Number.isFinite(frozenIntentDecision?.driftBins) ? Number(frozenIntentDecision.driftBins) : 'na'} ` +
        `driftPct=${Number.isFinite(frozenIntentDecision?.driftPct) ? Number(frozenIntentDecision.driftPct).toFixed(3) : 'na'} ` +
        `ageMs=${Number.isFinite(frozenIntentDecision?.snapshotAgeMs) ? Number(frozenIntentDecision.snapshotAgeMs) : 'na'}`
      );
    } else {
      console.log(
        `[evilPanda] ENTRY_INTENT_LIVE_FALLBACK pool=${poolAddress.slice(0,8)} ` +
        `bin=${Number(initialActiveBin?.binId)} price=${Number.isFinite(Number(initialActiveBin?.pricePerToken)) ? Number(initialActiveBin.pricePerToken).toFixed(10) : 'na'} ` +
        `reason=${frozenIntentDecision.reason} driftBins=${Number.isFinite(frozenIntentDecision?.driftBins) ? Number(frozenIntentDecision.driftBins) : 'na'} ` +
        `driftPct=${Number.isFinite(frozenIntentDecision?.driftPct) ? Number(frozenIntentDecision.driftPct).toFixed(3) : 'na'} ` +
        `ageMs=${Number.isFinite(frozenIntentDecision?.snapshotAgeMs) ? Number(frozenIntentDecision.snapshotAgeMs) : 'na'}`
      );
    }
    const finalSyncMaxDriftPct = Math.max(
      0.1,
      Number(cfg?.entryFinalProximityMaxDriftPct) ||
      Number(frozenIntent?.maxDriftPct) ||
      Number(cfg?.entryFreshBreakoutMaxDriftPct) ||
      2.5
    );
    await dlmmPool.refetchStates();
    const finalSyncedActiveBin = await dlmmPool.getActiveBin();
    if (!isFiniteInteger(Number(finalSyncedActiveBin?.binId)) || !Number.isFinite(Number(finalSyncedActiveBin?.pricePerToken)) || Number(finalSyncedActiveBin?.pricePerToken) <= 0) {
      const reason = 'ENTRY_FINAL_SYNC_UNAVAILABLE: final active bin/price unavailable before range build';
      console.warn(`[evilPanda] DEPLOY_BLOCK_FINAL_SYNC_UNAVAILABLE pool=${poolAddress.slice(0,8)} ${reason}`);
      return {
        blocked: true,
        reason: 'ENTRY_FINAL_SYNC_UNAVAILABLE',
        detail: reason,
      };
    }
    const finalSyncDecision = evaluateFrozenEntryIntentForDeploy({
      enabled: true,
      frozenEntryActiveBin: Number(activeBin?.binId),
      frozenEntryPrice: Number(activeBin?.pricePerToken),
      frozenSnapshotAt: Date.now(),
      liveActiveBinId: Number(finalSyncedActiveBin?.binId),
      livePrice: Number(finalSyncedActiveBin?.pricePerToken),
      binStep: Number(dlmmPool?.lbPair?.binStep || 0),
      maxDriftPct: finalSyncMaxDriftPct,
      nowMs: Date.now(),
    });
    if (!finalSyncDecision.useFrozen) {
      const reason = `ENTRY_FINAL_SYNC_UNSAFE: ${finalSyncDecision.reason || 'unknown'} ` +
        `driftBins=${Number.isFinite(finalSyncDecision?.driftBins) ? Number(finalSyncDecision.driftBins) : 'na'} ` +
        `driftPct=${Number.isFinite(finalSyncDecision?.driftPct) ? Number(finalSyncDecision.driftPct).toFixed(3) : 'na'} ` +
        `limitPct=${finalSyncMaxDriftPct.toFixed(3)}`;
      console.warn(`[evilPanda] DEPLOY_BLOCK_FINAL_SYNC_UNSAFE pool=${poolAddress.slice(0,8)} ${reason}`);
      return {
        blocked: true,
        reason: 'ENTRY_FINAL_SYNC_UNSAFE',
        detail: reason,
      };
    }
    if (!shouldUseFrozenIntent) {
      activeBin = finalSyncedActiveBin;
      anchorMetadata.anchorSource = 'live_sync';
      anchorMetadata.anchorActiveBinId = Number(finalSyncedActiveBin.binId);
      anchorMetadata.anchorPrice = Number(finalSyncedActiveBin.pricePerToken);
    }
    anchorMetadata.anchorDriftBins = Number.isFinite(finalSyncDecision?.driftBins) ? Number(finalSyncDecision.driftBins) : anchorMetadata.anchorDriftBins;
    anchorMetadata.anchorDriftPct = Number.isFinite(finalSyncDecision?.driftPct) ? Number(finalSyncDecision.driftPct) : anchorMetadata.anchorDriftPct;
    anchorMetadata.anchorReason = shouldUseFrozenIntent ? 'frozen_entry_intent_final_sync_ok' : 'live_final_sync_ok';
    console.log(
      `[evilPanda] ENTRY_FINAL_SYNC_OK pool=${poolAddress.slice(0,8)} ` +
      `anchorBin=${Number(activeBin?.binId)} liveBin=${Number(finalSyncedActiveBin?.binId)} ` +
      `anchorPrice=${Number.isFinite(Number(activeBin?.pricePerToken)) ? Number(activeBin.pricePerToken).toFixed(10) : 'na'} ` +
      `livePrice=${Number.isFinite(Number(finalSyncedActiveBin?.pricePerToken)) ? Number(finalSyncedActiveBin.pricePerToken).toFixed(10) : 'na'} ` +
      `driftBins=${Number.isFinite(finalSyncDecision?.driftBins) ? Number(finalSyncDecision.driftBins) : 'na'} ` +
      `driftPct=${Number.isFinite(finalSyncDecision?.driftPct) ? Number(finalSyncDecision.driftPct).toFixed(3) : 'na'} ` +
      `limitPct=${finalSyncMaxDriftPct.toFixed(3)} source=${anchorMetadata.anchorSource}`
    );
    const binStep   = dlmmPool.lbPair.binStep;

    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();
    const [, yMeta] = await resolveTokens([xMint, yMint]);
    const yDecimals  = yMeta.decimals; // SOL = 9
    const isSOLPair  = yMint === WSOL_MINT;

    if (!isSOLPair) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} bukan SOL pair — Evil Panda hanya mendukung TOKEN/SOL`);
    }

    const cfg2 = getConfig();
    const { minOffset: deployRangeMinBinOffset, maxOffset: deployRangeMaxBinOffset, fallbackReason: rangeOffsetFallbackReason } =
      getConfiguredDeployRangeBinOffsets(cfg2);
    const rangeMaxBins = getConfiguredDeployRangeMaxBins();
    const relativeRange = buildActiveBinRelativeDeployRange({
      activeBinId: Number(activeBin?.binId),
      minOffset: deployRangeMinBinOffset,
      maxOffset: deployRangeMaxBinOffset,
      maxBins: rangeMaxBins,
    });

    let rangeMax = relativeRange.rangeMax;
    let rangeMin = relativeRange.rangeMin;
    let rentCheckedRangeMin = null;
    let rentCheckedRangeMax = null;

    const totalBins = rangeMax - rangeMin + 1;
    const { Keypair } = await import('@solana/web3.js');
    let microLamports = null;
    let posKp = paperMode ? null : Keypair.generate();
    let positionPubkey = posKp ? posKp.publicKey.toString() : null;
    const slippageBps   = Number(cfg2.slippageBps) || 250;
    const slippagePct   = slippageBps / 100;
    const totalLamports = Math.floor(deploySol * 1e9);
    const dlmmShapeDebug = getDlmmLiquidityShapeDebug(cfg2);
    const dlmmStrategyType = getDlmmStrategyTypeFromConfig(cfg2);
    const dlmmLiquidityShape = dlmmShapeDebug.normalized;
    if (!paperMode) {
      const walletLamports = await connection.getBalance(wallet.publicKey).catch(() => 0);
      const walletCheck = evaluateDeployWalletFunds({
        walletLamports,
        deploySol,
        cfg: cfg2,
        reservedLamports: getReservedDeployBudgetLamports({ excludeId: deployBudgetReservation?.id }),
      });
      if (!walletCheck.ok) {
        console.warn(
        `[evilPanda] DEPLOY_BLOCK_INSUFFICIENT_SOL pool=${poolAddress.slice(0,8)} ` +
        `available=${walletCheck.availableSol.toFixed(6)} required=${walletCheck.requiredSol.toFixed(6)} ` +
        `deploy=${walletCheck.deploySol.toFixed(6)} reserve=${walletCheck.gasReserveSol.toFixed(6)} ` +
        `shape=${dlmmLiquidityShape} strategyType=${dlmmStrategyType}`
        );
        return buildInsufficientBalanceBlockedResult({
          walletCheck,
          poolAddress,
          strategyShape: dlmmLiquidityShape,
          strategyType: dlmmStrategyType,
        });
      }
    }

    const seedPlan = deriveSpotBidAskSeedPlan({
      cfg: cfg2,
      activeBinId: Number(activeBin?.binId),
      rangeMin: Number(rangeMin),
      rangeMax: Number(rangeMax),
      totalLamports,
    });
    const shouldSeedTokenX = seedPlan.shouldSeedTokenX;
    const seedPct = seedPlan.seedPct;
    const seedLamports = seedPlan.seedLamports;

    if (!seedPlan.spotBidAskSeedEnabled && seedPlan.rangeIncludesActiveBin) {
      console.log(
        `[evilPanda] DLMM_SHAPE=${dlmmLiquidityShape} FULL_SOL pool=${poolAddress.slice(0,8)} ` +
        `range=[${rangeMin},${rangeMax}] active=${activeBin.binId}`
      );
    }

    console.log(
      `[evilPanda] DLMM_RANGE_ACTIVE_BIN pool=${poolAddress.slice(0,8)} ` +
      `active=${activeBin.binId} offsets=[${deployRangeMinBinOffset},${deployRangeMaxBinOffset}] ` +
      `desired=[${relativeRange.desiredRangeMin},${relativeRange.desiredRangeMax}] final=[${rangeMin},${rangeMax}] ` +
      `bins=${totalBins}` +
      (rangeOffsetFallbackReason ? ` fallback=${rangeOffsetFallbackReason}` : '')
    );

    console.log(
      `[evilPanda] DLMM_SHAPE_RUNTIME pool=${poolAddress.slice(0,8)} ` +
      `raw="${dlmmShapeDebug.raw}" normalized=${dlmmLiquidityShape} strategyType=${dlmmStrategyType}`
    );

    let rentGuardStatus = null;
    if (hasNonRefundableFees) {
      try {
        rentGuardStatus = await inspectRangeBinArrayInitStatus(connection, poolPubkey, rangeMin, rangeMax);
      } catch (e) {
        if (!String(e?.message || '').startsWith('BIN_ARRAY_RENT_REQUIRED')) {
          throw e;
        }
      }
    }

    if (hasNonRefundableFees && rentGuardStatus && !rentGuardStatus.unchecked && !rentGuardStatus.safe) {
      const rentAdjustedResult = await findAdaptiveRentFreeRange({
        connection,
        poolPubkey,
        desiredMin: rangeMin,
        desiredMax: rangeMax,
        maxBins: rangeMaxBins,
        initialStatus: rentGuardStatus,
      });

      const rentAdjusted = rentAdjustedResult?.adjusted || null;
      if (rentAdjusted) {
        const prevMin = rangeMin;
        const prevMax = rangeMax;
        rangeMin = rentAdjusted.rangeMin;
        rangeMax = rentAdjusted.rangeMax;
        anchorMetadata.rangeAdjustReason = 'rent_guard_precheck_adjust';
        const adjustedWidth = rangeMax - rangeMin + 1;
        console.warn(
          `[evilPanda] RANGE_ADJUSTED_FOR_RENT ${poolAddress.slice(0,8)} desired=[${prevMin},${prevMax}] adjusted=[${rangeMin},${rangeMax}] ` +
          `checkedArrays=${rentGuardStatus.checkedArrays || 0} maxBins=${rangeMaxBins}` +
          (rentAdjustedResult?.searchSlackArrays > 0
            ? ` searchSlack=${rentAdjustedResult.searchSlackArrays}`
            : '')
        );
        await notify(
          `↪️ <b>Range Disesuaikan</b>\n` +
          `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
          `Range awal: <code>${prevMin}-${prevMax}</code>\n` +
          `Range aman: <code>${rangeMin}-${rangeMax}</code>\n` +
          `Lebar: <code>${adjustedWidth} bin</code> | Max: <code>${rangeMaxBins} bin</code>\n` +
          `<i>Range awal menyentuh bin array baru, jadi bot stop lebih awal sebelum init posisi dan tidak membayar rent non-refundable.</i>`
        );
        rentCheckedRangeMin = rangeMin;
        rentCheckedRangeMax = rangeMax;
      } else {
        const detail = `BIN_ARRAY_RENT_REQUIRED: ${rentGuardStatus.uninitializedCount || 0} uninitialized bin array(s) in range [${rangeMin}, ${rangeMax}] — estimated non-refundable rent: ~${rentGuardStatus.estimatedRentSol || 'unknown'} SOL`;
        console.warn(`[evilPanda] VETO_NON_REFUNDABLE_RENT ${poolAddress.slice(0,8)} range=[${rangeMin},${rangeMax}] ${detail}`);
        return buildRentVetoResult({
          poolAddress,
          tokenXMint: xMint,
          symbol: poolAddress.slice(0, 8),
          detail,
          rangeMin,
          rangeMax,
          rangeMaxBins,
          source: 'DEPLOY_RENT_GUARD',
        });
      }
    }

    if (hasNonRefundableFees && !rentGuardStatus?.unchecked) {
      try {
        await assertRangeDoesNotRequireBinArrayInit(connection, poolPubkey, rangeMin, rangeMax);
        rentCheckedRangeMin = rangeMin;
        rentCheckedRangeMax = rangeMax;
      } catch (e) {
        if (String(e?.message || '').startsWith('BIN_ARRAY_RENT_REQUIRED')) {
          const detail = e.message;
          console.warn(`[evilPanda] VETO_NON_REFUNDABLE_RENT ${poolAddress.slice(0,8)} range=[${rangeMin},${rangeMax}] ${detail}`);
          return buildRentVetoResult({
            poolAddress,
            tokenXMint: xMint,
            symbol: poolAddress.slice(0, 8),
            detail,
            rangeMin,
            rangeMax,
            rangeMaxBins,
            source: 'DEPLOY_RENT_GUARD_ASSERT',
          });
        }
        throw e;
      }
    }

    let amountXBn     = new BN('0');
    let amountYBn     = new BN(String(totalLamports));

    async function swapSolToTokenX(amountLamports) {
      const seedAmount = String(amountLamports || '0');
      if (seedAmount === '0') {
        return { success: false, reason: 'ZERO_SEED' };
      }

      const apiBase = 'https://api.jup.ag/swap/v1';
      const apiKey = process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '';
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      };

      const preXRaw = BigInt(await getTokenBalanceRaw(xMint).catch(() => '0'));
      const quote = await getJupiterQuote(WSOL_MINT, xMint, seedAmount, slippageBps);
      if (!quote?.outAmount || String(quote.outAmount) === '0') {
        throw new Error('JUPITER_SEED_QUOTE_ZERO');
      }

      let priorityFeeLamports = 50000;
      try {
        const recommended = await getRecommendedPriorityFee([WSOL_MINT, xMint]);
        priorityFeeLamports = Math.max(priorityFeeLamports, Math.round(Number(recommended) * 1.5));
      } catch {
        // pakai default
      }

      const swapRes = await fetchWithTimeout(
        `${apiBase}/swap`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: priorityFeeLamports,
          }),
        },
        15000
      );

      if (!swapRes.ok) {
        const err = await swapRes.text().catch(() => swapRes.status);
        throw new Error(`Jupiter seed swap failed: ${err}`);
      }

      const { swapTransaction } = await swapRes.json();
      const txBuf = Buffer.from(swapTransaction, 'base64');
      const versionedTx = VersionedTransaction.deserialize(txBuf);
      versionedTx.sign([wallet]);

      const budgetCheck = checkGasGuard();
      if (!budgetCheck.allowed) {
        throw new Error(`TX_GUARD_BLOCKED: ${budgetCheck.reason}`);
      }

      const sig = await connection.sendRawTransaction(versionedTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      await pollTxConfirm(connection, sig);

      const postXRaw = BigInt(await getTokenBalanceRaw(xMint).catch(() => '0'));
      const gainedXRaw = postXRaw > preXRaw
        ? (postXRaw - preXRaw)
        : BigInt(String(quote.outAmount || '0'));

      return {
        success: true,
        txHash: sig,
        amountRaw: gainedXRaw.toString(),
        quotedOutRaw: String(quote.outAmount || '0'),
      };
    }

    if (!paperMode && shouldSeedTokenX && seedLamports >= 1_000_000 && seedLamports < totalLamports) {
      console.log(
        `[evilPanda] Spot/Bid-Ask seed enabled: ${seedPct}% SOL → TOKENX ` +
        `(seedLamports=${seedLamports}, range=[${rangeMin},${rangeMax}], active=${activeBin.binId})`
      );
      try {
        const seedSwap = await swapSolToTokenX(seedLamports);
        if (seedSwap?.success) {
          amountXBn = new BN(String(seedSwap.amountRaw || '0'));
          amountYBn = new BN(String(Math.max(0, totalLamports - seedLamports)));
        } else {
          console.warn(`[evilPanda] Seed swap fallback ke single-side SOL: ${seedSwap?.reason || 'SEED_SWAP_FAILED'}`);
          amountXBn = new BN('0');
          amountYBn = new BN(String(totalLamports));
        }
      } catch (e) {
        console.warn(`[evilPanda] Seed swap gagal, fallback single-side SOL: ${e.message}`);
        amountXBn = new BN('0');
        amountYBn = new BN(String(totalLamports));
      }
    } else if (paperMode && shouldSeedTokenX && seedLamports >= 1_000_000 && seedLamports < totalLamports) {
      console.log(
        `[DRY RUN] Spot/Bid-Ask seed planned: ${seedPct}% SOL → TOKENX ` +
        `(seedLamports=${seedLamports}, range=[${rangeMin},${rangeMax}], active=${activeBin.binId})`
      );
    }

    let deployArgs;
    try {
      deployArgs = buildDlmmDeployStrategyArgs({
        activeBinId: Number(activeBin?.binId),
        rangeMin: Number(rangeMin),
        rangeMax: Number(rangeMax),
        amountXBn,
        amountYBn,
        strategyType: dlmmStrategyType,
      });
    } catch (preflightErr) {
      console.error(
        `[evilPanda] DLMM_PRECHECK_FAIL pool=${poolAddress} active=${String(activeBin?.binId)} ` +
        `range=[${rangeMin},${rangeMax}] amountX=${amountXBn.toString()} amountY=${amountYBn.toString()} ` +
        `shouldSeedTokenX=${shouldSeedTokenX} seedSwapSucceeded=${amountXBn.gt(new BN('0'))} ` +
        `strategyType=${dlmmStrategyType} shapeRaw="${dlmmShapeDebug.raw}" ` +
        `shapeNormalized=${dlmmLiquidityShape} slippage=${slippagePct}% reason=${preflightErr.message}`
      );
      throw preflightErr;
    }

    const preRefreshRentGuard = await ensureFinalRentCheckedDeployArgs({
      hasNonRefundableFees,
      connection,
      poolPubkey,
      poolAddress,
      tokenXMint: xMint,
      symbol: poolAddress.slice(0, 8),
      activeBinId: Number(activeBin?.binId),
      rangeMaxBins,
      checkedRangeMin: rentCheckedRangeMin,
      checkedRangeMax: rentCheckedRangeMax,
      deployArgs,
    });
    if (!preRefreshRentGuard.ok) {
      console.warn(
        `[evilPanda] FINAL_RENT_GUARD_VETO pool=${poolAddress.slice(0,8)} ` +
        `reason=${preRefreshRentGuard.reason} range=[${preRefreshRentGuard.rangeMin},${preRefreshRentGuard.rangeMax}]`
      );
      return preRefreshRentGuard;
    }
    deployArgs = preRefreshRentGuard.deployArgs;

    if (paperMode) {
      const paperCanonicalEntrySnapshot = buildRuntimeCanonicalEntrySnapshot({
        baseSnapshot: entryCanonicalSnapshot,
        entryActiveBin: safeNum(activeBin.binId, null),
        entryPrice: safeNum(activeBin.pricePerToken, null),
        finalTrendStamp: {
          direction: finalTrendDirection,
          source: finalTrendSource,
          reason: finalTrendReason,
          checkedAt: finalTrendAt,
        },
        anchorMetadata,
        rangeAdjustReason: anchorMetadata.rangeAdjustReason || null,
      });
      console.log(
        `[PAPER] deploy plan ready pool=${poolAddress.slice(0,8)} ` +
        `range=[${Number(deployArgs.rangeMin)},${Number(deployArgs.rangeMax)}] active=${Number(deployArgs.activeBinId)}`
      );
      return {
        dryRun: true,
        paper: true,
        executionMode: 'paper',
        simulated: false,
        poolAddress,
        tokenXMint: xMint,
        tokenYMint: yMint,
        deploySol,
        rangeMin: Number(deployArgs.rangeMin),
        rangeMax: Number(deployArgs.rangeMax),
        entryActiveBin: safeNum(activeBin.binId, null),
        entryPrice: safeNum(activeBin.pricePerToken, null),
        binStep: Number(binStep || 0),
        liquidityShape: dlmmLiquidityShape,
        strategyType: dlmmStrategyType,
        amountXRaw: String(deployArgs.amountXBn?.toString?.() || '0'),
        amountYRaw: String(deployArgs.amountYBn?.toString?.() || '0'),
        seedPct: Number(seedPct || 0),
        entryCanonicalSnapshot: paperCanonicalEntrySnapshot,
        finalTrendStamp: {
          direction: finalTrendDirection,
          source: finalTrendSource,
          reason: finalTrendReason,
          checkedAt: finalTrendAt,
        },
      };
    }

    microLamports = await getPriorityFee();
    const buildPreparedAttemptState = async ({
      baseDeployArgs = {},
      currentRentGuard = null,
      attempt = 1,
    } = {}) => {
      return prepareFinalDlmmDeployAttemptState({
        dlmmPool,
        connection,
        poolPubkey,
        poolAddress,
        xMint,
        yMint,
        deployArgs: baseDeployArgs,
        currentRentGuard,
        hasNonRefundableFees,
        rangeMaxBins,
        checkedRangeMin: rentCheckedRangeMin,
        checkedRangeMax: rentCheckedRangeMax,
        initialActiveBinId: Number(initialActiveBin?.binId),
        attempt,
        skipActiveBinRefresh: frozenIntentEnabledForDeploy,
        anchorMetadata,
        refetchStatesFn: async () => {
          if (frozenIntentEnabledForDeploy) return;
          if (dlmmPool?.refetchStates) await dlmmPool.refetchStates();
        },
        getActiveBinFn: async () => {
          if (frozenIntentEnabledForDeploy) {
            return { binId: Number(baseDeployArgs?.activeBinId) };
          }
          const refreshed = dlmmPool?.getActiveBin ? await dlmmPool.getActiveBin() : null;
          if (refreshed && isFiniteInteger(Number(refreshed?.binId))) {
            activeBin = refreshed;
          }
          return refreshed;
        },
      });
    };

    const preparedAttempt1 = await buildPreparedAttemptState({
      baseDeployArgs: deployArgs,
      currentRentGuard: preRefreshRentGuard,
      attempt: 1,
    });
    preparedAttempt1.positionKeypair = posKp;
    preparedAttempt1.finalArgsContext = {
      ...(preparedAttempt1.finalArgsContext || {}),
      positionPubkey,
      expectedPositionOwner: String(dlmmPool?.program?.programId?.toString?.() || ''),
    };
    if (!preparedAttempt1.ok) {
      console.warn(
        `[evilPanda] FINAL_RENT_GUARD_VETO pool=${poolAddress.slice(0,8)} ` +
        `reason=${preparedAttempt1.reason} range=[${preparedAttempt1.rangeMin},${preparedAttempt1.rangeMax}] afterActiveRefresh=true attempt=1`
      );
      return preparedAttempt1;
    }

    let finalDeployState = preparedAttempt1;
    let txOrTxs;
    try {
      const executeResult = await executeDlmmInitializePositionWithRetry({
        initialState: preparedAttempt1,
        buildRetryStateFn: async ({ previousState }) => {
          console.warn(
            `[evilPanda] DLMM_INVALID_ARGS_RETRY pool=${poolAddress.slice(0,8)} ` +
            `range=[${Number(previousState?.deployArgs?.rangeMin)},${Number(previousState?.deployArgs?.rangeMax)}] active=${Number(previousState?.deployArgs?.activeBinId)}`
          );
          const retryPrepared = await buildPreparedAttemptState({
            baseDeployArgs: previousState?.deployArgs || deployArgs,
            currentRentGuard: previousState?.finalRentGuard || preRefreshRentGuard,
            attempt: 2,
          });
          const retryQuoteOnly = selectDlmmSdkPathForDeployArgs(retryPrepared?.deployArgs || {}) === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY;
          if (retryQuoteOnly) {
            posKp = Keypair.generate();
            positionPubkey = posKp.publicKey.toString();
          }
          retryPrepared.positionKeypair = posKp;
          retryPrepared.finalArgsContext = {
            ...(retryPrepared.finalArgsContext || {}),
            positionPubkey,
            expectedPositionOwner: String(dlmmPool?.program?.programId?.toString?.() || ''),
          };
          if (!retryPrepared.ok) {
            const vetoErr = new Error(`VETO_NON_REFUNDABLE_RENT_RETRY: ${retryPrepared?.reason || retryPrepared?.detail || 'unsafe retry range'}`);
            vetoErr.code = 'VETO_NON_REFUNDABLE_RENT';
            vetoErr.vetoResult = retryPrepared;
            throw vetoErr;
          }
          return retryPrepared;
        },
        sdkCallFn: async (state = {}) => {
          const args = state?.deployArgs || {};
          const strategy = state?.sdkStrategy || buildDlmmSdkStrategyFromDeployArgs(args);
          const sdkPath = selectDlmmSdkPathForDeployArgs(args);
          const statePositionKeypair = state?.positionKeypair || posKp;
          const statePositionPubkey = statePositionKeypair.publicKey.toString();
          state.finalArgsContext = {
            ...(state?.finalArgsContext || {}),
            sdkPath,
            positionPubkey: statePositionPubkey,
          };
          console.log(
            `[evilPanda] DLMM_SDK_PATH pool=${poolAddress.slice(0,8)} path=${sdkPath} ` +
            `attempt=${Number(state?.attempt || 0)} range=[${Number(args.rangeMin)},${Number(args.rangeMax)}]`
          );

          if (sdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY) {
            const distribution = buildQuoteOnlyWeightDistribution({
              rangeMin: Number(args.rangeMin),
              rangeMax: Number(args.rangeMax),
            });
            const totalYBps = distribution.reduce(
              (acc, item) => acc.add(item.yAmountBpsOfTotal),
              new BN('0')
            );
            state.finalArgsContext = {
              ...(state?.finalArgsContext || {}),
              sdkMethod: 'addLiquidityByWeight',
              sdkFlow: 'quote_only_position_first',
            };
            assertNoCombinedWeightForQuoteOnly({
              deployArgs: args,
              sdkPath,
              sdkMethod: 'addLiquidityByWeight',
            });
            console.log(
              `[evilPanda] DLMM_WEIGHT_DIST pool=${poolAddress.slice(0,8)} bins=${distribution.length} totalYBps=${totalYBps.toString()} ` +
              `attempt=${Number(state?.attempt || 0)}`
            );
            await guardDlmmCostBeforeSend({
              connection,
              poolPubkey,
              poolAddress,
              dlmmPool,
              deployArgs: args,
              sdkPath,
              txs: [],
              positionPubkey: statePositionPubkey,
              finalArgsContext: {
                ...(state?.finalArgsContext || {}),
                sdkPath,
                positionPubkey: statePositionPubkey,
              },
              strictPreflightVeto: true,
            });
            await ensurePositionOwnerPrecheck({
              connection,
              positionPubKey: statePositionKeypair.publicKey,
              expectedProgramId: dlmmPool?.program?.programId || null,
              context: {
                ...(state?.finalArgsContext || {}),
              },
            });
            let quoteOnlyFlowResult;
            try {
              quoteOnlyFlowResult = await executeQuoteOnlyPositionFirstFlow({
                dlmmPool,
                connection,
                walletPublicKey: wallet.publicKey,
                positionKeypair: statePositionKeypair,
                deployArgs: args,
                xYAmountDistribution: distribution,
                slippagePct,
                microLamports,
              finalArgsContext: state?.finalArgsContext || {},
              sendTxFn: async (tx) => {
                injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
                const sig = await sendQuoteOnlyTxWithFilteredSigners({
                  connection,
                  wallet,
                  tx,
                  extraSigners: [statePositionKeypair],
                  txStage: 'createPosition',
                  finalArgsContext: state?.finalArgsContext || {},
                });
                console.log(`[evilPanda] ✅ DLMM quote-only position init confirmed: ${sig.slice(0,8)} pos=${statePositionPubkey.slice(0,8)}`);
                return sig;
              },
              });
            } catch (quoteOnlyErr) {
              await handleQuoteOnlyPartialDeployFailure({
                connection,
                wallet,
                dlmmPool,
                poolAddress,
                positionPubkey: statePositionPubkey,
                microLamports,
                error: quoteOnlyErr,
              });
              throw quoteOnlyErr;
            }
            state.finalArgsContext = {
              ...(state?.finalArgsContext || {}),
              positionOwner: quoteOnlyFlowResult?.positionOwner || null,
              expectedPositionOwner: quoteOnlyFlowResult?.expectedPositionOwner || null,
            };
            return quoteOnlyFlowResult?.addTxOrTxs;
          }

          state.finalArgsContext = {
            ...(state?.finalArgsContext || {}),
            sdkMethod: 'initializePositionAndAddLiquidityByStrategy',
          };
          return dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: statePositionKeypair.publicKey,
            user: wallet.publicKey,
            totalXAmount: args.amountXBn,
            totalYAmount: args.amountYBn,
            strategy,
            slippage: slippagePct,
          });
        },
        wrapInvalidArgsFn: wrapDlmmSdkInvalidArgumentsError,
      });
      txOrTxs = executeResult.txOrTxs;
      finalDeployState = executeResult.state || preparedAttempt1;
    } catch (deployErr) {
      if (deployErr?.code === 'VETO_NON_REFUNDABLE_RENT' && deployErr?.vetoResult) {
        console.warn(
          `[evilPanda] FINAL_RENT_GUARD_VETO pool=${poolAddress.slice(0,8)} ` +
          `reason=${deployErr.vetoResult.reason} range=[${deployErr.vetoResult.rangeMin},${deployErr.vetoResult.rangeMax}] afterActiveRefresh=true attempt=2`
        );
        return deployErr.vetoResult;
      }
    if (deployErr?.isPermanent || deployErr?.code === 'INVALID_DLMM_DEPLOY_ARGS') {
      throw deployErr;
    }
    const insufficientLamports = extractInsufficientLamportsError(deployErr);
    if (insufficientLamports) {
      const availableSol = Number.isFinite(insufficientLamports.availableLamports)
        ? insufficientLamports.availableLamports / 1e9
        : null;
      const requiredSol = Number.isFinite(insufficientLamports.requiredLamports)
        ? insufficientLamports.requiredLamports / 1e9
        : null;
      const balanceErr = buildInvalidDlmmArgsError(
        `INSUFFICIENT_SOL_BALANCE: available=${availableSol !== null ? availableSol.toFixed(6) : 'unknown'} ` +
        `required=${requiredSol !== null ? requiredSol.toFixed(6) : 'unknown'} ` +
        `context=${JSON.stringify({
          ...(finalDeployState?.finalArgsContext || {}),
          attempt: 1,
          retryAttempt: 0,
        })}`
      );
      balanceErr.code = 'INSUFFICIENT_SOL_BALANCE';
      balanceErr.isPermanent = true;
      balanceErr.dlmmContextExtra = {
        ...(finalDeployState?.finalArgsContext || {}),
        attempt: 1,
        retryAttempt: 0,
        availableLamports: insufficientLamports.availableLamports,
        requiredLamports: insufficientLamports.requiredLamports,
      };
      throw balanceErr;
    }
    const wrappedInvalidArgs = wrapDlmmSdkInvalidArgumentsError({
      error: deployErr,
      finalArgsContext: {
          ...(finalDeployState?.finalArgsContext || {}),
          attempt: 1,
          retryAttempt: 0,
        },
      });
      if (wrappedInvalidArgs) {
        throw wrappedInvalidArgs;
      }
      console.error(`[evilPanda] ❌ Monolith deploy gagal: ${deployErr.message}`);
      throw deployErr;
    }

    deployArgs = finalDeployState.deployArgs;
    if (txOrTxs && typeof txOrTxs === 'object' && txOrTxs.quoteOnlyDryRunPlan) {
      return {
        dryRun: true,
        simulated: false,
        positionPubkey,
        poolAddress,
        rangeMin: Number(deployArgs.rangeMin),
        rangeMax: Number(deployArgs.rangeMax),
        quoteOnlyPlan: txOrTxs,
        txCount: 0,
      };
    }
    const safeRangeMin = Number(deployArgs.rangeMin);
    const safeRangeMax = Number(deployArgs.rangeMax);
    const finalSdkPath = selectDlmmSdkPathForDeployArgs(deployArgs);
    const txList = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    await guardDlmmCostBeforeSend({
      connection,
      poolPubkey,
      poolAddress,
      dlmmPool,
      deployArgs,
      sdkPath: finalSdkPath,
      txs: txList,
      positionPubkey,
      finalArgsContext: {
        ...(finalDeployState?.finalArgsContext || {}),
        sdkPath: finalSdkPath,
        positionPubkey,
      },
      cleanupFn: finalSdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY
        ? async () => {
          const vetoErr = buildInvalidDlmmArgsError('VETO_BIN_ARRAY_RENT_REQUIRED');
          vetoErr.dlmmContextExtra = {
            ...(finalDeployState?.finalArgsContext || {}),
            sdkPath: finalSdkPath,
            sdkFlow: 'quote_only_position_first',
            positionPubkey,
          };
          await handleQuoteOnlyPartialDeployFailure({
            connection,
            wallet,
            dlmmPool,
            poolAddress,
            positionPubkey,
            microLamports,
            error: vetoErr,
          });
        }
        : null,
    });

      const runtimeCanonicalEntrySnapshot = buildRuntimeCanonicalEntrySnapshot({
        baseSnapshot: entryCanonicalSnapshot,
        entryActiveBin: safeNum(activeBin.binId, null),
        entryPrice: safeNum(activeBin.pricePerToken, null),
        finalTrendStamp: {
          direction: finalTrendDirection,
          source: finalTrendSource,
          reason: finalTrendReason,
          checkedAt: finalTrendAt,
        },
        anchorMetadata: {
          anchorSource: finalDeployState?.finalArgsContext?.anchorSource || anchorMetadata.anchorSource,
          anchorActiveBinId: finalDeployState?.finalArgsContext?.anchorActiveBinId ?? anchorMetadata.anchorActiveBinId,
          anchorPrice: finalDeployState?.finalArgsContext?.anchorPrice ?? anchorMetadata.anchorPrice,
          anchorSnapshotAt: finalDeployState?.finalArgsContext?.anchorSnapshotAt ?? anchorMetadata.anchorSnapshotAt,
          anchorDriftBins: finalDeployState?.finalArgsContext?.anchorDriftBins ?? anchorMetadata.anchorDriftBins,
          anchorDriftPct: finalDeployState?.finalArgsContext?.anchorDriftPct ?? anchorMetadata.anchorDriftPct,
          anchorReason: finalDeployState?.finalArgsContext?.anchorReason || anchorMetadata.anchorReason,
          rangeAdjustReason: finalDeployState?.finalArgsContext?.rangeAdjustReason || null,
        },
        rangeAdjustReason: finalDeployState?.finalArgsContext?.rangeAdjustReason || null,
      });

      console.log(
        `[evilPanda] ENTRY_RUNTIME_CONTEXT pool=${poolAddress.slice(0,8)} ` +
        `canonicalEntryBin=${runtimeCanonicalEntrySnapshot.entryActiveBin ?? 'na'} ` +
        `canonicalEntryPrice=${Number.isFinite(Number(runtimeCanonicalEntrySnapshot.entryPrice)) ? Number(runtimeCanonicalEntrySnapshot.entryPrice).toFixed(10) : 'na'} ` +
        `finalTrend=${runtimeCanonicalEntrySnapshot.finalTrendStamp?.direction || 'UNKNOWN'} ` +
        `anchor=${runtimeCanonicalEntrySnapshot.runtimeAnchor?.source || 'unknown'} ` +
        `rangeAdjust=${runtimeCanonicalEntrySnapshot.runtimeAnchor?.rangeAdjustReason || 'none'}`
      );

      await setPositionLifecycle(positionPubkey, 'deploying', {
        executionMode: 'real',
        poolAddress,
        deploySol,
        deployedAt: nowIso(),
        tokenXMint: xMint,
        tokenYMint: yMint,
        rangeMin: safeRangeMin,
        rangeMax: safeRangeMax,
        entryActiveBin: safeNum(activeBin.binId, null),
        entryPrice: safeNum(activeBin.pricePerToken, null),
        entryAnchorSource: finalDeployState?.finalArgsContext?.anchorSource || anchorMetadata.anchorSource,
        entryAnchorBin: finalDeployState?.finalArgsContext?.anchorActiveBinId ?? anchorMetadata.anchorActiveBinId,
        entryAnchorPrice: finalDeployState?.finalArgsContext?.anchorPrice ?? anchorMetadata.anchorPrice,
        entryAnchorSnapshotAt: finalDeployState?.finalArgsContext?.anchorSnapshotAt ?? anchorMetadata.anchorSnapshotAt,
        entryAnchorDriftBins: finalDeployState?.finalArgsContext?.anchorDriftBins ?? anchorMetadata.anchorDriftBins,
        entryAnchorDriftPct: finalDeployState?.finalArgsContext?.anchorDriftPct ?? anchorMetadata.anchorDriftPct,
        entryAnchorReason: finalDeployState?.finalArgsContext?.anchorReason || anchorMetadata.anchorReason,
        entryFinalSupertrend15m: finalTrendDirection,
        entryFinalSupertrendSource: finalTrendSource,
        entryFinalSupertrendReason: finalTrendReason,
        entryFinalSupertrendAt: finalTrendAt,
        entryCanonicalSnapshot: runtimeCanonicalEntrySnapshot,
        entryOrigin: String(
          deployOptions?.entryOrigin ||
          runtimeCanonicalEntrySnapshot?.entryOrigin ||
          runtimeCanonicalEntrySnapshot?.source ||
          ''
        ),
        rangeAdjustReason: finalDeployState?.finalArgsContext?.rangeAdjustReason || null,
        hwmPct: 0,
      }, { flush: true });

      try {
        for (const tx of txList) {
          injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
          const sig = finalSdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY
            ? await sendQuoteOnlyTxWithFilteredSigners({
              connection,
              wallet,
              tx,
              extraSigners: [posKp],
              txStage: 'addLiquidity',
              expectedLiquidityLamports: Number(deployArgs?.amountYBn?.toString?.() || 0),
              finalArgsContext: {
                ...(finalDeployState?.finalArgsContext || {}),
                sdkPath: finalSdkPath,
                positionPubkey,
              },
            })
            : await connection.sendTransaction(tx, [wallet, posKp], { skipPreflight: false, maxRetries: 3 });
          await pollTxConfirm(connection, sig);
          console.log(`[evilPanda] ✅ Monolith position deployed on-chain: ${sig.slice(0,8)}`);
        }
      } catch (sendErr) {
        if (finalSdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY) {
          await handleQuoteOnlyPartialDeployFailure({
            connection,
            wallet,
            dlmmPool,
            poolAddress,
            positionPubkey,
            microLamports,
            error: sendErr,
          });
        }
        throw sendErr;
      }

      if (finalSdkPath === DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY) {
        const liquidityCheck = await verifyQuoteOnlyLiquidityOnChain({
          connection,
          wallet,
          poolAddress,
          positionPubkey,
        });
        if (liquidityCheck.confirmed) {
          markQuoteOnlyLiquidityConfirmed({
            positionPubkey,
            poolAddress,
            tokenXMint: xMint,
          });
        } else {
          const verifyErr = buildInvalidDlmmArgsError('quote-only add-liquidity tx confirmed but on-chain position liquidity is empty');
          verifyErr.dlmmContextExtra = {
            ...(finalDeployState?.finalArgsContext || {}),
            sdkPath: DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY,
            sdkFlow: 'quote_only_position_first',
            sdkMethod: 'addLiquidityByWeight',
            positionPubkey,
            liquidityVerificationFailed: true,
          };
          await handleQuoteOnlyPartialDeployFailure({
            connection,
            wallet,
            dlmmPool,
            poolAddress,
            positionPubkey,
            microLamports,
            error: verifyErr,
          });
          throw verifyErr;
        }
      }

    await setPositionLifecycle(positionPubkey, 'open', {
      executionMode: 'real',
      poolAddress,
      deploySol,
      deployedAt:  nowIso(),
      tokenXMint:  xMint,
      tokenYMint:  yMint,
      rangeMin: safeRangeMin,
      rangeMax: safeRangeMax,
      entryActiveBin: safeNum(activeBin.binId, null),
      entryPrice: safeNum(activeBin.pricePerToken, null),
      entryAnchorSource: finalDeployState?.finalArgsContext?.anchorSource || anchorMetadata.anchorSource,
      entryAnchorBin: finalDeployState?.finalArgsContext?.anchorActiveBinId ?? anchorMetadata.anchorActiveBinId,
      entryAnchorPrice: finalDeployState?.finalArgsContext?.anchorPrice ?? anchorMetadata.anchorPrice,
      entryAnchorSnapshotAt: finalDeployState?.finalArgsContext?.anchorSnapshotAt ?? anchorMetadata.anchorSnapshotAt,
      entryAnchorDriftBins: finalDeployState?.finalArgsContext?.anchorDriftBins ?? anchorMetadata.anchorDriftBins,
      entryAnchorDriftPct: finalDeployState?.finalArgsContext?.anchorDriftPct ?? anchorMetadata.anchorDriftPct,
      entryAnchorReason: finalDeployState?.finalArgsContext?.anchorReason || anchorMetadata.anchorReason,
      entryFinalSupertrend15m: finalTrendDirection,
      entryFinalSupertrendSource: finalTrendSource,
      entryFinalSupertrendReason: finalTrendReason,
      entryFinalSupertrendAt: finalTrendAt,
      entryCanonicalSnapshot: runtimeCanonicalEntrySnapshot,
      entryOrigin: String(
        deployOptions?.entryOrigin ||
        runtimeCanonicalEntrySnapshot?.entryOrigin ||
        runtimeCanonicalEntrySnapshot?.source ||
        ''
      ),
      rangeAdjustReason: finalDeployState?.finalArgsContext?.rangeAdjustReason || null,
      hwmPct:      0,
    }, { flush: true });
    recordPoolDeploy({
      key: xMint || poolAddress,
      pool: { tokenXMint: xMint, poolAddress, address: poolAddress },
      reason: 'POSITION_OPEN',
      source: 'EVIL_PANDA',
    });

    console.log(`[evilPanda] ✅ Position open: ${positionPubkey.slice(0,8)}`);
    clearQuoteOnlyDeployMarker(positionPubkey);
    return positionPubkey;

    }, { maxRetries: 3, baseDelay: 3000, maxDelay: 12_000 });
  } finally {
    if (deployBudgetReservation?.id) {
      releaseDeployBudget(deployBudgetReservation.id);
    }
  }
}

// ── Meridian Exit Signal Fetcher ──────────────────────────────────
//
// Ambil RSI(2), Bollinger Bands, dan MACD dari Meridian chart-indicators API.
// Interval: 15_MINUTE, rsiLength: 2 (ultra-sensitive overbought detector).
// Fail-open: jika API error, return null → caller tetap HOLD.

/**
 * @typedef {Object} ExitSignal
 * @property {number|null} rsi          - RSI(2) value
 * @property {number|null} close        - Harga close candle terakhir
 * @property {number|null} bbUpper      - Bollinger Band upper
 * @property {number|null} macdHist     - MACD histogram (positif = hijau)
 * @property {string}      direction    - Supertrend direction
 * @property {string}      raw          - Raw reason string
 */

async function fetchExitSignal(tokenXMint) {
  const cfg     = getConfig();
  const apiBase = String(cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api').replace(/\/+$/, '');
  const apiKey  = cfg.publicApiKey || '';

  const params = new URLSearchParams({
    interval:  '15_MINUTE',
    candles:   '50',
    rsiLength: '2',
  });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const res = await fetchWithTimeout(
      `${apiBase}/chart-indicators/${tokenXMint}?${params.toString()}`,
      { headers },
      8000
    );

    if (!res.ok) {
      console.warn(`[evilPanda] Exit signal API ${res.status} — fail-open (HOLD)`);
      return null;
    }

    const data = await res.json();
    const latest = data?.latest || {};

    // Extract fields sesuai struktur Meridian buildSignalSummary
    const rsi      = safeNum(latest?.rsi?.value);                  // RSI(2)
    const close    = safeNum(latest?.candle?.close);               // Harga close
    const bbUpper  = safeNum(latest?.bollinger?.upper);            // BB upper band
    // MACD: Meridian returns latest.macd.histogram
    const macdHist = safeNum(latest?.macd?.histogram              // preferred field
      ?? latest?.macd?.hist                                        // alt field
      ?? latest?.macd?.value);                                     // fallback
    const direction = String(latest?.supertrend?.direction || 'unknown');

    console.log(`[evilPanda] 📡 ExitSignal RSI=${rsi?.toFixed(1)} close=${close?.toFixed(6)} BB_upper=${bbUpper?.toFixed(6)} MACD_hist=${macdHist?.toFixed(6)} ST=${direction}`);

    return { rsi, close, bbUpper, macdHist, direction };

  } catch (e) {
    console.warn(`[evilPanda] fetchExitSignal error: ${e.message} — fail-open (HOLD)`);
    return null;
  }
}

// ── Exit Decision Engine ──────────────────────────────────────────
//
// Skenario A: RSI(2) >= 90 DAN Close >= BB_Upper
// Skenario B: RSI(2) >= 90 DAN MACD Histogram > 0 (bar hijau pertama)
// Jika sinyal tidak tersedia (null) → HOLD, jangan exit karena API down.

function evaluateExitSignal(signal) {
  if (!signal) return { shouldExit: false, scenario: null, reason: 'Signal unavailable — HOLD' };

  const { rsi, close, bbUpper, macdHist, direction } = signal;
  const threshold = getConfiguredSmartExitRsi();

  const rsiOverbought = rsi != null && rsi >= threshold;

  // Skenario A: RSI overbought + harga menyentuh/melewati BB upper
  if (rsiOverbought && close != null && bbUpper != null && close >= bbUpper) {
    return {
      shouldExit: true,
      scenario:   'A',
      reason:     `RSI(2)=${rsi?.toFixed(1)}≥${threshold} + Close=${close?.toFixed(6)}≥BB_Upper=${bbUpper?.toFixed(6)}`,
    };
  }

  // Skenario B: RSI overbought + MACD histogram positif (bar hijau)
  if (rsiOverbought && macdHist != null && macdHist > 0) {
    return {
      shouldExit: true,
      scenario:   'B',
      reason:     `RSI(2)=${rsi?.toFixed(1)}≥${threshold} + MACD_hist=${macdHist?.toFixed(6)}>0`,
    };
  }

  // Skenario C: Market Structure Break — Supertrend berbalik BEARISH
  // Supertrend flip = support jebol, jangan tunggu RSI overbought.
  // Exit segera untuk hindari kerugian lebih dalam.
  if (direction && direction.toLowerCase() === 'bearish') {
    return {
      shouldExit: true,
      scenario:   'C',
      reason:     'Struktur Support Jebol (Supertrend = BEARISH)',
    };
  }

  return {
    shouldExit: false,
    scenario:   null,
    reason:     `RSI=${rsi?.toFixed(1) ?? 'n/a'} — kondisi exit belum terpenuhi`,
  };
}

function evaluateAgentDefensiveTaExit(signal, { ageMs = 0 } = {}) {
  if (!signal) {
    return { shouldExit: false, scenario: null, reason: 'Signal unavailable — HOLD' };
  }

  const { rsi, close, bbUpper, macdHist, direction } = signal;
  if (String(direction || '').toLowerCase() !== 'bearish') {
    return {
      shouldExit: false,
      scenario: null,
      reason: `Defensive TA inactive: Supertrend=${String(direction || 'unknown').toUpperCase()}`,
    };
  }

  if (ageMs < DEFENSIVE_EXIT_MIN_POSITION_AGE_MS) {
    return {
      shouldExit: false,
      scenario: null,
      reason: `Defensive TA armed but position age ${Math.round(ageMs / 1000)}s < ${Math.round(DEFENSIVE_EXIT_MIN_POSITION_AGE_MS / 1000)}s minimum`,
    };
  }

  const threshold = getConfiguredSmartExitRsi();
  const rsiOverbought = rsi != null && rsi >= threshold;

  if (rsiOverbought && close != null && bbUpper != null && close >= bbUpper) {
    return {
      shouldExit: true,
      scenario: 'A',
      reason: `Bearish ST + RSI(2)=${rsi?.toFixed(1)}≥${threshold} + Close=${close?.toFixed(6)}≥BB_Upper=${bbUpper?.toFixed(6)}`,
    };
  }

  if (rsiOverbought && macdHist != null && macdHist > 0) {
    return {
      shouldExit: true,
      scenario: 'B',
      reason: `Bearish ST + RSI(2)=${rsi?.toFixed(1)}≥${threshold} + MACD_hist=${macdHist?.toFixed(6)}>0`,
    };
  }

  return {
    shouldExit: false,
    scenario: null,
    reason: `Bearish ST active but TA confirmation not met (RSI=${rsi?.toFixed(1) ?? 'n/a'})`,
  };
}

export async function getAgentDefensiveExitDecision(tokenXMint, { ageMs = 0 } = {}) {
  const signal = await fetchExitSignal(tokenXMint);
  return evaluateAgentDefensiveTaExit(signal, { ageMs });
}

function evaluateDefensiveExitConfirmation({
  reg = {},
  exitDecision = null,
  ageMs = 0,
  inRange = false,
  outOfRangeSide = 'UNKNOWN',
  nowMs = Date.now(),
} = {}) {
  const isBearishDefensiveExit = exitDecision?.shouldExit === true && exitDecision?.scenario === 'C';
  if (!isBearishDefensiveExit) {
    if (reg && typeof reg === 'object') delete reg.defensiveExitBearishSince;
    return { allowExit: Boolean(exitDecision?.shouldExit), holdReason: null, bearishSinceMs: null };
  }

  const previousSinceMs = Number(reg?.defensiveExitBearishSince || 0);
  const bearishSinceMs = previousSinceMs > 0 ? previousSinceMs : nowMs;
  if (reg && typeof reg === 'object') reg.defensiveExitBearishSince = bearishSinceMs;
  const bearishAgeMs = Math.max(0, nowMs - bearishSinceMs);
  if (inRange === true) {
    return {
      allowExit: false,
      holdReason: 'Defensive exit hold: position still in range',
      bearishSinceMs,
    };
  }
  if (String(outOfRangeSide || '').toUpperCase() === 'HIGH') {
    return {
      allowExit: false,
      holdReason: 'Defensive exit hold: out of range high is not a defensive-exit condition',
      bearishSinceMs,
    };
  }
  if (String(outOfRangeSide || '').toUpperCase() !== 'LOW') {
    return {
      allowExit: false,
      holdReason: 'Defensive exit hold: waiting confirmed out-of-range low condition',
      bearishSinceMs,
    };
  }
  const canonicalEntry = readCanonicalEntryContext(reg);
  const entryFinalTrend = canonicalEntry.entryFinalTrend;
  const entryFinalTrendSource = canonicalEntry.entryFinalTrendSource;
  const entryFinalTrendAt = canonicalEntry.entryFinalTrendAt;
  const entryFinalTrendAgeMs = entryFinalTrendAt !== null
    ? Math.max(0, nowMs - entryFinalTrendAt)
    : null;
  const hasCanonicalBullishEntryStamp =
    entryFinalTrend === 'BULLISH' &&
    (entryFinalTrendSource === 'fresh_fetch' || entryFinalTrendSource === 'cache:fresh_fetch');

  if (hasCanonicalBullishEntryStamp && entryFinalTrendAgeMs !== null && entryFinalTrendAgeMs < DEFENSIVE_EXIT_CONFIRM_MS) {
    return {
      allowExit: false,
      holdReason:
        `Defensive exit hold: entry bullish confirmation ${Math.round(entryFinalTrendAgeMs / 1000)}s < ${Math.round(DEFENSIVE_EXIT_CONFIRM_MS / 1000)}s`,
      bearishSinceMs,
    };
  }

  if (ageMs < DEFENSIVE_EXIT_MIN_POSITION_AGE_MS) {
    return {
      allowExit: false,
      holdReason: `Defensive exit hold: position age ${Math.round(ageMs / 1000)}s < ${Math.round(DEFENSIVE_EXIT_MIN_POSITION_AGE_MS / 1000)}s minimum`,
      bearishSinceMs,
    };
  }

  if (bearishAgeMs < DEFENSIVE_EXIT_CONFIRM_MS) {
    return {
      allowExit: false,
      holdReason: `Defensive exit hold: bearish confirmation ${Math.round(bearishAgeMs / 1000)}s < ${Math.round(DEFENSIVE_EXIT_CONFIRM_MS / 1000)}s`,
      bearishSinceMs,
    };
  }

  return { allowExit: true, holdReason: null, bearishSinceMs };
}

// ── 2. monitorPnL ─────────────────────────────────────────────────

/**
 * @typedef {Object} PnLStatus
 * @property {'HOLD'|'TAKE_PROFIT'|'STOP_LOSS'|'MAX_HOLD'|'MANUAL_CLOSED'|'ERROR'} action
 * @property {number}  currentValueSol
 * @property {number}  pnlPct
 * @property {boolean} inRange
 * @property {string}  [exitScenario]  - 'A' atau 'B' jika exit dipicu TA
 * @property {string}  [exitReason]    - Human-readable reason
 */

/**
 * Poll on-chain + Meridian TA sekali, tentukan action.
 * Priority: Hard SL config > MaxHold config > Trailing take-profit.
 * Agent-managed positions stay trailing-first, but can arm a defensive TA exit
 * after Supertrend 15m turns bearish and deterministic TA confirmation appears.
 *
 * @param {string} positionPubkey
 * @returns {Promise<PnLStatus>}
 */
export async function monitorPnL(positionPubkey) {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) {
    return { action: 'ERROR', currentValueSol: 0, pnlPct: 0, feePnlSol: 0, feePnlPct: 0, feePnlSource: 'none', inRange: false,
             feePnlAvailable: false,
             error: `Position ${positionPubkey.slice(0,8)} not in registry` };
  }

  try {
    const cfg = getConfig();
    const manualTaExitEnabled = isManualTaExitPosition(reg, cfg);
    const connection = getConnection();
    const wallet     = getWallet();
    const marker = getQuoteOnlyDeployMarker(positionPubkey);
    const invalidRegistryStatus = await resolveInvalidTrackedPositionStatus({
      connection,
      positionPubkey,
      poolAddress: reg?.poolAddress || '',
      marker,
    });
    if (invalidRegistryStatus) {
      if (invalidRegistryStatus.reason === 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION') {
        await unlockFailedEmptyDeployPosition(positionPubkey, {
          reason: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
          cleanupStatus: invalidRegistryStatus.registryIssue || invalidRegistryStatus.reason,
        });
        return {
          action: 'HOLD',
          currentValueSol: 0,
          pnlPct: 0,
          feePnlSol: 0,
          feePnlPct: 0,
          feePnlSource: 'none',
          feePnlAvailable: false,
          inRange: false,
          note: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
        };
      }
      if (invalidRegistryStatus.manualWithdrawn) {
        console.log(
          `[evilPanda] ℹ️ Manual close terdeteksi via registry recovery: ${positionPubkey.slice(0,8)} ` +
          `reason=${invalidRegistryStatus.reason}`
        );
        return {
          action: 'MANUAL_CLOSED',
          currentValueSol: 0,
          pnlPct: 0,
          feePnlSol: 0,
          feePnlPct: 0,
          feePnlSource: 'none',
          feePnlAvailable: false,
          inRange: false,
          note: invalidRegistryStatus.reason,
        };
      }
      return {
        action: 'ERROR',
        currentValueSol: 0,
        pnlPct: 0,
        feePnlSol: 0,
        feePnlPct: 0,
        feePnlSource: 'none',
        feePnlAvailable: false,
        inRange: false,
        error: invalidRegistryStatus.reason,
      };
    }
    const safePoolAddress = String(reg?.poolAddress || '').trim();
    // ── On-chain: ambil nilai posisi saat ini ──────────────────────
    const dlmmPool   = await DLMM.create(connection, new PublicKey(safePoolAddress));
    const activeBin  = await dlmmPool.getActiveBin();

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

    if (!activePos) {
      const marker = getQuoteOnlyDeployMarker(positionPubkey);
      if (marker && isBotQuoteOnlyPartialMarker(marker)) {
        await unlockFailedEmptyDeployPosition(positionPubkey, {
          reason: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
          cleanupStatus: marker?.cleanupStatus || 'POSITION_NOT_FOUND_ON_CHAIN',
        });
        return {
          action: 'HOLD',
          currentValueSol: 0,
          pnlPct: 0,
          feePnlSol: 0,
          feePnlPct: 0,
          feePnlSource: 'none',
          feePnlAvailable: false,
          inRange: false,
          note: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
        };
      }
      console.log(`[evilPanda] ℹ️ Manual close terdeteksi on-chain: ${positionPubkey.slice(0,8)}`);
      return {
        action: 'MANUAL_CLOSED',
        currentValueSol: 0,
        pnlPct: 0,
        feePnlSol: 0,
        feePnlPct: 0,
        feePnlSource: 'none',
        feePnlAvailable: false,
        inRange: false,
        note: 'Position not found on-chain — assumed manually withdrawn',
      };
    }

    const pd       = activePos.positionData;
    const rawPrice = safeNum(activeBin.pricePerToken);

    const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
    const xDec = xMeta.decimals || 9;
    const yDec = yMeta.decimals || 9;

    const totalXUi = Number(pd.totalXAmount?.toString() || '0') / Math.pow(10, xDec);
    const totalYUi = Number(pd.totalYAmount?.toString() || '0') / Math.pow(10, yDec);
    const feeXUi   = Number(pd.feeX?.toString() || '0')         / Math.pow(10, xDec);
    const feeYUi   = Number(pd.feeY?.toString() || '0')         / Math.pow(10, yDec);
    const totalXRawToSell = Math.floor((totalXUi + feeXUi) * Math.pow(10, xDec)).toString();

    const inRange = activeBin.binId >= reg.rangeMin && activeBin.binId <= reg.rangeMax;
    const outOfRangeSide = inRange
      ? 'IN_RANGE'
      : activeBin.binId < reg.rangeMin
        ? 'LOW'
        : activeBin.binId > reg.rangeMax
          ? 'HIGH'
          : 'UNKNOWN';
    const fastValueSnapshot = await estimatePositionValueSolFromPositionData({
      positionData: pd,
      tokenXMint: reg.tokenXMint,
      xDec,
      yDec,
      activeBinPrice: rawPrice,
      quoteFn: null,
    });
    const fastCurrentValueSol = fastValueSnapshot.positionValueSol;
    const fastPnlPct = reg.deploySol > 0
      ? ((fastCurrentValueSol - reg.deploySol) / reg.deploySol) * 100
      : 0;
    const stopLossPct = getConfiguredStopLossPct();
    const maxHoldHours = getConfiguredMaxHoldHours();
    const trailingStopPct = getConfiguredTrailingStopPct();
    const trailingTriggerPct = getConfiguredTrailingTriggerPct();
    const trailingDropPct = getConfiguredTrailingDropPct();
    const deployedAtMs = reg.deployedAt ? new Date(reg.deployedAt).getTime() : null;
    const ageMs = Number.isFinite(deployedAtMs) ? Math.max(0, Date.now() - deployedAtMs) : 0;
    const maxHoldMs = maxHoldHours * 60 * 60 * 1000;
    if (fastPnlPct <= -stopLossPct) {
      console.log(`[evilPanda] 🛑 STOP_LOSS ${positionPubkey.slice(0,8)} pnl=${fastPnlPct.toFixed(2)}% (fast path)`);
      return {
        action: 'STOP_LOSS',
        currentValueSol: fastCurrentValueSol,
        pnlPct: fastPnlPct,
        feePnlSol: 0,
        feePnlPct: 0,
        feePnlSource: 'fast_path',
        feePnlAvailable: false,
        inRange,
        exitReason: `Hard SL fast path: PnL=${fastPnlPct.toFixed(2)}% ≤ -${stopLossPct}%`,
      };
    }

    if (maxHoldMs > 0 && ageMs >= maxHoldMs) {
      const ageHours = ageMs / (60 * 60 * 1000);
      console.log(`[evilPanda] ⏰ MAX_HOLD ${positionPubkey.slice(0,8)} age=${ageHours.toFixed(2)}h limit=${maxHoldHours}h (fast path)`);
      return {
        action: 'MAX_HOLD',
        currentValueSol: fastCurrentValueSol,
        pnlPct: fastPnlPct,
        feePnlSol: 0,
        feePnlPct: 0,
        feePnlSource: 'fast_path',
        feePnlAvailable: false,
        inRange,
        exitReason: `Max hold fast path: age=${ageHours.toFixed(2)}h ≥ ${maxHoldHours}h`,
      };
    }

    if (fastPnlPct > reg.hwmPct) {
      reg.hwmPct = fastPnlPct;
      console.log(`[evilPanda] 📈 New HWM: ${reg.hwmPct.toFixed(2)}%`);
    }

    let currentValueSol = 0;
    try {
      if (totalXRawToSell !== '0') {
        const quote = await getJupiterQuote(reg.tokenXMint, WSOL_MINT, totalXRawToSell);
        const jupOutSol = Number(quote.outAmount) / Math.pow(10, yDec);
        currentValueSol = totalYUi + feeYUi + jupOutSol;
      } else {
        currentValueSol = totalYUi + feeYUi;
      }
    } catch (jupErr) {
      console.warn(`[evilPanda] Jupiter Quote API error, fallback ke pool bin price: ${jupErr.message}`);
      currentValueSol = totalYUi + feeYUi + (totalXUi + feeXUi) * rawPrice;
    }

    const pnlPct = reg.deploySol > 0
      ? ((currentValueSol - reg.deploySol) / reg.deploySol) * 100
      : 0;
    const canonicalEntry = readCanonicalEntryContext(reg);
    const entryActiveBin = canonicalEntry.entryActiveBin;
    const entryPrice = canonicalEntry.entryPrice;
  const feeOnlyPnl = await calculateFeeOnlyPnl({
      feeXRaw: pd.feeX?.toString() || '0',
      feeYRaw: pd.feeY?.toString() || '0',
      xDec,
      yDec,
      tokenXMint: reg.tokenXMint,
      deploySol: reg.deploySol,
      activeBinPrice: rawPrice,
      quoteFn: null,
    });

    reg.currentValueSol = currentValueSol;
    reg.pnlPct = pnlPct;
    reg.feePnlSol = feeOnlyPnl.feePnlSol;
    reg.feePnlPct = feeOnlyPnl.feePnlPct;
    reg.feePnlAvailable = feeOnlyPnl.feePnlAvailable === true;
    reg.feePnlSource = feeOnlyPnl.feePnlSource;

    // ── PRIORITAS 1: Hard Stop Loss ───────────────────────────────────────
    if (pnlPct <= -stopLossPct) {
      console.log(`[evilPanda] 🛑 STOP_LOSS ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}%`);
      return { action: 'STOP_LOSS', currentValueSol, pnlPct, ...feeOnlyPnl, inRange,
               exitReason: `Hard SL: PnL=${pnlPct.toFixed(2)}% ≤ -${stopLossPct}%` };
    }

    // ── PRIORITAS 2: Max Hold berbasis config ─────────────────────────────
    if (maxHoldMs > 0 && ageMs >= maxHoldMs) {
      const ageHours = ageMs / (60 * 60 * 1000);
      console.log(`[evilPanda] ⏰ MAX_HOLD ${positionPubkey.slice(0,8)} age=${ageHours.toFixed(2)}h limit=${maxHoldHours}h`);
      return {
        action: 'MAX_HOLD',
        currentValueSol,
        pnlPct,
        ...feeOnlyPnl,
        inRange,
        exitReason: `Max hold: age=${ageHours.toFixed(2)}h ≥ ${maxHoldHours}h`,
      };
    }

    // ── Telemetry: trailing memakai HWM profit sebagai satu-satunya TP driver
    // untuk posisi agent-managed. Posisi manual bisa memakai TA-only exit.
    if (pnlPct > reg.hwmPct) {
      reg.hwmPct = pnlPct; // update HWM in-place (Map entry adalah referensi)
      console.log(`[evilPanda] 📈 New HWM: ${reg.hwmPct.toFixed(2)}%`);
    }

    if (manualTaExitEnabled) {
      const taSignal = await fetchExitSignal(reg.tokenXMint);
      const exitDecision = evaluateExitSignal(taSignal);
      const defensiveDecision = evaluateDefensiveExitConfirmation({
        reg,
        exitDecision,
        ageMs,
        inRange,
        outOfRangeSide,
        nowMs: Date.now(),
      });
      if (exitDecision.shouldExit && defensiveDecision.allowExit) {
        const exitReasonPrefix = exitDecision.scenario === 'C'
          ? 'TAKE_PROFIT_C'
          : exitDecision.scenario === 'B'
            ? 'TAKE_PROFIT_B'
            : 'TAKE_PROFIT_A';
        console.log(
          `[evilPanda] 📉 TA_EXIT_MANUAL ${positionPubkey.slice(0,8)} ` +
          `scenario=${exitDecision.scenario || 'NA'} reason=${exitDecision.reason}`
        );
        return {
          action: 'TAKE_PROFIT',
          currentValueSol,
          pnlPct,
          ...feeOnlyPnl,
          inRange,
          exitScenario: exitDecision.scenario || 'TA',
          exitReason: `${exitReasonPrefix}: ${exitDecision.reason}`,
        };
      }
      if (exitDecision.shouldExit && !defensiveDecision.allowExit) {
        console.log(
          `[evilPanda] ⏸️ TA_EXIT_MANUAL_HOLD ${positionPubkey.slice(0,8)} ` +
          `${defensiveDecision.holdReason || 'defensive hold'}`
        );
      }
      return {
        action: 'HOLD',
        currentValueSol,
        pnlPct,
        ...feeOnlyPnl,
        inRange,
        activeBinId: activeBin.binId,
        activePrice: rawPrice,
        entryActiveBin,
        entryPrice,
        rangeMin: reg.rangeMin,
        rangeMax: reg.rangeMax,
        taReason: defensiveDecision.holdReason || exitDecision.reason,
        taSignal,
      };
    }

    if (trailingStopPct > 0 && pnlPct >= trailingStopPct) {
      const reason = `Primary TP target hit: PnL=${pnlPct.toFixed(2)}% >= ${trailingStopPct.toFixed(2)}%`;
      console.log(`[evilPanda] 📈 TP (PRIMARY_TRAILING_STOP) ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% target=${trailingStopPct.toFixed(2)}%`);
      return {
        action: 'TAKE_PROFIT',
        currentValueSol,
        pnlPct,
        ...feeOnlyPnl,
        inRange,
        exitScenario: 'TRAILING_STOP_PCT',
        exitReason: reason,
      };
    }

    const trailingEligible = trailingTriggerPct > 0 && pnlPct >= trailingTriggerPct;
    if (trailingEligible) {
      const trailingDrawdownPct = reg.hwmPct - pnlPct;
      if (trailingDrawdownPct >= trailingDropPct) {
        const reason =
          `Fallback trailing TP: HWM=${reg.hwmPct.toFixed(2)}% retraced ${trailingDrawdownPct.toFixed(2)}% >= ${trailingDropPct.toFixed(2)}%`;
        console.log(`[evilPanda] 📈 TP (FALLBACK_TRAILING) ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% hwm=${reg.hwmPct.toFixed(2)}% drawdown=${trailingDrawdownPct.toFixed(2)}%`);
        return {
          action: 'TAKE_PROFIT',
          currentValueSol,
          pnlPct,
          ...feeOnlyPnl,
          inRange,
          exitScenario: 'TRAILING',
          exitReason: reason,
        };
      }
    }

    const agentDefensiveSignal = await fetchExitSignal(reg.tokenXMint);
    const agentDefensiveDecision = evaluateAgentDefensiveTaExit(agentDefensiveSignal, { ageMs });
    if (agentDefensiveDecision.shouldExit) {
      console.log(
        `[evilPanda] 📉 TA_EXIT_AGENT ${positionPubkey.slice(0,8)} ` +
        `scenario=${agentDefensiveDecision.scenario || 'NA'} reason=${agentDefensiveDecision.reason}`
      );
      return {
        action: 'TAKE_PROFIT',
        currentValueSol,
        pnlPct,
        ...feeOnlyPnl,
        inRange,
        exitScenario: `DEFENSIVE_${agentDefensiveDecision.scenario || 'TA'}`,
        exitReason: `TAKE_PROFIT_C: ${agentDefensiveDecision.reason}`,
      };
    }

    console.log(`[evilPanda] 📊 ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% val=${currentValueSol.toFixed(4)}SOL | TP hold: primary trailing target, fallback trailing, and defensive TA not triggered`);

    return {
      action: 'HOLD',
      currentValueSol,
      pnlPct,
      ...feeOnlyPnl,
      inRange,
      activeBinId: activeBin.binId,
      activePrice: rawPrice,
      entryActiveBin,
      entryPrice,
      rangeMin: reg.rangeMin,
      rangeMax: reg.rangeMax,
      taReason: agentDefensiveDecision.reason || 'Primary/fallback trailing profit not triggered',
      taSignal: agentDefensiveSignal,
    };

  } catch (e) {
    console.warn(`[evilPanda] monitorPnL error: ${e.message}`);
    return { action: 'ERROR', currentValueSol: 0, pnlPct: 0, feePnlSol: 0, feePnlPct: 0, feePnlSource: 'none', feePnlAvailable: false, inRange: false, error: e.message };
  }
}

export async function getPositionOnChainStatus(positionPubkey) {
  const reg = _activePositions.get(positionPubkey);
  const marker = getQuoteOnlyDeployMarker(positionPubkey);
  if (!reg) {
    return {
      tracked: false,
      exists: false,
      hasLiquidity: false,
      manualWithdrawn: false,
      reason: marker && isBotQuoteOnlyPartialMarker(marker)
        ? 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION'
        : 'POSITION_NOT_IN_REGISTRY',
    };
  }

  const connection = getConnection();
  const wallet = getWallet();
  const invalidRegistryStatus = await resolveInvalidTrackedPositionStatus({
    connection,
    positionPubkey,
    poolAddress: reg?.poolAddress || '',
    marker,
  });
  if (invalidRegistryStatus) return invalidRegistryStatus;
  const safePoolAddress = String(reg?.poolAddress || '').trim();
  const dlmmPool = await DLMM.create(connection, new PublicKey(safePoolAddress));
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

  if (!activePos) {
    if (marker && isBotQuoteOnlyPartialMarker(marker)) {
      return {
        tracked: true,
        exists: false,
        hasLiquidity: false,
        manualWithdrawn: false,
        reason: 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION',
      };
    }
    return {
      tracked: true,
      exists: false,
      hasLiquidity: false,
      manualWithdrawn: true,
      reason: 'POSITION_NOT_FOUND_ON_CHAIN',
    };
  }

  const pd = activePos.positionData || {};
  const totalX = Number(pd.totalXAmount?.toString() || '0');
  const totalY = Number(pd.totalYAmount?.toString() || '0');
  const hasLiquidity = totalX > 0 || totalY > 0;

  return {
    tracked: true,
    exists: true,
    hasLiquidity,
    manualWithdrawn: !hasLiquidity && !(marker && isBotQuoteOnlyPartialMarker(marker)),
    reason: hasLiquidity
      ? 'POSITION_ACTIVE_ON_CHAIN'
      : (marker && isBotQuoteOnlyPartialMarker(marker)
        ? 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION'
        : 'POSITION_EMPTY_ON_CHAIN'),
  };
}

// ── 3. exitPosition ───────────────────────────────────────────────

/**
 * Withdraw 100% likuiditas, lalu swap sisa tokenX ke SOL.
 *
 * @param {string} positionPubkey
 * @param {string} [reason='MANUAL']
 * @returns {Promise<{ positionValueSol: number, walletNetDeltaSol: number }>}
 */
export async function exitPosition(positionPubkey, reason = 'MANUAL') {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) throw new Error(`[evilPanda] exitPosition: ${positionPubkey.slice(0,8)} not in registry`);
  if (normalizeExecutionMode(reg?.executionMode) !== 'real') {
    throw new Error(`[evilPanda] exitPosition: paper position must use virtual close path`);
  }

  console.log(`[evilPanda] ▶ exitPosition ${positionPubkey.slice(0,8)} reason=${reason}`);

  const connection = getConnection();
  const wallet     = getWallet();
  const microLamports = await getPriorityFee();
  const normalizedExitReason = normalizeExitReason(reason);
  const isEmergencyExit =
    normalizedExitReason === 'STOP_LOSS' ||
    normalizedExitReason === 'OUT_OF_RANGE' ||
    /SCENARIO_C|SUPPORT|BEARISH|PANIC/i.test(String(reason || ''));

  try {
    return await withExitAccountingLock(() => withPermanentAwareBackoff(async () => {
      const preExitWalletLamports = await connection.getBalance(wallet.publicKey);
      const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
      await dlmmPool.refetchStates().catch(() => {});
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

      if (!activePos) {
        return await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED_DURING_EXIT');
      }

      if (!activePos.positionData || activePos.positionData.lowerBinId === undefined) {
        const msg = `POSITION_STATE_AMBIGUOUS_${positionPubkey.slice(0,8)}`;
        console.log(`[evilPanda] ❌ ${msg}: Data posisi tidak lengkap / undefined. Registry ditahan untuk manual reconcile.`);
        await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
          manualReconcileReason: 'incomplete position data or RPC timeout',
          closeReason: reason,
        }, { flush: true });
        throw buildPermanentExitError(msg, 'POSITION_STATE_AMBIGUOUS');
      }

      await setPositionLifecycle(positionPubkey, 'closing', { closeReason: reason }, { flush: true });

      // Snapshot composition sebelum close untuk final trading accounting (exclude rent refunds).
      let estimatedFeeSol = 0;
      let estimatedFeePct = 0;
      let estimatedFeeSource = 'none';
      let estimatedFeeAvailable = false;
      let estimatedFeeXRaw = '0';
      let preClosePositionValueSol = 0;
      let preClosePositionValueSource = 'none';
      let inRangeAtClose = typeof reg?.inRange === 'boolean' ? reg.inRange : null;
      const preCloseTokenXRaw = await getTokenBalanceRaw(reg.tokenXMint).catch(() => '0');
      try {
        const pd = activePos.positionData;
        estimatedFeeXRaw = pd.feeX?.toString() || '0';
        const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
        const xDec = xMeta.decimals || 9;
        const yDec = yMeta.decimals || 9;
        const activeBin = await dlmmPool.getActiveBin().catch(() => null);
        if (
          Number.isSafeInteger(Number(activeBin?.binId)) &&
          Number.isFinite(Number(reg?.rangeMin)) &&
          Number.isFinite(Number(reg?.rangeMax))
        ) {
          inRangeAtClose =
            Number(activeBin.binId) >= Number(reg.rangeMin) &&
            Number(activeBin.binId) <= Number(reg.rangeMax);
        }
        const valueSnapshot = await estimatePositionValueSolFromPositionData({
          positionData: pd,
          tokenXMint: reg.tokenXMint,
          xDec,
          yDec,
          activeBinPrice: safeNum(activeBin?.pricePerToken, 0),
        });
        preClosePositionValueSol = valueSnapshot.positionValueSol;
        preClosePositionValueSource = valueSnapshot.valueSource;
        const feeOnly = await calculateFeeOnlyPnl({
          feeXRaw: pd.feeX?.toString() || '0',
          feeYRaw: pd.feeY?.toString() || '0',
          xDec,
          yDec,
          tokenXMint: reg.tokenXMint,
          deploySol: reg.deploySol,
          activeBinPrice: safeNum(activeBin?.pricePerToken, 0),
        });
        estimatedFeeSol = feeOnly.feePnlSol;
        estimatedFeePct = feeOnly.feePnlPct;
        estimatedFeeSource = feeOnly.feePnlSource;
        estimatedFeeAvailable = feeOnly.feePnlAvailable === true;
      } catch {
        estimatedFeeSol = 0;
        estimatedFeePct = 0;
        estimatedFeeSource = 'none';
        estimatedFeeAvailable = false;
        estimatedFeeXRaw = '0';
        preClosePositionValueSol = 0;
        preClosePositionValueSource = 'none';
      }

      // 1. Remove all liquidity and request account close.
      const removeSignatures = [];
      const exitMicroLamports = isEmergencyExit ? Math.max(microLamports * 5, microLamports) : microLamports;
      const exitPathStats = { zapUsed: false };
      const primaryExit = await executeExitCloseWithZapPreferred({
        connection,
        wallet,
        dlmmPool,
        activePos,
        microLamports: exitMicroLamports,
        removeSignatures,
        stage: 'primary',
        notifyOnFallback: true,
        fallbackMode: 'none',
      });
      if (primaryExit.path === 'ZAP_OUT') exitPathStats.zapUsed = true;

      // 2. Verifikasi posisi benar-benar sudah close di chain
      const isClosedOnChain = await verifyPositionClosedOnChain(connection, wallet, reg.poolAddress, positionPubkey, {
        attempts: 3,
        delayMs: 1200,
      });
      if (!isClosedOnChain) {
        await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
          manualReconcileReason: 'close verification failed',
          closeReason: reason,
        }, { flush: true });
        throw buildPermanentExitError(
          `POSITION_STILL_OPEN_AFTER_EXIT_${positionPubkey.slice(0,8)}`,
          'POSITION_STILL_OPEN_AFTER_EXIT'
        );
      }

      // 3. Auto-swap jalur agent: full-sweep for zap_out semantics, residual guarded by policy.
      // Ini menyamakan perilaku safeExit/exitPosition dengan close policy lain.
      let feeAutoSwapOutSol = 0;
      let residualSwapOutSol = 0;
      let feeSwapStatus = 'not_attempted';
      let residualSwapStatus = 'not_attempted';
      let swapFailureReason = null;
      let residualTokenBalances = [];
      const cfg = getConfig();
      const swapPolicy = isTakeProfitExitReason(reason, normalizedExitReason)
        ? buildTakeProfitExitSwapPolicy(cfg, isEmergencyExit)
        : buildExitSwapPolicy(cfg, isEmergencyExit);
      if (swapPolicy.swapMode !== 'off') {
        try {
          const balanceSettle = await waitForExitTokenBalanceSettle({
            mint: reg.tokenXMint,
            baselineRaw: preCloseTokenXRaw,
          });
          const postCloseTokenXRaw = balanceSettle.rawAmount;
          const preX = toSafeBigIntRaw(preCloseTokenXRaw);
          const postX = toSafeBigIntRaw(postCloseTokenXRaw);
          const feeX = toSafeBigIntRaw(estimatedFeeXRaw);
          const deltaX = postX > preX ? postX - preX : 0n;
          const feeSwapRaw = deltaX > 0n ? (feeX > 0n ? (deltaX < feeX ? deltaX : feeX) : deltaX) : 0n;
          console.log(
            `[evilPanda] AGENT_EXIT_SWAP_BALANCE_SETTLE settled=${balanceSettle.settled} ` +
            `attempts=${balanceSettle.attemptsUsed} pre=${preX.toString()} post=${postX.toString()} delta=${deltaX.toString()}`,
          );

          const shouldSwapFeeOnly = swapPolicy.swapMode === 'fee_only' || swapPolicy.swapMode === 'all';
          const shouldSwapResidual = swapPolicy.swapMode === 'all' || swapPolicy.allowResidualSwap;
          const emergencySlippageBps = Math.max(750, Number(cfg.panicExitSlippageBps ?? 750));
          const baseSlippageBps = Math.max(50, Number(cfg.slippageBps || 250));
          const effectiveSlippageBps = isEmergencyExit ? emergencySlippageBps : baseSlippageBps;

          if (shouldSwapFeeOnly && feeSwapRaw > 0n) {
            const feeSwap = await attemptGatedExitSwapToSol({
              mint: reg.tokenXMint,
              rawAmount: feeSwapRaw.toString(),
              slippageBps: effectiveSlippageBps,
              isUrgent: isEmergencyExit,
              isEmergencyExit,
              emergencySlippageBps,
              maxImpactPct: swapPolicy.maxImpactPct,
              minOutSol: swapPolicy.minOutSol,
              minNetSol: swapPolicy.minNetSol,
              estimatedCostSol: swapPolicy.estimatedCostSol,
              label: 'AGENT_EXIT_FEE_SWAP',
            });
            if (feeSwap?.success) {
              feeSwapStatus = 'success';
              feeAutoSwapOutSol = Number(feeSwap.outSol || 0);
              if (feeSwap.txHash) removeSignatures.push(feeSwap.txHash);
              console.log(
                `[evilPanda] AGENT_EXIT_FEE_SWAP_DONE out=${feeAutoSwapOutSol.toFixed(6)} SOL impact=${Number(feeSwap.priceImpactPct || 0).toFixed(2)}%`,
              );
            } else {
              feeSwapStatus = 'skipped';
              swapFailureReason = feeSwap?.reason || 'AGENT_EXIT_FEE_SWAP_UNKNOWN';
              console.log(`[evilPanda] AGENT_EXIT_FEE_SWAP_SKIP reason=${swapFailureReason}`);
              if (feeSwap?.error) {
                console.warn(`[evilPanda] AGENT_EXIT_FEE_SWAP_SKIP_ERROR detail=${feeSwap.error}`);
              }
            }
          } else if (shouldSwapFeeOnly) {
            const skipReason = balanceSettle.settled === false
              ? 'NO_FEE_DELTA_AFTER_SETTLE'
              : 'NO_FEE_DELTA';
            feeSwapStatus = 'no_balance';
            console.log(`[evilPanda] AGENT_EXIT_FEE_SWAP_SKIP reason=${skipReason}`);
          }

          const residualMintCandidates = [reg.tokenXMint, reg.tokenYMint].filter((mint, index, arr) => {
            const normalizedMint = String(mint || '');
            if (!normalizedMint || normalizedMint === WSOL_MINT) return false;
            return arr.findIndex((candidate) => String(candidate || '') === normalizedMint) === index;
          });

          if (shouldSwapResidual) {
            let residualSwapsDone = 0;
            residualSwapStatus = 'no_balance';
            for (const residualMint of residualMintCandidates) {
              const residualRaw = await getTokenBalanceRaw(residualMint).catch(() => '0');
              if (!isValidPositiveIntegerString(residualRaw)) {
                console.log(`[evilPanda] AGENT_EXIT_RESIDUAL_SWAP_SKIP reason=NO_RESIDUAL_BALANCE mint=${String(residualMint).slice(0, 8)}`);
                continue;
              }
              const residualSwap = await attemptGatedExitSwapToSol({
                mint: residualMint,
                rawAmount: residualRaw,
                slippageBps: effectiveSlippageBps,
                isUrgent: isEmergencyExit,
                isEmergencyExit,
                emergencySlippageBps,
                maxImpactPct: swapPolicy.maxImpactPct,
                minOutSol: swapPolicy.minOutSol,
                minNetSol: swapPolicy.minNetSol,
                estimatedCostSol: swapPolicy.estimatedCostSol,
                label: 'AGENT_EXIT_RESIDUAL_SWAP',
              });
              if (residualSwap?.success) {
                residualSwapsDone++;
                residualSwapStatus = 'success';
                residualSwapOutSol += Number(residualSwap.outSol || 0);
                if (residualSwap.txHash) removeSignatures.push(residualSwap.txHash);
                console.log(
                  `[evilPanda] AGENT_EXIT_RESIDUAL_SWAP_DONE mint=${String(residualMint).slice(0, 8)} out=${Number(residualSwap.outSol || 0).toFixed(6)} SOL impact=${Number(residualSwap.priceImpactPct || 0).toFixed(2)}%`,
                );
              } else if (residualSwap?.skipped) {
                residualSwapStatus = 'skipped';
                swapFailureReason = residualSwap.reason || swapFailureReason || 'AGENT_EXIT_RESIDUAL_SWAP_UNKNOWN';
                console.log(`[evilPanda] AGENT_EXIT_RESIDUAL_SWAP_SKIP mint=${String(residualMint).slice(0, 8)} reason=${residualSwap.reason || 'UNKNOWN'}`);
                if (residualSwap?.error) {
                  console.warn(`[evilPanda] AGENT_EXIT_RESIDUAL_SWAP_SKIP_ERROR detail=${residualSwap.error}`);
                }
              }
            }
            if (residualSwapsDone === 0) {
              console.log('[evilPanda] AGENT_EXIT_RESIDUAL_SWAP_SKIP reason=NO_RESIDUAL_BALANCE');
            }
          }
          console.log('[evilPanda] AGENT_EXIT_SWAP_STAGE_DONE mode=TP_FULL_SWEEP');
        } catch (swapErr) {
          feeSwapStatus = feeSwapStatus === 'not_attempted' ? 'failed' : feeSwapStatus;
          residualSwapStatus = residualSwapStatus === 'not_attempted' ? 'failed' : residualSwapStatus;
          swapFailureReason = swapErr?.message || 'AGENT_EXIT_SWAP_ERROR';
          console.warn(`[evilPanda] AGENT_EXIT_SWAP_ERROR: ${swapErr.message}`);
        }
      } else {
        feeSwapStatus = 'disabled';
        residualSwapStatus = 'disabled';
      }

      residualTokenBalances = await auditExitResidualTokenBalances({
        mints: [reg.tokenXMint, reg.tokenYMint],
      });
      const residualAuditFailed = residualTokenBalances.some((item) => item.readOk !== true);
      const hasResidualTokens = residualTokenBalances.some((item) => item.hasResidual === true);
      const swapCompletionStatus = swapPolicy.swapMode === 'off'
        ? (residualAuditFailed ? 'unverified' : (hasResidualTokens ? 'partial' : 'disabled'))
        : (residualAuditFailed ? 'unverified' : (hasResidualTokens ? 'partial' : 'full'));
      if (swapCompletionStatus !== 'full' && !swapFailureReason) {
        swapFailureReason = residualAuditFailed
          ? 'RESIDUAL_BALANCE_AUDIT_FAILED'
          : 'RESIDUAL_TOKEN_BALANCE_REMAINS';
      }
      console.log(
        `[evilPanda] AGENT_EXIT_SWAP_AUDIT status=${swapCompletionStatus} ` +
        `fee=${feeSwapStatus} residual=${residualSwapStatus} ` +
        `balances=${JSON.stringify(residualTokenBalances.map(({ mint, rawAmount, readOk }) => ({
          mint: mint.slice(0, 8),
          rawAmount,
          readOk,
        })))} reason=${swapFailureReason || 'none'}`,
      );

      const postExitWalletLamports = await connection.getBalance(wallet.publicKey);
      const walletNetDeltaSol = (postExitWalletLamports - preExitWalletLamports) / 1e9;
      const txFeeLamports = await estimateTxFeeLamports(connection, removeSignatures);
      const txFeeSol = txFeeLamports / 1e9;
      const positionValueSol = Math.max(0, preClosePositionValueSol);
      const finalAccounting = computeFinalExitAccounting({
        deploySol: reg.deploySol,
        positionValueSol,
        walletNetDeltaSol,
        txFeesSol: txFeeSol,
      });

      // 4. Bersihkan registry lokal setelah verifikasi close sukses
      _activePositions.delete(positionPubkey);
      await persistActivePositionsStateNow();
      clearPositionRuntimeState(positionPubkey);
      clearQuoteOnlyDeployMarker(positionPubkey);
      console.log(`[evilPanda] ✅ Position closed & verified: ${positionPubkey.slice(0,8)} | reason=${reason}`);

      // 5. Harvest Log + Ledger + Blacklist
      const tokenSymbol = reg.tokenXMint?.slice(0,8) || 'UNKNOWN';
      const pnlTotalSol = finalAccounting.realizedTradingPnlSol;
      const feePnlSol = Math.max(0, estimatedFeeSol);
      const pricePnlSol = pnlTotalSol - feePnlSol;
      const finalPnlPct = finalAccounting.realizedTradingPnlPct;
      const normalizedReason = normalizeExitReason(reason, { pnlPct: finalPnlPct, pnlSol: pnlTotalSol });
      const closedAt = nowIso();
      appendHarvestLog({
        token:          tokenSymbol,
        positionPubkey,
        pnlPct:         finalPnlPct,
        deploySol:      reg.deploySol,
        reason,
      });
      appendPositionLedger({
        positionPubkey,
        poolAddress: reg.poolAddress || '',
        tokenMint: reg.tokenXMint || '',
        openedAt: reg.deployedAt || null,
        closedAt,
        reason,
        capitalInSol: reg.deploySol || 0,
        capitalOutSol: finalAccounting.positionValueSol,
        pnlTotalSol,
        pnlTotalPct: finalPnlPct,
        feePnlSol,
        pricePnlSol,
        txCostSol: txFeeSol,
        walletNetDeltaSol: finalAccounting.walletNetDeltaSol,
        rentRefundSol: finalAccounting.rentRefundSol,
        positionValueSol: finalAccounting.positionValueSol,
        realizedTradingPnlSol: finalAccounting.realizedTradingPnlSol,
        realizedTradingPnlPct: finalAccounting.realizedTradingPnlPct,
        accountingStatus: finalAccounting.accountingStatus,
        normalizedReason,
        swapCompletionStatus,
        swapFailureReason,
        feeSwapStatus,
        residualSwapStatus,
        residualSwapOutSol,
        residualTokenBalances,
      });
      recordPoolOutcome({
        key: reg.poolAddress || reg.tokenXMint,
        tokenMint: reg.tokenXMint || '',
        poolAddress: reg.poolAddress || '',
        symbol: tokenSymbol,
        pnlPct: finalPnlPct,
        pnlSol: pnlTotalSol,
        reason: normalizedReason,
        snapshot: { rawReason: reason },
      });
      recordPoolPatternOutcome({
        positionPubkey,
        features: reg.patternLearningEntry || {
          tokenMint: reg.tokenXMint || '',
          poolAddress: reg.poolAddress || '',
          symbol: tokenSymbol,
          binStep: null,
          tvl: null,
          volume24h: null,
          volumeTvlRatio: null,
          mcap: null,
          holderCount: null,
          supertrend15m: 'UNKNOWN',
          feeActiveTvlRatio: null,
          rangeWidthBins: reg.rangeMax && reg.rangeMin ? (Number(reg.rangeMax) - Number(reg.rangeMin) + 1) : null,
          entryActiveBin: Number.isFinite(Number(reg.entryActiveBin)) ? Number(reg.entryActiveBin) : null,
          entryReason: 'UNKNOWN',
        },
        outcome: {
          feePnlPct: estimatedFeePct,
          feePnlSol: feePnlSol,
          totalPnlPct: finalPnlPct,
          pnlSol: pnlTotalSol,
          exitReason: normalizedReason,
          rawExitReason: reason,
          holdDurationMs: Math.max(0, Date.now() - new Date(reg.deployedAt || nowIso()).getTime()),
        },
        cfg: getConfig(),
      });

      // Tambah ke blacklist jika kena SL / rugpull / rollback
      const SL_REASONS = ['STOP_LOSS', 'DEPLOY_FAILED', 'MANUAL_STOP'];
      if (SL_REASONS.includes(normalizedReason) || finalPnlPct <= -10) {
        const isRug = finalPnlPct <= -15;
        addToBlacklist(reg.tokenXMint, {
          token:     tokenSymbol,
          reason:    normalizedReason,
          note:      `PnL ${finalPnlPct.toFixed(2)}%`,
          permanent: isRug,
        });
      }

      return {
        solRecovered: finalAccounting.walletNetDeltaSol,
        symbol: reg?.symbol || reg?.patternLearningEntry?.symbol || tokenSymbol,
        deploySol: reg.deploySol,
        openedAt: reg.deployedAt || null,
        closedAt,
        inRangeAtClose,
        positionValueSol: finalAccounting.positionValueSol,
        walletNetDeltaSol: finalAccounting.walletNetDeltaSol,
        rentRefundSol: finalAccounting.rentRefundSol,
        txFeesSol: finalAccounting.txFeesSol,
        realizedTradingPnlSol: finalAccounting.realizedTradingPnlSol,
        realizedTradingPnlPct: finalAccounting.realizedTradingPnlPct,
        accountingStatus: finalAccounting.accountingStatus,
        positionValueSource: preClosePositionValueSource,
        residualSwapOutSol,
        feeAutoSwapOutSol,
        feeSwapStatus,
        residualSwapStatus,
        swapCompletionStatus,
        swapFailureReason,
        residualTokenBalances,
        exitFallbackUsed: exitPathStats.fallbackUsed === true,
        tpFullSweep: isTakeProfitExitReason(reason, normalizedExitReason),
        feePnlSol,
        feePnlPct: estimatedFeePct,
        feePnlSource: estimatedFeeSource,
        feePnlAvailable: estimatedFeeAvailable,
        pnlTotalSol: finalAccounting.realizedTradingPnlSol,
        pnlTotalPct: finalAccounting.realizedTradingPnlPct,
        exitReason: normalizedReason,
        rawExitReason: reason,
      };

    }, { maxRetries: 2, baseDelay: 3000, maxDelay: 10_000 }));
  } catch (e) {
    const positionStillTracked = _activePositions.has(positionPubkey);
    let positionStatus = null;
    if (positionStillTracked) {
      await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
        manualReconcileReason: e?.message || 'exit failed before on-chain verification',
        closeReason: reason,
      }, { flush: true });
      positionStatus = await getPositionOnChainStatus(positionPubkey).catch(() => null);
    }

    const positionStillOpenOrUncertain = Boolean(
      positionStillTracked && (
        positionStatus?.exists === true ||
        (positionStatus?.tracked === true && positionStatus?.manualWithdrawn !== true)
      )
    );
    const closeFailureMeta = {
      closeAttemptStarted: true,
      closeSucceeded: false,
      closeRetriesExhausted: true,
      positionStillOpenOrUncertain,
      positionPubkey,
      poolAddress: reg?.poolAddress || '',
      tokenXMint: reg?.tokenXMint || '',
      tokenYMint: reg?.tokenYMint || '',
      exitTriggerReason: reason,
      closeFailureError: String(e?.message || 'unknown'),
      statusReason: positionStatus?.reason || null,
      manualCloseRequired: positionStillOpenOrUncertain,
    };
    if (e && typeof e === 'object') {
      e.closeFailureMeta = closeFailureMeta;
    }
    if (closeFailureMeta.manualCloseRequired) {
      console.warn(
        `[evilPanda] CLOSE_FAILED_MANUAL_REQUIRED token=${String(reg?.tokenXMint || '').slice(0,8)} ` +
        `pool=${String(reg?.poolAddress || '').slice(0,8)} position=${positionPubkey.slice(0,8)} reason=${reason}`
      );
    }
    throw e;
  }
}

export async function markPositionManuallyClosed(positionPubkey, reason = 'MANUAL_WITHDRAW_DETECTED') {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) return { ok: true, solRecovered: 0, alreadyRemoved: true };

  console.log(`[evilPanda] ℹ️ Manual close realtime: ${positionPubkey.slice(0,8)} reason=${reason}`);
  _activePositions.delete(positionPubkey);
  await persistActivePositionsStateNow();
  clearPositionRuntimeState(positionPubkey);
  clearQuoteOnlyDeployMarker(positionPubkey);

  const tokenSymbol = reg.tokenXMint?.slice(0, 8) || 'UNKNOWN';
  const normalizedReason = normalizeExitReason(reason);
  const manualAccounting = buildManualCloseAccounting(reg);
  appendHarvestLog({
    token: tokenSymbol,
    positionPubkey,
    pnlPct: Number(manualAccounting?.pnlTotalPct || 0),
    deploySol: safeNum(reg.deploySol, 0),
    reason,
  });
  appendPositionLedger({
    positionPubkey,
    poolAddress: reg.poolAddress || '',
    tokenMint: reg.tokenXMint || '',
    openedAt: reg.deployedAt || null,
    closedAt: nowIso(),
    reason,
    normalizedReason,
    capitalInSol: safeNum(reg.deploySol, 0),
    capitalOutSol: Number(manualAccounting?.positionValueSol || 0),
    pnlTotalSol: Number(manualAccounting?.pnlTotalSol || 0),
    pnlTotalPct: Number(manualAccounting?.pnlTotalPct || 0),
    feePnlSol: Number(manualAccounting?.feePnlSol || 0),
    pricePnlSol: Number(manualAccounting?.pricePnlSol || 0),
    walletNetDeltaSol: manualAccounting?.walletNetDeltaSol ?? null,
    rentRefundSol: manualAccounting?.rentRefundSol ?? null,
    positionValueSol: manualAccounting?.positionValueSol ?? null,
    realizedTradingPnlSol: manualAccounting?.pnlTotalSol ?? null,
    realizedTradingPnlPct: manualAccounting?.pnlTotalPct ?? null,
    accountingStatus: manualAccounting?.accountingStatus || 'manual_close_reconciled_from_last_status',
    manualCloseDetected: true,
  });
  recordPoolOutcome({
    key: reg.poolAddress || reg.tokenXMint,
    tokenMint: reg.tokenXMint || '',
    poolAddress: reg.poolAddress || '',
    symbol: tokenSymbol,
    pnlPct: Number(manualAccounting?.pnlTotalPct || 0),
    pnlSol: Number(manualAccounting?.pnlTotalSol || 0),
    reason: normalizedReason,
    snapshot: { rawReason: reason },
  });
  recordPoolPatternOutcome({
    positionPubkey,
    features: reg.patternLearningEntry || {
      tokenMint: reg.tokenXMint || '',
      poolAddress: reg.poolAddress || '',
      symbol: tokenSymbol,
      binStep: null,
      tvl: null,
      volume24h: null,
      volumeTvlRatio: null,
      mcap: null,
      holderCount: null,
      supertrend15m: 'UNKNOWN',
      feeActiveTvlRatio: null,
      rangeWidthBins: reg.rangeMax && reg.rangeMin ? (Number(reg.rangeMax) - Number(reg.rangeMin) + 1) : null,
      entryActiveBin: Number.isFinite(Number(reg.entryActiveBin)) ? Number(reg.entryActiveBin) : null,
      entryReason: 'MANUAL_CLOSE',
    },
    outcome: {
      feePnlPct: manualAccounting.feePnlPct,
      feePnlSol: manualAccounting.feePnlSol,
      totalPnlPct: manualAccounting.pnlTotalPct,
      pnlSol: manualAccounting.pnlTotalSol,
      exitReason: normalizedReason,
      rawExitReason: reason,
      holdDurationMs: Math.max(0, Date.now() - new Date(reg.deployedAt || nowIso()).getTime()),
    },
    cfg: getConfig(),
  });

  const symbol = reg.tokenXMint?.slice(0, 8) || 'UNKNOWN';
  const reportSymbol =
    reg?.symbol ||
    reg?.patternLearningEntry?.symbol ||
    symbol;
  const hasReconciledSnapshot = manualAccounting.accountingStatus === 'manual_close_reconciled_from_snapshot';
  await notify(buildClosedPositionReport({
    tokenLabel: reportSymbol,
    pnlSol: hasReconciledSnapshot ? manualAccounting.pnlTotalSol : null,
    pnlPct: hasReconciledSnapshot ? manualAccounting.pnlTotalPct : null,
    feesSol: manualAccounting.feePnlAvailable ? manualAccounting.feePnlSol : null,
    depositSol: manualAccounting.deploySol,
    takeHomeSol: hasReconciledSnapshot ? manualAccounting.positionValueSol : null,
    exitLabel: 'Manual Close via Meteora',
    openedAt: reg.deployedAt || null,
    closedAt: Date.now(),
    inRange: typeof reg?.inRange === 'boolean' ? reg.inRange : null,
    rangeLabel: 'Range at Last Check',
    estimated: hasReconciledSnapshot,
    feesFromLastSnapshot: manualAccounting.feePnlAvailable,
  }));
  console.log(`[evilPanda] Manual close recorded: ${positionPubkey.slice(0,8)} | token=${symbol} | reason=${reason}`);
  return {
    ok: true,
    solRecovered: null,
    manualCloseDetected: true,
    pnlTotalSol: Number(manualAccounting?.pnlTotalSol || 0),
    pnlTotalPct: Number(manualAccounting?.pnlTotalPct || 0),
    feePnlSol: Number(manualAccounting?.feePnlSol || 0),
    feePnlPct: Number(manualAccounting?.feePnlPct || 0),
    accountingStatus: manualAccounting?.accountingStatus || 'manual_close_reconciled_from_last_status',
  };
}

export async function reconcileZombiePositions({ minAgeMs = 180_000 } = {}) {
  const connection = getConnection();
  const wallet = getWallet();
  const now = Date.now();
  let scanned = 0;
  let removed = 0;

  for (const [positionPubkey, reg] of [..._activePositions.entries()]) {
    scanned += 1;

    const lifecycle = String(reg?.lifecycleState || reg?.lifecycle_state || '').toLowerCase();
    if (lifecycle && lifecycle !== 'deploying' && lifecycle !== 'opening' && lifecycle !== 'pending') {
      continue;
    }

    const openedAt = reg?.lifecycleUpdatedAt || reg?.deployedAt || reg?.openedAt || null;
    const ageMs = openedAt ? Math.max(0, now - new Date(openedAt).getTime()) : Number.MAX_SAFE_INTEGER;
    if (ageMs < minAgeMs) continue;

    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
      await dlmmPool.refetchStates().catch(() => {});
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const activePos = userPositions.find((p) => p.publicKey.toString() === positionPubkey);

      const hasLiquidity = !!activePos && (() => {
        const pd = activePos.positionData || {};
        const totalX = Number(pd.totalXAmount?.toString() || '0');
        const totalY = Number(pd.totalYAmount?.toString() || '0');
        const feeX = Number(pd.feeX?.toString() || '0');
        const feeY = Number(pd.feeY?.toString() || '0');
        return (totalX + totalY + feeX + feeY) > 0;
      })();

      if (!activePos || !hasLiquidity) {
        const marker = getQuoteOnlyDeployMarker(positionPubkey);
        const isBotPartial = marker && isBotQuoteOnlyPartialMarker(marker);
        _activePositions.delete(positionPubkey);
        removed += 1;
        if (isBotPartial) {
          upsertQuoteOnlyDeployMarker({
            positionPubkey,
            poolAddress: marker.poolAddress,
            tokenXMint: marker.tokenXMint,
            phase: PHASE_ADD_LIQUIDITY_FAILED,
            source: marker.source || BOT_QUOTE_ONLY_DEPLOY_SOURCE,
            ttlMs: marker.ttlMs || QUOTE_ONLY_DEPLOY_MARKER_TTL_MS,
            liquidityConfirmed: false,
            extra: {
              cleanupStatus: !activePos ? 'RECONCILE_POSITION_NOT_FOUND' : 'RECONCILE_NO_LIQUIDITY',
            },
          });
        }
        clearPositionRuntimeState(positionPubkey);
        console.warn(
          `[evilPanda] 🧹 Zombie position reconciled: ${positionPubkey.slice(0,8)} ` +
          `age=${Math.round(ageMs / 1000)}s reason=${
            isBotPartial
              ? 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION'
              : (!activePos ? 'NOT_FOUND_ON_CHAIN' : 'NO_LIQUIDITY_ON_CHAIN')
          }`
        );
      }
    } catch (e) {
      console.warn(`[evilPanda] reconcileZombiePositions skip ${positionPubkey.slice(0,8)}: ${e.message}`);
    }
  }

  if (removed > 0) {
    await persistActivePositionsStateNow();
  }

  return { scanned, removed, remaining: _activePositions.size };
}

export async function reconcileStartupPositions() {
  const connection = getConnection();
  const wallet = getWallet();
  const saved = getRuntimeState(ACTIVE_POSITIONS_STATE_KEY, []);
  const rows = Array.isArray(saved) ? saved : [];
  let restored = 0;
  let dropped = 0;

  _activePositions.clear();
  for (const row of rows) {
    const pubkey = row?.pubkey;
    const poolAddress = row?.poolAddress;
    if (!pubkey || !poolAddress) {
      dropped++;
      continue;
    }
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const exists = userPositions.some((p) => p.publicKey.toString() === pubkey);
      if (!exists) {
        dropped++;
        continue;
      }
      _activePositions.set(pubkey, {
        executionMode: normalizeExecutionMode(row.executionMode),
        poolAddress,
        deploySol: safeNum(row.deploySol, 0),
        deployedAt: row.deployedAt || nowIso(),
        tokenXMint: row.tokenXMint || '',
        tokenYMint: row.tokenYMint || '',
        rangeMin: safeNum(row.rangeMin, 0),
        rangeMax: safeNum(row.rangeMax, 0),
        patternLearningEntry: row.patternLearningEntry || null,
        entryActiveBin: Number.isFinite(Number(row.entryActiveBin)) ? Number(row.entryActiveBin) : null,
        entryPrice: Number.isFinite(Number(row.entryPrice)) ? Number(row.entryPrice) : null,
        entryFinalSupertrend15m: normalizeTrackedTrendDirection(row.entryFinalSupertrend15m),
        entryFinalSupertrendSource: String(row.entryFinalSupertrendSource || 'unknown'),
        entryFinalSupertrendReason: String(row.entryFinalSupertrendReason || ''),
        entryFinalSupertrendAt: Number.isFinite(Number(row.entryFinalSupertrendAt))
          ? Number(row.entryFinalSupertrendAt)
          : null,
        entryCanonicalSnapshot:
          row?.entryCanonicalSnapshot && typeof row.entryCanonicalSnapshot === 'object'
            ? row.entryCanonicalSnapshot
            : null,
        entryOrigin: String(
          row?.entryOrigin ||
          row?.entryCanonicalSnapshot?.entryOrigin ||
          row?.entryCanonicalSnapshot?.source ||
          ''
        ),
        symbol: String(row?.symbol || row?.patternLearningEntry?.symbol || ''),
        currentValueSol: safeNum(row.currentValueSol, 0),
        pnlPct: safeNum(row.pnlPct, 0),
        feePnlSol: Math.max(0, safeNum(row.feePnlSol, 0)),
        feePnlPct: Math.max(0, safeNum(row.feePnlPct, 0)),
        feePnlAvailable: row?.feePnlAvailable === true,
        feePnlSource: String(row?.feePnlSource || 'none'),
        hwmPct: safeNum(row.hwmPct, 0),
        lifecycleState: row.lifecycleState || row.lifecycle_state || 'open',
        lifecycle_state: row.lifecycle_state || row.lifecycleState || 'open',
      });
      restored++;
    } catch {
      dropped++;
    }
  }

  await persistActivePositionsStateNow();
  return { scanned: rows.length, restored, dropped };
}

// ── Registry helpers (untuk index.js) ────────────────────────────

export function getActivePositionCount() {
  return _activePositions.size;
}

export function getActivePositionKeys() {
  return [..._activePositions.keys()];
}

export function getPositionMeta(positionPubkey) {
  return _activePositions.get(positionPubkey) || null;
}

export function __setActivePositionMetaForTests(positionPubkey, meta = null) {
  const pubkey = String(positionPubkey || '');
  if (!pubkey) return;
  if (meta === null) {
    _activePositions.delete(pubkey);
    return;
  }
  _activePositions.set(pubkey, {
    ...(meta && typeof meta === 'object' ? meta : {}),
  });
}

export function __setQuoteOnlyDeployMarkerForTests(positionPubkey, marker = null) {
  const pubkey = String(positionPubkey || '');
  if (!pubkey) return;
  if (marker === null) {
    clearQuoteOnlyDeployMarker(pubkey);
    return;
  }
  upsertQuoteOnlyDeployMarker({
    positionPubkey: pubkey,
    poolAddress: String(marker?.poolAddress || ''),
    tokenXMint: String(marker?.tokenXMint || ''),
    phase: String(marker?.phase || PHASE_POSITION_INIT_PENDING),
    source: String(marker?.source || BOT_QUOTE_ONLY_DEPLOY_SOURCE),
    ttlMs: Number(marker?.ttlMs || QUOTE_ONLY_DEPLOY_MARKER_TTL_MS),
    liquidityConfirmed: marker?.liquidityConfirmed === true,
    extra: {
      addLiquidityFailedAt: marker?.addLiquidityFailedAt ?? null,
      addLiquidityError: marker?.addLiquidityError ?? null,
      cleanupStatus: marker?.cleanupStatus ?? null,
    },
  });
}

export function __getQuoteOnlyDeployMarkerForTests(positionPubkey) {
  return getQuoteOnlyDeployMarker(positionPubkey);
}

export function __isBotQuoteOnlyPartialMarkerForTests(marker) {
  return isBotQuoteOnlyPartialMarker(marker);
}

export async function __handleQuoteOnlyPartialDeployFailureForTests(args = {}) {
  return handleQuoteOnlyPartialDeployFailure(args);
}

export function __markQuoteOnlyLiquidityConfirmedForTests({
  positionPubkey = '',
  poolAddress = '',
  tokenXMint = '',
} = {}) {
  markQuoteOnlyLiquidityConfirmed({
    positionPubkey,
    poolAddress,
    tokenXMint,
  });
}

export async function __verifyQuoteOnlyLiquidityOnChainForTests(args = {}) {
  return verifyQuoteOnlyLiquidityOnChain(args);
}

export function __extractRequiredSignerPubkeysForTests(tx) {
  return [...extractRequiredSignerPubkeys(tx)];
}

export function __inspectTxForBinArrayInitForTests(tx) {
  return inspectTxForBinArrayInit(tx);
}

export async function __guardDlmmCostBeforeSendForTests(args = {}) {
  return guardDlmmCostBeforeSend(args);
}

export function __deriveSpotBidAskSeedPlanForTests(args = {}) {
  return deriveSpotBidAskSeedPlan(args);
}

export function __buildActiveBinRelativeDeployRangeForTests(args = {}) {
  return buildActiveBinRelativeDeployRange(args);
}

export function __getDlmmStrategyTypeFromConfigForTests(args = {}) {
  return getDlmmStrategyTypeFromConfig(args);
}

export function __evaluateDeployWalletFundsForTests(args = {}) {
  return evaluateDeployWalletFunds(args);
}

export function __assertNoUnexpectedSolTransferInTxForTests(args = {}) {
  return assertNoUnexpectedSolTransferInTx(args);
}

export function __evaluateFrozenEntryIntentForDeployForTests(args = {}) {
  return evaluateFrozenEntryIntentForDeploy(args);
}

export function __evaluateDefensiveExitConfirmationForTests(args = {}) {
  return evaluateDefensiveExitConfirmation(args);
}

export async function __resolveInvalidTrackedPositionStatusForTests(args = {}) {
  return resolveInvalidTrackedPositionStatus(args);
}

export { EP_CONFIG };
