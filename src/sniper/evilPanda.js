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

import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import BN from 'bn.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConnection, getWallet, getTokenBalanceRaw } from '../solana/wallet.js';
import { getConfig, isDryRun } from '../config.js';
import { swapToSol } from '../utils/jupiter.js';
import { getJupiterQuote } from '../solana/jupiter.js';
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
// Bounded search radius for rent-free fallback slices on the same pool.
// This only affects pools that already tripped the rent guard.
const RENT_FREE_SEARCH_SLACK_ARRAYS = 100;
// SDK enum fallback to numeric Spot strategy for backward compatibility.
const SPOT_STRATEGY_TYPE = StrategyType?.Spot ?? 0;
const DLMM_SDK_PATH_STRATEGY = 'strategy';
const DLMM_SDK_PATH_WEIGHT_QUOTE_ONLY = 'weight_quote_only';

function isFiniteInteger(value) {
  return Number.isFinite(value) && Number.isSafeInteger(value);
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

  if (side === 'QUOTE_ONLY' && safeMax >= activeBinId) {
    safeMax = activeBinId - 1;
    safeMin = safeMax - (rangeWidth - 1);
    adjustmentReason = 'shift_below_active_quote_only';
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
  if (side === 'QUOTE_ONLY' && safeMax >= activeBinId) {
    throw buildInvalidDlmmArgsError('single-side quote final range must be below active bin');
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
  const reasonLabel = (sdkErrorMeta?.isInvalidArguments || hasInvalidCode)
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

  const invalidArguments = /invalid arguments/i.test(text);
  const instructionIndexMatch =
    text.match(/instructionerror"\s*:\s*\[\s*(-?\d+)/i)
    || text.match(/instructionerror\s*:\s*\[\s*(-?\d+)/i);
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

  const hasInstructionError = lower.includes('instructionerror');
  const hasCode3007 = customCode === 3007 || /"custom"\s*:\s*3007/i.test(text);
  const hasHex0bbf = anchorErrorHex === '0xbbf' || /custom program error:\s*0xbbf/i.test(text);
  const hasOwnedByWrongProgram = /accountownedbywrongprogram/i.test(text);

  let anchorErrorCode = Number.isFinite(customCode) ? customCode : null;
  if (anchorErrorCode === null && hasCode3007) anchorErrorCode = 3007;
  if (anchorErrorCode === null && anchorErrorHex === '0xbbf') anchorErrorCode = 3007;
  if (!anchorErrorHex && anchorErrorCode === 3007) anchorErrorHex = '0xbbf';

  const anchorErrorName = (hasOwnedByWrongProgram || anchorErrorCode === 3007 || anchorErrorHex === '0xbbf')
    ? 'AccountOwnedByWrongProgram'
    : null;

  const isSimulationAccountError =
    hasHex0bbf ||
    hasCode3007 ||
    hasOwnedByWrongProgram ||
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
    sdkMinBinId: Number.isFinite(Number(sdkStrategy?.minBinId)) ? Number(sdkStrategy.minBinId) : null,
    sdkMaxBinId: Number.isFinite(Number(sdkStrategy?.maxBinId)) ? Number(sdkStrategy.maxBinId) : null,
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
} = {}) {
  let refreshedActiveBinId = Number(deployArgs?.activeBinId);
  let activeRefreshReason = null;

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
    `strategyType=${finalDeployArgs.strategyType} attempt=${attempt}`
  );
  console.log(
    `[evilPanda] FINAL_SDK_RANGE pool=${poolAddress.slice(0,8)} ` +
    `rentGuard=${finalRentGuard.guard || 'UNKNOWN'} checked=[${checkedRangeMin},${checkedRangeMax}] ` +
    `strategy=[${sdkStrategy.minBinId},${sdkStrategy.maxBinId}] attempt=${attempt}`
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
  });
  console.log(
    `[DLMM_FINAL_ARGS] pool=${debug.pool} tokenXMint=${debug.tokenXMint} tokenYMint=${debug.tokenYMint} ` +
    `activeBinId=${debug.activeBinId} initialActiveBinId=${debug.initialActiveBinId ?? 'na'} refreshedActiveBinId=${debug.refreshedActiveBinId ?? 'na'} ` +
    `range=[${debug.rangeMin},${debug.rangeMax}] width=${debug.rangeWidth} ` +
    `amountX=${debug.amountX} amountY=${debug.amountY} amountXIsZero=${debug.amountXIsZero} amountYIsZero=${debug.amountYIsZero} ` +
    `strategyType=${debug.strategyType} side=${debug.singleSide} quoteSide=${debug.quoteSide} activeInside=${debug.activeInsideRange} ` +
    `reason=${debug.adjustedReason || 'none'}`
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
    rangeMax < activeBinId;
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
      : async (tx) => connection.sendTransaction(tx, [getWallet(), positionKeypair], { skipPreflight: false, maxRetries: 3 });
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
    try {
      const quote = await quoteFn(tokenXMint, WSOL_MINT, feeXRawStr);
      feeXSol = Math.max(0, Number(quote?.outAmount || 0) / 1e9);
      feePnlSource = 'jupiter';
    } catch {
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

  let closeTxCount = 0;
  try {
    const cleanupTxs = await buildClosePositionTxs(dlmmPool, wallet, activePos);
    const txList = Array.isArray(cleanupTxs) ? cleanupTxs : [cleanupTxs];
    closeTxCount = txList.length;
    for (const tx of txList) {
      const sig = await sendExitTx(connection, wallet, tx, microLamports);
      console.log(`[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_TX ${sig.slice(0,8)}`);
    }
  } catch (closeErr) {
    console.warn(
      `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_SKIPPED pool=${String(poolAddress || '').slice(0,8)} ` +
      `position=${safePositionPubkey.slice(0,8)} reason=${String(closeErr?.message || 'CLOSE_FAILED')}`
    );
    return {
      cleaned: false,
      skipped: true,
      reason: `CLOSE_FAILED:${String(closeErr?.message || 'unknown')}`,
      hasLiquidity: false,
      closeTxCount,
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
      closeTxCount,
    };
  }

  console.log(
    `[evilPanda] QUOTE_ONLY_EMPTY_POSITION_CLEANUP_OK pool=${String(poolAddress || '').slice(0,8)} ` +
    `position=${safePositionPubkey.slice(0,8)} txs=${closeTxCount}`
  );
  return { cleaned: true, skipped: false, reason: 'CLOSED_EMPTY_POSITION', hasLiquidity: false, closeTxCount };
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

  if (!cleanup?.hasLiquidity) {
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

function getConfiguredTrailingTriggerPct() {
  const cfg = getConfig();
  const value = Number(cfg.trailingTriggerPct);
  return Number.isFinite(value) && value > 0 ? value : EP_CONFIG.TRAILING_TRIGGER_PCT;
}

function getConfiguredTrailingDropPct() {
  const cfg = getConfig();
  const value = Number(cfg.trailingDropPct);
  if (Number.isFinite(value) && value > 0) return value;
  const legacy = Number(cfg.trailingStopPct);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : EP_CONFIG.TRAILING_DROP_PCT;
}

function getConfiguredDeployRangeMaxBins() {
  const cfg = getConfig();
  const value = Number(cfg.deployRangeMaxBins);
  if (Number.isFinite(value) && value >= 5) return Math.min(68, Math.floor(value));
  return 68;
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

async function sendSignedTx(connection, wallet, tx) {
  if (tx instanceof VersionedTransaction) {
    tx.sign([wallet]);
    return await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  }
  return await connection.sendTransaction(tx, [wallet], { skipPreflight: false, maxRetries: 3 });
}

async function sendExitTx(connection, wallet, tx, microLamports) {
  injectPriorityFee(tx, { units: EP_CONFIG.EXIT_COMPUTE_UNITS, microLamports });

  let sig;
  try {
    sig = await sendSignedTx(connection, wallet, tx);
  } catch (e) {
    logSendTxError('exit send failed', e);
    if (!isComputeUnitExhausted(e)) throw e;

    console.warn(
      `[evilPanda] Exit TX kehabisan compute unit; retry dengan ${EP_CONFIG.EXIT_MAX_COMPUTE_UNITS} CU`
    );
    injectPriorityFee(tx, { units: EP_CONFIG.EXIT_MAX_COMPUTE_UNITS, microLamports });
    try {
      sig = await sendSignedTx(connection, wallet, tx);
    } catch (retryErr) {
      logSendTxError('exit send retry failed', retryErr);
      throw retryErr;
    }
  }

  await pollTxConfirm(connection, sig, 90_000);
  return sig;
}

async function getFreshActivePosition(connection, wallet, poolAddress, positionPubkey) {
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  await dlmmPool.refetchStates().catch(() => {});
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
  const activePos = userPositions.find((p) => p.publicKey.toString() === positionPubkey);
  return { dlmmPool, activePos };
}

async function buildClosePositionTxs(dlmmPool, wallet, activePos) {
  const pd = activePos?.positionData || {};
  const lowerBinId = pd.lowerBinId;
  const upperBinId = pd.upperBinId;
  const txs = [];

  if (lowerBinId !== undefined && upperBinId !== undefined) {
    try {
      const removeTxs = await dlmmPool.removeLiquidity({
        position: activePos.publicKey,
        user: wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: false,
      });
      txs.push(...(Array.isArray(removeTxs) ? removeTxs : [removeTxs]));
    } catch (e) {
      console.warn(`[evilPanda] removeLiquidity close attempt failed: ${e.message}`);
    }
  }

  if (typeof dlmmPool.claimSwapFee === 'function') {
    try {
      const claimTxs = await dlmmPool.claimSwapFee({
        owner: wallet.publicKey,
        position: activePos,
      });
      txs.push(...(Array.isArray(claimTxs) ? claimTxs : [claimTxs]));
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('no fee')) {
        console.warn(`[evilPanda] claimSwapFee attempt failed: ${msg}`);
      }
    }
  }

  if (typeof dlmmPool.closePositionIfEmpty === 'function') {
    try {
      const closeIfEmptyTxs = await dlmmPool.closePositionIfEmpty({
        owner: wallet.publicKey,
        position: activePos,
      });
      txs.push(...(Array.isArray(closeIfEmptyTxs) ? closeIfEmptyTxs : [closeIfEmptyTxs]));
      if (txs.length > 0) return txs;
    } catch (e) {
      console.warn(`[evilPanda] closePositionIfEmpty attempt failed: ${e.message}`);
    }
  }

  if (typeof dlmmPool.closePosition === 'function') {
    try {
      const closeTxs = await dlmmPool.closePosition({
        owner: wallet.publicKey,
        position: activePos,
      });
      txs.push(...(Array.isArray(closeTxs) ? closeTxs : [closeTxs]));
      if (txs.length > 0) return txs;
    } catch (e) {
      console.warn(`[evilPanda] closePosition attempt failed: ${e.message}`);
    }
  }

  if (txs.length > 0) return txs;
  throw new Error(`NO_CLOSE_METHOD_AVAILABLE_${activePos.publicKey.toString().slice(0, 8)}`);
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
  const wallet     = getWallet();
  const poolPubkey = new PublicKey(poolAddress);
  const hasNonRefundableFees = await resolveNonRefundableFeeFlag(
    poolAddress,
    deployOptions?.hasNonRefundableFees ?? null,
  );

  console.log(`[evilPanda] ▶ deployPosition pool=${poolAddress.slice(0,8)} sol=${deploySol}`);

  return withPermanentAwareBackoff(async () => {
    await reconcileZombiePositions().catch((e) => {
      console.warn(`[evilPanda] Zombie reconcile non-fatal: ${e.message}`);
    });

    if (hasTrackedPoolPosition(poolAddress)) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} already has an active or pending position`);
    }

    const dlmmPool  = await DLMM.create(connection, poolPubkey);
    await dlmmPool.refetchStates();
    const initialActiveBin = await dlmmPool.getActiveBin();
    let activeBin = initialActiveBin;
    const binStep   = dlmmPool.lbPair.binStep;

    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();
    const [, yMeta] = await resolveTokens([xMint, yMint]);
    const yDecimals  = yMeta.decimals; // SOL = 9
    const isSOLPair  = yMint === WSOL_MINT;

    if (!isSOLPair) {
      throw new Error(`[evilPanda] Pool ${poolAddress.slice(0,8)} bukan SOL pair — Evil Panda hanya mendukung TOKEN/SOL`);
    }

    const binStepInt   = parseInt(binStep);
    const exactLogBinFactor = Math.log(1 + binStepInt / 10000);
    const offsetMinBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MIN_PCT / 100) / exactLogBinFactor)
    ) || 0;
    const offsetMaxBins = Math.round(
      Math.abs(Math.log(1 - EP_CONFIG.OFFSET_MAX_PCT / 100) / exactLogBinFactor)
    );

    let rangeMax = activeBin.binId - offsetMinBins;
    let rangeMin = activeBin.binId - offsetMaxBins;
    const rangeMaxBins = getConfiguredDeployRangeMaxBins();
    let rentCheckedRangeMin = null;
    let rentCheckedRangeMax = null;

    if ((rangeMax - rangeMin + 1) > rangeMaxBins) {
      rangeMin = rangeMax - (rangeMaxBins - 1);
    }
    if (rangeMin > rangeMax)        rangeMin = rangeMax - 2;

    const totalBins = rangeMax - rangeMin + 1;
    const microLamports = await getPriorityFee();
    const { Keypair } = await import('@solana/web3.js');
    let posKp = Keypair.generate();
    let positionPubkey = posKp.publicKey.toString();

    const cfg2          = getConfig();
    const slippageBps   = Number(cfg2.slippageBps) || 250;
    const slippagePct   = slippageBps / 100;
    const totalLamports = Math.floor(deploySol * 1e9);

    const shouldSeedTokenX = rangeMin <= activeBin.binId && rangeMax >= activeBin.binId;
    const rangeWidth = Math.max(1, rangeMax - rangeMin);
    const activeRatio = shouldSeedTokenX
      ? Math.max(0, Math.min(1, (activeBin.binId - rangeMin) / rangeWidth))
      : 0;
    const seedPctOverride = Number(cfg2.deployTokenXSeedPct || cfg2.deployXSeedPct || 0);
    const defaultSeedPct = shouldSeedTokenX
      ? Math.max(10, Math.min(40, Math.round(40 - (activeRatio * 30))))
      : 0;
    const seedPct = Number.isFinite(seedPctOverride) && seedPctOverride > 0
      ? Math.max(1, Math.min(60, seedPctOverride))
      : defaultSeedPct;
    const seedLamports = Math.max(0, Math.floor(totalLamports * (seedPct / 100)));

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
          `<i>Range awal menyentuh bin array baru, jadi bot geser ke slice yang masih rent-free dan tetap lanjut deploy.</i>`
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
          body: stringify({
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

    if (!isDryRun() && shouldSeedTokenX && seedLamports >= 1_000_000 && seedLamports < totalLamports) {
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
    } else if (isDryRun() && shouldSeedTokenX && seedLamports >= 1_000_000 && seedLamports < totalLamports) {
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
        strategyType: SPOT_STRATEGY_TYPE,
      });
    } catch (preflightErr) {
      console.error(
        `[evilPanda] DLMM_PRECHECK_FAIL pool=${poolAddress} active=${String(activeBin?.binId)} ` +
        `range=[${rangeMin},${rangeMax}] amountX=${amountXBn.toString()} amountY=${amountYBn.toString()} ` +
        `shouldSeedTokenX=${shouldSeedTokenX} seedSwapSucceeded=${amountXBn.gt(new BN('0'))} ` +
        `strategyType=${SPOT_STRATEGY_TYPE} slippage=${slippagePct}% reason=${preflightErr.message}`
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
        refetchStatesFn: async () => {
          if (dlmmPool?.refetchStates) await dlmmPool.refetchStates();
        },
        getActiveBinFn: async () => {
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
              sdkMethod: isDryRun() ? 'dryRunPlan' : 'addLiquidityByWeight',
            });
            console.log(
              `[evilPanda] DLMM_WEIGHT_DIST pool=${poolAddress.slice(0,8)} bins=${distribution.length} totalYBps=${totalYBps.toString()} ` +
              `attempt=${Number(state?.attempt || 0)}`
            );
            if (isDryRun()) {
              const dryRunPlan = buildQuoteOnlyDryRunPlan({
                poolAddress,
                deployArgs: args,
                xYAmountDistribution: distribution,
                finalArgsContext: state?.finalArgsContext || {},
              });
              state.finalArgsContext = {
                ...(state?.finalArgsContext || {}),
                ...(dryRunPlan?.context || {}),
              };
              return dryRunPlan;
            }
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
                  const sig = await connection.sendTransaction(tx, [wallet, statePositionKeypair], { skipPreflight: false, maxRetries: 3 });
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

      if (isDryRun()) {
        for (const tx of txList) {
          injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
          if (tx instanceof VersionedTransaction) {
            tx.sign([wallet, posKp]);
          } else {
            tx.sign(posKp, wallet);
          }
          const sim = await connection.simulateTransaction(tx, { commitment: 'processed' });
          if (sim?.value?.err) {
            throw new Error(`DRY_RUN_SIMULATION_FAILED: ${stringify(sim.value.err)}`);
          }
        }
        console.log(`[DRY RUN] deployPosition simulated only: pool=${poolAddress.slice(0,8)} pos=${positionPubkey.slice(0,8)} txs=${txList.length}`);
        return {
          dryRun: true,
          simulated: true,
          positionPubkey,
          poolAddress,
          rangeMin: safeRangeMin,
          rangeMax: safeRangeMax,
          txCount: txList.length,
        };
      }

      await setPositionLifecycle(positionPubkey, 'deploying', {
        poolAddress,
        deploySol,
        deployedAt: nowIso(),
        tokenXMint: xMint,
        tokenYMint: yMint,
        rangeMin: safeRangeMin,
        rangeMax: safeRangeMax,
        entryActiveBin: safeNum(activeBin.binId, 0),
        entryPrice: safeNum(activeBin.pricePerToken, 0),
        hwmPct: 0,
      }, { flush: true });

      try {
        for (const tx of txList) {
          injectPriorityFee(tx, { units: EP_CONFIG.COMPUTE_UNITS, microLamports });
          const sig = await connection.sendTransaction(tx, [wallet, posKp], { skipPreflight: false, maxRetries: 3 });
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
      poolAddress,
      deploySol,
      deployedAt:  nowIso(),
      tokenXMint:  xMint,
      tokenYMint:  yMint,
      rangeMin: safeRangeMin,
      rangeMax: safeRangeMax,
      entryActiveBin: safeNum(activeBin.binId, 0),
      entryPrice: safeNum(activeBin.pricePerToken, 0),
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

// ── 2. monitorPnL ─────────────────────────────────────────────────

/**
 * @typedef {Object} PnLStatus
 * @property {'HOLD'|'TAKE_PROFIT'|'STOP_LOSS'|'MANUAL_CLOSED'|'ERROR'} action
 * @property {number}  currentValueSol
 * @property {number}  pnlPct
 * @property {boolean} inRange
 * @property {string}  [exitScenario]  - 'A' atau 'B' jika exit dipicu TA
 * @property {string}  [exitReason]    - Human-readable reason
 */

/**
 * Poll on-chain + Meridian TA sekali, tentukan action.
 * Priority: Hard SL (-10%) > Skenario TA (A/B).
 * Fail-open: jika Meridian API down, TA-exit tidak dipicu.
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
    // ── On-chain: ambil nilai posisi saat ini ──────────────────────
    const connection = getConnection();
    const wallet     = getWallet();
    const dlmmPool   = await DLMM.create(connection, new PublicKey(reg.poolAddress));
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
    const feeOnlyPnl = await calculateFeeOnlyPnl({
      feeXRaw: pd.feeX?.toString() || '0',
      feeYRaw: pd.feeY?.toString() || '0',
      xDec,
      yDec,
      tokenXMint: reg.tokenXMint,
      deploySol: reg.deploySol,
      activeBinPrice: rawPrice,
    });

    const totalXRawToSell = Math.floor((totalXUi + feeXUi) * Math.pow(10, xDec)).toString();

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
    const inRange = activeBin.binId >= reg.rangeMin && activeBin.binId <= reg.rangeMax;
    const entryActiveBin = Number.isFinite(Number(reg.entryActiveBin)) ? Number(reg.entryActiveBin) : null;
    const entryPrice = Number.isFinite(Number(reg.entryPrice)) ? Number(reg.entryPrice) : null;

    // ── PRIORITAS 1: Hard Stop Loss ───────────────────────────────────────
    const stopLossPct = getConfiguredStopLossPct();
    if (pnlPct <= -stopLossPct) {
      console.log(`[evilPanda] 🛑 STOP_LOSS ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}%`);
      return { action: 'STOP_LOSS', currentValueSol, pnlPct, ...feeOnlyPnl, inRange,
               exitReason: `Hard SL: PnL=${pnlPct.toFixed(2)}% ≤ -${stopLossPct}%` };
    }

    // ── PRIORITAS 2: Trailing Profit Lock berbasis config ────────────────
    // Perbarui HWM jika PnL saat ini lebih tinggi dari sebelumnya.
    // Jika PnL turun > trailingDropPct dari HWM setelah trigger tercapai → TAKE_PROFIT.
    const trailingTriggerPct = getConfiguredTrailingTriggerPct();
    const trailingDropPct    = getConfiguredTrailingDropPct();

    if (pnlPct > reg.hwmPct) {
      reg.hwmPct = pnlPct; // update HWM in-place (Map entry adalah referensi)
      console.log(`[evilPanda] 📈 New HWM: ${reg.hwmPct.toFixed(2)}%`);
    }

    const trailingArmed = trailingTriggerPct > 0 ? reg.hwmPct >= trailingTriggerPct : reg.hwmPct > 0;
    if (trailingDropPct > 0 && trailingArmed && (reg.hwmPct - pnlPct) >= trailingDropPct) {
      const drawdown = reg.hwmPct - pnlPct;
      console.log(`[evilPanda] 📈 TAKE_PROFIT (TRAILING) ${positionPubkey.slice(0,8)} hwm=${reg.hwmPct.toFixed(2)}% pnl=${pnlPct.toFixed(2)}% drop=${drawdown.toFixed(2)}%`);
      return {
        action:       'TAKE_PROFIT',
        currentValueSol, pnlPct, ...feeOnlyPnl, inRange,
        exitScenario: 'TRAILING_PROFIT',
        exitReason:   `Trailing TP: turun ${drawdown.toFixed(2)}% dari HWM ${reg.hwmPct.toFixed(2)}% (trigger ${trailingTriggerPct}%, drop ${trailingDropPct}%)`,
      };
    }

    // ── TA Insight only (tidak memutuskan exit) ─────────────────────────
    // Fetch RSI(2) + BB + MACD dari Meridian, fail-open jika API down.
    const signal     = await fetchExitSignal(reg.tokenXMint);
    const exitDecision = evaluateExitSignal(signal);

    console.log(`[evilPanda] 📊 ${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% val=${currentValueSol.toFixed(4)}SOL | TA info: ${exitDecision.reason}`);

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
      taReason: exitDecision.reason,
      taSignal: signal ? {
        rsi: signal.rsi,
        close: signal.close,
        bbUpper: signal.bbUpper,
        macdHist: signal.macdHist,
        direction: signal.direction,
      } : null,
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
  const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
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
 * @returns {Promise<{ solRecovered: number }>}
 */
export async function exitPosition(positionPubkey, reason = 'MANUAL') {
  const reg = _activePositions.get(positionPubkey);
  if (!reg) throw new Error(`[evilPanda] exitPosition: ${positionPubkey.slice(0,8)} not in registry`);

  console.log(`[evilPanda] ▶ exitPosition ${positionPubkey.slice(0,8)} reason=${reason}`);

  const connection = getConnection();
  const wallet     = getWallet();
  const microLamports = await getPriorityFee();
  const isEmergencyExit = /STOP_LOSS|SCENARIO_C|SUPPORT|TRAILING|BEARISH|PANIC|OUT_OF_RANGE/i.test(String(reason || ''));

  try {
    return await withExitAccountingLock(() => withExponentialBackoff(async () => {
      const preSwapLamports = await connection.getBalance(wallet.publicKey);
      const dlmmPool = await DLMM.create(connection, new PublicKey(reg.poolAddress));
      await dlmmPool.refetchStates().catch(() => {});
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const activePos = userPositions.find(p => p.publicKey.toString() === positionPubkey);

      if (!activePos) {
        if (isDryRun()) {
          console.log(`[DRY RUN] exitPosition skipped: ${positionPubkey.slice(0,8)} not found on-chain`);
          return { dryRun: true, skipped: true, reason: 'POSITION_NOT_FOUND_ON_CHAIN' };
        }
        return await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED_DURING_EXIT');
      }

      if (!activePos.positionData || activePos.positionData.lowerBinId === undefined) {
        if (isDryRun()) {
          console.log(`[DRY RUN] exitPosition skipped: ${positionPubkey.slice(0,8)} position data incomplete`);
          return { dryRun: true, skipped: true, reason: 'POSITION_DATA_INCOMPLETE' };
        }
        const msg = `POSITION_STATE_AMBIGUOUS_${positionPubkey.slice(0,8)}`;
        console.log(`[evilPanda] ❌ ${msg}: Data posisi tidak lengkap / undefined. Registry ditahan untuk manual reconcile.`);
        await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
          manualReconcileReason: 'incomplete position data or RPC timeout',
          closeReason: reason,
        }, { flush: true });
        throw new Error(msg);
      }

      if (isDryRun()) {
        const dryRunTxList = await buildClosePositionTxs(dlmmPool, wallet, activePos);
        for (const tx of dryRunTxList) {
          injectPriorityFee(tx, { units: EP_CONFIG.EXIT_COMPUTE_UNITS, microLamports: isEmergencyExit ? Math.max(microLamports * 5, microLamports) : microLamports });
          if (tx instanceof VersionedTransaction) {
            tx.sign([wallet]);
          } else {
            tx.sign(wallet);
          }
          const sim = await connection.simulateTransaction(tx, { commitment: 'processed' });
          if (sim?.value?.err) {
            throw new Error(`DRY_RUN_SIMULATION_FAILED: ${stringify(sim.value.err)}`);
          }
        }

        console.log(`[DRY RUN] exitPosition simulated only: pos=${positionPubkey.slice(0,8)} txs=${dryRunTxList.length}`);
        return { dryRun: true, solRecovered: 0, simulated: true, txCount: dryRunTxList.length };
      }

      await setPositionLifecycle(positionPubkey, 'closing', { closeReason: reason }, { flush: true });

      // Snapshot fee composition sebelum close untuk accounting split.
      let estimatedFeeSol = 0;
      let estimatedFeePct = 0;
      let estimatedFeeSource = 'none';
      let estimatedFeeAvailable = false;
      try {
        const pd = activePos.positionData;
        const [xMeta, yMeta] = await resolveTokens([reg.tokenXMint, reg.tokenYMint]);
        const xDec = xMeta.decimals || 9;
        const yDec = yMeta.decimals || 9;
        const feeOnly = await calculateFeeOnlyPnl({
          feeXRaw: pd.feeX?.toString() || '0',
          feeYRaw: pd.feeY?.toString() || '0',
          xDec,
          yDec,
          tokenXMint: reg.tokenXMint,
          deploySol: reg.deploySol,
          activeBinPrice: safeNum((await dlmmPool.getActiveBin())?.pricePerToken, 0),
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
      }

      // 1. Remove all liquidity and request account close.
      const removeTxList = await buildClosePositionTxs(dlmmPool, wallet, activePos);
      const removeSignatures = [];
      const exitMicroLamports = isEmergencyExit ? Math.max(microLamports * 5, microLamports) : microLamports;
      for (const tx of removeTxList) {
        const sig = await sendExitTx(connection, wallet, tx, exitMicroLamports);
        removeSignatures.push(sig);
        console.log(`[evilPanda] Remove liquidity TX confirmed: ${sig.slice(0,8)}`);
      }

      // Some DLMM accounts need a fresh-state cleanup after fees/rewards settle.
      for (let cleanupAttempt = 1; cleanupAttempt <= 3; cleanupAttempt++) {
        await sleep(cleanupAttempt === 1 ? 6000 : 4000);
        const isClosed = await verifyPositionClosedOnChain(connection, wallet, reg.poolAddress, positionPubkey, {
          attempts: 1,
          delayMs: 0,
        });
        if (isClosed) break;

        const { dlmmPool: freshPool, activePos: freshPos } = await getFreshActivePosition(
          connection,
          wallet,
          reg.poolAddress,
          positionPubkey,
        );
        if (!freshPos) {
          continue;
        }

        console.warn(`[evilPanda] Position masih open setelah remove; cleanup attempt ${cleanupAttempt}/3`);
        const cleanupTxList = await buildClosePositionTxs(freshPool, wallet, freshPos);
        for (const tx of cleanupTxList) {
          const sig = await sendExitTx(connection, wallet, tx, exitMicroLamports);
          removeSignatures.push(sig);
          console.log(`[evilPanda] Cleanup close TX confirmed: ${sig.slice(0,8)}`);
        }
      }

      // 2. Swap sisa token non-SOL → SOL (jika ada)
      let solRecovered = 0;
      try {
        const residualMints = [...new Set([reg.tokenXMint, reg.tokenYMint].filter((mint) => mint && mint !== WSOL_MINT))];
        for (const mint of residualMints) {
          const rawBalance = await getTokenBalanceRaw(mint);
          if (String(rawBalance || '0') === '0') continue;
          console.log(`[evilPanda] Swap residual token → SOL: ${mint.slice(0, 8)} amountRaw=${rawBalance}`);
          // legacy marker: swapToSol(mint, rawBalance, null, { isUrgent: true })
          const swapOptions = { isUrgent: true };
          if (isEmergencyExit) {
            swapOptions.isEmergencyExit = true;
            swapOptions.emergencySlippageBps = Number(getConfig().emergencyExitSlippageBps || 1000);
          }
          const swapResult = await swapToSol(mint, rawBalance, null, swapOptions);
          if (!swapResult?.success && !swapResult?.skipped) {
            console.warn(`[evilPanda] Swap residual token gagal untuk ${mint.slice(0,8)}: ${swapResult?.reason || 'SWAP_FAILED'}`);
          }
        }
      } catch (e) {
        console.warn(`[evilPanda] Swap sisa token gagal (tidak fatal): ${e.message}`);
      }
      const postSwapLamports = await connection.getBalance(wallet.publicKey);
      solRecovered = (postSwapLamports - preSwapLamports) / 1e9;
      const txFeeLamports = await estimateTxFeeLamports(connection, removeSignatures);
      const txFeeSol = txFeeLamports / 1e9;

      // 3. Verifikasi posisi benar-benar sudah close di chain
      const isClosedOnChain = await verifyPositionClosedOnChain(connection, wallet, reg.poolAddress, positionPubkey, {
        attempts: 3,
        delayMs: 1200,
      });
      if (!isClosedOnChain) {
        await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
          manualReconcileReason: 'close verification failed',
          closeReason: reason,
        }, { flush: true });
        throw new Error(`POSITION_STILL_OPEN_AFTER_EXIT_${positionPubkey.slice(0,8)}`);
      }

      // 4. Bersihkan registry lokal setelah verifikasi close sukses
      _activePositions.delete(positionPubkey);
      await persistActivePositionsStateNow();
      clearPositionRuntimeState(positionPubkey);
      clearQuoteOnlyDeployMarker(positionPubkey);
      console.log(`[evilPanda] ✅ Position closed & verified: ${positionPubkey.slice(0,8)} | reason=${reason}`);

      // 5. Harvest Log + Ledger + Blacklist
      const tokenSymbol = reg.tokenXMint?.slice(0,8) || 'UNKNOWN';
      const pnlTotalSol = solRecovered - reg.deploySol;
      const feePnlSol = Math.max(0, estimatedFeeSol);
      const pricePnlSol = pnlTotalSol - feePnlSol;
      const finalPnlPct = reg.deploySol > 0
        ? (pnlTotalSol / reg.deploySol) * 100
        : 0;
      const normalizedReason = normalizeExitReason(reason, { pnlPct: finalPnlPct, pnlSol: pnlTotalSol });
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
        closedAt: nowIso(),
        reason,
        capitalInSol: reg.deploySol || 0,
        capitalOutSol: solRecovered,
        pnlTotalSol,
        pnlTotalPct: finalPnlPct,
        feePnlSol,
        pricePnlSol,
        txCostSol: txFeeSol,
        normalizedReason,
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
        solRecovered,
        feePnlSol,
        feePnlPct: estimatedFeePct,
        feePnlSource: estimatedFeeSource,
        feePnlAvailable: estimatedFeeAvailable,
        pnlTotalSol,
        pnlTotalPct: finalPnlPct,
        exitReason: normalizedReason,
        rawExitReason: reason,
      };

    }, { maxRetries: 2, baseDelay: 3000 }));
  } catch (e) {
    if (_activePositions.has(positionPubkey)) {
      await setPositionLifecycle(positionPubkey, 'needs_manual_reconcile', {
        manualReconcileReason: e?.message || 'exit failed before on-chain verification',
        closeReason: reason,
      }, { flush: true });
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
  appendHarvestLog({
    token: tokenSymbol,
    positionPubkey,
    pnlPct: 0,
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
    accountingStatus: 'manual_close_pnl_unknown',
    manualCloseDetected: true,
  });
  recordPoolOutcome({
    key: reg.poolAddress || reg.tokenXMint,
    tokenMint: reg.tokenXMint || '',
    poolAddress: reg.poolAddress || '',
    symbol: tokenSymbol,
    pnlPct: 0,
    pnlSol: 0,
    reason: normalizedReason,
    snapshot: { rawReason: reason },
  });

  const symbol = reg.tokenXMint?.slice(0, 8) || 'UNKNOWN';
  const pool   = reg.poolAddress?.slice(0, 8) || 'UNKNOWN';
  await notify(
    `ℹ️ <b>Manual close terdeteksi</b>\n` +
    `Token: <b>${symbol}</b>\n` +
    `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` +
    `Pool: <code>${pool}</code>\n` +
    `Alasan: <code>${reason}</code>\n` +
    `<i>Posisi dihapus dari registry lokal dan akan direconcile jika masih ada sisa state.</i>`
  );
  console.log(`[evilPanda] Manual close recorded: ${positionPubkey.slice(0,8)} | token=${symbol} | reason=${reason}`);
  return { ok: true, solRecovered: 0, manualCloseDetected: true };
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

export { EP_CONFIG };
