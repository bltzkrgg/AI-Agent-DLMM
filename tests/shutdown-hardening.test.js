import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const indexPath = resolve(process.cwd(), 'src/index.js');
const hunterPath = resolve(process.cwd(), 'src/agents/hunterAlpha.js');
const evilPandaPath = resolve(process.cwd(), 'src/sniper/evilPanda.js');
const analystPath = resolve(process.cwd(), 'src/market/analyst.js');

test('shutdown orchestration calls close + retry helpers', () => {
  const src = readFileSync(indexPath, 'utf8');
  assert.match(src, /closeAllActivePositionsForShutdown/);
  assert.match(src, /retryFailedShutdownPositions/);
  assert.match(src, /setShutdownInProgress\(true\)/);
});

test('hunter has shutdown guard and closing idempotency guard', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /let _shutdownInProgress = false/);
  assert.match(src, /const _closingPositions = new Set\(\)/);
  assert.match(src, /if \(_shutdownInProgress\)/);
  assert.match(src, /if \(_closingPositions\.has\(positionPubkey\)\)/);
});

test('evilPanda enforces on-chain close verification before success', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /async function verifyPositionClosedOnChain/);
  assert.match(src, /POSITION_STILL_OPEN_AFTER_EXIT_/);
  assert.match(src, /Position closed & verified/);
});

test('manual close helper records manual withdrawals when called explicitly', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(hunterSrc, /setPositionLifecycle/);
  assert.match(hunterSrc, /getPositionOnChainStatus/);
  assert.match(hunterSrc, /export function startManualCloseWatcher/);
  assert.match(evilPandaSrc, /export async function markPositionManuallyClosed/);
  assert.match(evilPandaSrc, /export async function setPositionLifecycle/);
  assert.match(evilPandaSrc, /export async function getPositionOnChainStatus/);
  assert.match(evilPandaSrc, /Manual close terdeteksi/);
  assert.match(evilPandaSrc, /console\.log\(`\[evilPanda\] ℹ️ Manual close realtime:/);
  assert.match(hunterSrc, /action === 'MANUAL_CLOSED'/);
  assert.match(hunterSrc, /const manualCloseReason = String\(status\?\.note \|\| status\?\.reason \|\| 'MANUAL_WITHDRAW_DETECTED'\)\.trim\(\) \|\| 'MANUAL_WITHDRAW_DETECTED'/);
  assert.doesNotMatch(hunterSrc, /Manual close terdeteksi/);
  assert.match(hunterSrc, /MANUAL_CLOSE_TELEGRAM_SENT/);
  assert.match(hunterSrc, /shouldAlertManualClose/);
  assert.match(hunterSrc, /closeFailureMeta/);
  assert.match(evilPandaSrc, /function hasManualCloseAccountingSnapshot/);
  assert.match(evilPandaSrc, /if \(reg\?\.feePnlAvailable === true\) return true/);
  assert.match(evilPandaSrc, /if \(feeSource === 'none' \|\| feeSource === 'fast_path'\) return false/);
  assert.match(evilPandaSrc, /function buildManualCloseAccounting/);
  assert.match(evilPandaSrc, /manual_close_reconciled_from_snapshot/);
  assert.match(evilPandaSrc, /manual_close_pnl_unknown/);
  assert.match(evilPandaSrc, /buildClosedPositionReport\(\{/);
  assert.match(evilPandaSrc, /exitLabel: 'Manual Close via Meteora'/);
  assert.match(evilPandaSrc, /rangeLabel: 'Range at Last Check'/);
  assert.match(evilPandaSrc, /estimated: hasReconciledSnapshot/);
  assert.match(evilPandaSrc, /feesFromLastSnapshot: manualAccounting\.feePnlAvailable/);
  assert.match(hunterSrc, /function resolveTrackedFeeSnapshot/);
  assert.match(hunterSrc, /if \(hasTrackedFeeSnapshot\(status\)\)/);
  assert.match(evilPandaSrc, /appendHarvestLog\(\{\n\s*token: tokenSymbol,\n\s*positionPubkey,/);
  assert.match(evilPandaSrc, /recordPoolOutcome\(\{\n\s*key: reg\.poolAddress \|\| reg\.tokenXMint,/);
  assert.match(hunterSrc, /feePnlSol,/);
  assert.match(hunterSrc, /feePnlPct,/);
  assert.match(evilPandaSrc, /feePnlSol: Math\.max\(0, safeNum\(row\.feePnlSol, 0\)\),/);
  assert.match(evilPandaSrc, /feePnlPct: Math\.max\(0, safeNum\(row\.feePnlPct, 0\)\),/);
});

test('jito tip injection is removed from normal runtime send paths', () => {
  const jupiterSrc = readFileSync(resolve(process.cwd(), 'src/solana/jupiter.js'), 'utf8');
  const meteoraSrc = readFileSync(resolve(process.cwd(), 'src/solana/meteora.js'), 'utf8');
  assert.doesNotMatch(jupiterSrc, /tipAmount = 1000000/);
  assert.doesNotMatch(jupiterSrc, /Jito Anti-MEV Enabled/);
  assert.doesNotMatch(jupiterSrc, /tipIx/);
  assert.doesNotMatch(meteoraSrc, /tipAmount = 1000000/);
  assert.doesNotMatch(meteoraSrc, /Jito Shield Active/);
  assert.doesNotMatch(meteoraSrc, /getJitoTipAddresses/);
});

test('legacy meteora deploy path resolves strategyType from dlmmLiquidityShape config', () => {
  const meteoraSrc = readFileSync(resolve(process.cwd(), 'src/solana/meteora.js'), 'utf8');
  assert.match(meteoraSrc, /function resolveDlmmStrategyTypeFromConfig/);
  assert.match(meteoraSrc, /DLMM_SHAPE_RUNTIME raw=/);
  assert.match(meteoraSrc, /strategyType:\s*resolvedStrategyType/);
  assert.doesNotMatch(meteoraSrc, /strategyType:\s*0/);
});

test('index starts manual close watcher during boot', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  assert.match(indexSrc, /startManualCloseWatcher/);
  assert.match(indexSrc, /const manualCloseWatcherStarted = startManualCloseWatcher\(\)/);
  assert.match(indexSrc, /AI-Agent-DLMM Activated/);
});

test('index logs full runtime error details for uncaughtException and unhandledRejection', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  assert.match(indexSrc, /function formatRuntimeErrorForLog\(reason\)/);
  assert.match(indexSrc, /reason instanceof Error/);
  assert.match(indexSrc, /return reason\.stack \|\|/);
  assert.match(indexSrc, /reason\.name \|\| 'Error'/);
  assert.match(indexSrc, /reason\.message \|\| 'unknown error'/);
  assert.match(indexSrc, /console\.error\('❌ uncaughtException:\\n', formatRuntimeErrorForLog\(e\)\)/);
  assert.match(indexSrc, /console\.error\('❌ unhandledRejection:\\n', formatRuntimeErrorForLog\(reason\)\)/);
});

test('WATCH telegram banner shows candidate status values instead of generic PASS labels', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(hunterSrc, /- Slot: <code>\$\{slotUsed\}\/\$\{slotMax\}<\/code>/);
  assert.match(hunterSrc, /- Trend M15: <code>\$\{entrySignals\.taTrend \|\| 'UNKNOWN'\}<\/code>/);
  assert.match(hunterSrc, /- Timing: <code>\$\{entrySignals\.entryTimingState \|\| 'UNKNOWN'\}<\/code>/);
  assert.match(hunterSrc, /- Safety: <code>SCOUT_OK<\/code>/);
  assert.match(hunterSrc, /Watcher aktif - kandidat dipantau\./);
  assert.doesNotMatch(hunterSrc, /- Trend M15: PASS/);
  assert.doesNotMatch(hunterSrc, /- Timing: PASS/);
  assert.doesNotMatch(hunterSrc, /- Safety: PASS/);
});

test('WATCH and ready queue both honor reentry discipline for same-mint post-loss retries', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const poolMemorySrc = readFileSync(resolve(process.cwd(), 'src/market/poolMemory.js'), 'utf8');
  assert.match(hunterSrc, /evaluatePoolReentryDiscipline/);
  assert.match(hunterSrc, /Reentry hold: \$\{symbol\}/);
  assert.match(hunterSrc, /row\.lastReason = `Reentry hold: \$\{reentryDecision\.reason\}`/);
  assert.match(poolMemorySrc, /export function evaluatePoolReentryDiscipline/);
  assert.match(poolMemorySrc, /REENTRY_RESET_OK/);
  assert.match(poolMemorySrc, /REENTRY_WAIT_AFTER_LOSS_/);
});

test('direct deploy path refreshes final market snapshot before final ST and candle gates', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(hunterSrc, /const finalMarketSnapshot = await getDeployQueueLiveSnapshot\(\s*tokenMint,\s*poolAddress \|\| null,\s*symbol,\s*\{/s);
  assert.match(hunterSrc, /bypassCache:\s*true/);
  assert.match(hunterSrc, /Final snapshot unavailable; waiting fresh market snapshot/);
  assert.match(hunterSrc, /Final snapshot unreliable; waiting reliable live snapshot/);
  assert.match(hunterSrc, /winner\._marketSnapshot = finalMarketSnapshot/);
  assert.match(hunterSrc, /winner\._entrySignals = finalEntrySignals/);
  assert.match(hunterSrc, /ensureFinalSupertrendBullish\(\{\s*mint: tokenMint,\s*symbol,\s*pool: winner,\s*meta: \{\},\s*liveSnapshot: finalMarketSnapshot \|\| null,\s*currentPrice: finalCurrentPrice,\s*\}\)/s);
  assert.match(hunterSrc, /ensureFinalEntryCandleSanity\(\{\s*mint: tokenMint,\s*symbol,\s*pool: winner,\s*meta: \{\},\s*liveSnapshot: finalMarketSnapshot \|\| null,\s*\}\)/s);
  assert.match(hunterSrc, /const proximityDecision = getFinalEntryProximityDecision\(/);
  assert.match(hunterSrc, /FINAL_PROXIMITY_HOLD/);
});

test('telegram exit command closes all active positions with verification summary', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(indexSrc, /closeAllActivePositionsByUser\('MANUAL_COMMAND'/);
  assert.match(indexSrc, /closeAllActivePositionsByUser\('MANUAL_COMMAND', 180_000\)/);
  assert.match(indexSrc, /Manual exit selesai dan verified/);
  assert.match(indexSrc, /Manual exit belum bersih/);
  assert.match(hunterSrc, /export async function closeAllActivePositionsByUser/);
  assert.match(hunterSrc, /timeoutMs = 180_000/);
  assert.match(hunterSrc, /MANUAL_EXIT_NOT_VERIFIED/);
});

test('/stop pauses autonomous discovery without disabling operator commands', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const queueSrc = readFileSync(resolve(process.cwd(), 'src/utils/pendingDeployQueue.js'), 'utf8');
  const stopStart = indexSrc.indexOf('bot.onText(/\\/stop$/');
  assert.notEqual(stopStart, -1);
  const stopEnd = indexSrc.indexOf('// /exit', stopStart);
  const stopBlock = indexSrc.slice(stopStart, stopEnd);

  assert.match(indexSrc, /const OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused'/);
  assert.match(indexSrc, /function pauseDiscovery/);
  assert.match(indexSrc, /function resumeDiscovery/);
  assert.match(stopBlock, /pauseDiscovery\('TELEGRAM_STOP'\)/);
  assert.match(stopBlock, /stopAutoScreeningRuntime\(\)/);
  assert.match(stopBlock, /Existing positions are not force-closed/);
  assert.doesNotMatch(stopBlock, /bot\.stopPolling\(/);
  assert.doesNotMatch(stopBlock, /closeAllActivePositions/);

  assert.match(indexSrc, /async function resumeAutoScreeningRuntime/);
  assert.match(indexSrc, /resumeDiscovery\(source\);/);
  assert.match(indexSrc, /await resumeAutoScreeningRuntime\(chatId, \{ snapshotTopPools: false, source: 'TELEGRAM_AUTOSCREEN_ON' \}\);/);
  assert.match(indexSrc, /const wasPaused = isDiscoveryPaused\(\);/);
  assert.match(indexSrc, /resumeDiscovery\('TELEGRAM_HUNT'\)/);
  assert.match(indexSrc, /resumeDiscovery\('TELEGRAM_SCREENING_ON'\)/);
  assert.match(indexSrc, /Screening is paused by <code>\/stop<\/code>/);
  assert.match(indexSrc, /if \(isDiscoveryPaused\(\) && !manualTaExitEnabled\)/);
  assert.match(indexSrc, /await bot\.sendMessage\(chatId, `⏸️ \$\{getPausedMessage\(\)\}`/);
  assert.match(indexSrc, /const discoveryPaused = isDiscoveryPaused\(\)/);
  assert.match(indexSrc, /AUTOSCREEN_STARTUP_DISABLED/);
  assert.match(indexSrc, /manual_command_required/);
  assert.match(indexSrc, /runScreeningLoop\(\);/);
  assert.doesNotMatch(indexSrc, /startupScan=true/);

  assert.match(hunterSrc, /OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused'/);
  assert.match(hunterSrc, /policy: 'OPERATOR_DISCOVERY_PAUSED'/);
  assert.match(queueSrc, /OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused'/);
  assert.match(queueSrc, /if \(isOperatorDiscoveryPaused\(\)\) \{\s*_watcherTimer = null;\s*return;/);
});

test('/autoscreen on and setconfig autoScreeningEnabled=true resume screening after /stop', () => {
  const src = readFileSync(indexPath, 'utf8');

  assert.match(src, /async function resumeAutoScreeningRuntime/);
  assert.match(src, /resumeDiscovery\(source\);/);
  assert.match(src, /await resumeAutoScreeningRuntime\(chatId, \{ snapshotTopPools: false, source: 'TELEGRAM_AUTOSCREEN_ON' \}\);/);
  assert.match(src, /const wasPaused = isDiscoveryPaused\(\);/);
  assert.match(src, /const loopWasRunning = Boolean\(_screeningLoopTimer\);/);
  assert.match(src, /TELEGRAM_SETCONFIG_AUTO_SCREENING_ON/);
  assert.match(src, /runScreeningLoop\(\);/);
  assert.doesNotMatch(src, /Config disimpan, tetapi discovery\/deploy masih paused by <code>\/stop<\/code>/);
});

test('autoscreen scheduler no longer pauses just because active positions exist', () => {
  const src = readFileSync(indexPath, 'utf8');
  assert.match(src, /AUTO_SCREENING_ACTIVE_POSITION_PAUSE_KEY = 'autoScreeningPausedByActivePositions'/);
  assert.match(src, /setAutoScreeningPausedByActivePositions/);
  assert.match(src, /isAutoScreeningPausedByActivePositions/);
  assert.match(src, /syncAutoScreeningWithActivePositions/);
  assert.match(src, /getActivePositionCount\(\)/);
  assert.doesNotMatch(src, /runImmediateAutoscreenScan[\s\S]*policy: 'ACTIVE_POSITIONS_OPEN'/);
  assert.doesNotMatch(src, /runSilentScan[\s\S]*policy: 'ACTIVE_POSITIONS_OPEN'/);
  assert.doesNotMatch(src, /startAutoScreeningRuntime[\s\S]*stopScreeningLoop\(\);[\s\S]*return false;/);
  assert.doesNotMatch(src, /runScreeningLoop[\s\S]*const activePositionGate = syncAutoScreeningWithActivePositions\('screening-loop'\)/);
  assert.doesNotMatch(src, /startAutoScreeningRuntime\(chatId, \{ snapshotTopPools: true \}\)/);
});

test('evilPanda uses monolith positions with one Meteora account for the full range', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /let posKp = paperMode \? null : Keypair\.generate\(\)/);
  assert.match(src, /const desiredRangeMin = activeBinId \+ minOffset;/);
  assert.match(src, /const desiredRangeMax = activeBinId \+ maxOffset;/);
  assert.match(src, /function getConfiguredDeployRangeMaxBins\(cfg = getConfig\(\)\)/);
  assert.match(src, /const \{ minOffset, maxOffset \} = getConfiguredDeployRangeBinOffsets\(cfg\);/);
  assert.match(src, /return Math\.max\(1, \(maxOffset - minOffset\) \+ 1\);/);
  assert.match(src, /selectRentFreeRange/);
  assert.match(src, /assertRangeDoesNotRequireBinArrayInit/);
  assert.match(src, /VETO_NON_REFUNDABLE_RENT/);
  assert.match(src, /RANGE_ADJUSTED_FOR_RENT/);
  assert.match(src, /RENT_FREE_SEARCH_SLACK_ARRAYS/);
  assert.match(src, /findAdaptiveRentFreeRange/);
  assert.match(src, /searchSlackArrays/);
  assert.match(src, /RANGE_ADJUSTED_FOR_RENT/);
  assert.match(src, /FINAL_RENT_GUARD_ADJUST/);
  assert.doesNotMatch(src, /rangeMax = activeBin\.binId - offsetMinBins - 1/);
  assert.doesNotMatch(src, /rangeMax - rangeMin > 1000/);
  assert.match(src, /initializePositionAndAddLiquidityByStrategy/);
  assert.match(src, /sendTransaction\(tx, \[wallet, posKp\]/);
  assert.match(src, /const activePos = userPositions\.find\(p => p\.publicKey\.toString\(\) === positionPubkey\)/);
});

test('operator-facing TP labels no longer describe trailing as the exit driver', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const briefingSrc = readFileSync(resolve(process.cwd(), 'src/telegram/briefing.js'), 'utf8');
  const claudeSrc = readFileSync(resolve(process.cwd(), 'src/agent/claude.js'), 'utf8');
  const configSrc = readFileSync(resolve(process.cwd(), 'src/config.js'), 'utf8');

  assert.match(indexSrc, /formatTakeProfitRiskLabel\(cfg\.takeProfitMinNetPnlPct, cfg\.stopLossPct\)/);
  assert.match(hunterSrc, /formatTakeProfitRiskLabel\(currentCfg\.takeProfitMinNetPnlPct, currentCfg\.stopLossPct\)/);
  assert.match(briefingSrc, /formatTakeProfitRiskLabel\(cfg\.takeProfitMinNetPnlPct, cfg\.stopLossPct\)/);
  assert.match(indexSrc, /Anchor: <code>DLMM active bin<\/code> \| Source: <code>frozen\/live fallback<\/code>/);
  assert.match(hunterSrc, /Anchor: DLMM active bin \| Source: frozen\/live fallback/);
  assert.match(briefingSrc, /Anchor\s*:.*DLMM active bin.*Source:.*frozen\/live fallback/s);
  assert.match(indexSrc, /TA: <code>defensive bearish \(RSI ref \$\{cfg\.smartExitRsi \|\| 90\}\)<\/code>/);
  assert.match(briefingSrc, /\| TA: <code>defensive bearish<\/code>/);
  assert.match(indexSrc, /Posisi agent tetap auto-manage dengan trailing utama \+ defensive TA saat bearish\./);
  assert.match(configSrc, /Legacy TA TP gate \(%\) — tidak dipakai pada TP trailing\/defensive saat ini/);
  assert.doesNotMatch(indexSrc, /TP: <code>Trail /);
  assert.doesNotMatch(hunterSrc, /TP: trail /);
  assert.doesNotMatch(briefingSrc, /Trail: <code>/);
  assert.doesNotMatch(claudeSrc, /Trailing TP/);
  assert.doesNotMatch(indexSrc, /TA: <code>info only/);
  assert.doesNotMatch(briefingSrc, /\| TA: <code>info only<\/code>/);
});

test('blocked deploy results are handled by hunter and queue callers', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const queueSrc = readFileSync(resolve(process.cwd(), 'src/utils/pendingDeployQueue.js'), 'utf8');
  assert.match(hunterSrc, /deployResult && typeof deployResult === 'object' && deployResult\.blocked/);
  assert.match(hunterSrc, /Deploy Ditolak/);
  assert.match(hunterSrc, /recordGate\(winner\._record, 'SCOUT_AGENT', 'DEFER'/);
  assert.match(queueSrc, /result && typeof result === 'object' && result\.blocked/);
  assert.match(queueSrc, /buildDeployFinalOutcomeTelegramMessage\(/);
  assert.match(queueSrc, /FINAL_DEPLOY_BLOCKED/);
  assert.match(queueSrc, /unwrap dan close manual dulu/);
  assert.match(queueSrc, /Adjust range gagal untuk pool\/range ini\. Pool lain tetap normal\./);
  assert.doesNotMatch(queueSrc, /Queue menghormati veto non-refundable rent/);
});

test('DLMM final args observability records anchor source and range adjustment reason', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /anchorSource = null/);
  assert.match(src, /rangeAdjustReason = null/);
  assert.match(src, /anchor=\$\{debug\.anchorSource \|\| 'unknown'\}/);
  assert.match(src, /rangeAdjust=\$\{debug\.rangeAdjustReason \|\| 'none'\}/);
  assert.match(src, /anchor=\$\{finalArgsContext\.anchorSource \|\| 'unknown'\}/);
  assert.match(src, /rangeAdjust=\$\{finalArgsContext\.rangeAdjustReason \|\| 'none'\}/);
});

test('monolith monitor treats missing active position as stop loss fail-safe', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /if \(!activePos\) \{/);
  assert.match(src, /action:\s*'MANUAL_CLOSED'/);
  assert.match(src, /Position not found on-chain — assumed manually withdrawn/);
});

test('evilPanda removeLiquidity uses Meteora SDK parameter names', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /fromBinId:\s*lowerBinId/);
  assert.match(src, /toBinId:\s*upperBinId/);
  assert.match(src, /bps:\s*new BN\(10000\)/);
  assert.doesNotMatch(src, /minBinId:\s*activePos\.positionData\.lowerBinId/);
  assert.doesNotMatch(src, /maxBinId:\s*activePos\.positionData\.upperBinId/);
  assert.doesNotMatch(src, /liquidityBpsToRemove:/);
});

test('evilPanda exit path uses close-once flow and avoids cleanup retry loop', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /async function buildZapOutCloseTxs/);
  assert.match(src, /shouldClaimAndClose:\s*true/);
  assert.match(src, /async function executeExitCloseWithZapPreferred/);
  assert.match(src, /ZAP_OUT_FAIL/);
  assert.match(src, /fallbackMode:\s*'none'/);
  assert.match(src, /withExitAccountingLock\(\(\) => withPermanentAwareBackoff/);
  assert.match(src, /buildPermanentExitError\(/);
  assert.doesNotMatch(src, /EMPTY CLOSE TX confirmed/);
  assert.doesNotMatch(src, /EXIT_FALLBACK_USED/);
  assert.doesNotMatch(src, /async function buildCloseEmptyPositionTxs/);
  assert.doesNotMatch(src, /async function buildClosePositionTxs/);
  assert.doesNotMatch(src, /FALLBACK_LEGACY/);
  assert.doesNotMatch(src, /fallbackMode:\s*'legacy'/);
  assert.doesNotMatch(src, /shouldClaimAndClose:\s*false/);
  assert.doesNotMatch(src, /claimSwapFee/);
  assert.doesNotMatch(src, /closePositionIfEmpty/);
  assert.doesNotMatch(src, /QUOTE_ONLY_EMPTY_POSITION_CLEANUP_TX/);
  assert.doesNotMatch(src, /maxCleanupAttempts/);
  assert.doesNotMatch(src, /cleanupAttempt = 1; cleanupAttempt <=/);
});

test('evilPanda exit path stays one-shot without CU retry fallback', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /EXIT_COMPUTE_UNITS:\s*1_200_000/);
  assert.match(src, /injectPriorityFee\(tx,\s*\{\s*units:\s*EP_CONFIG\.EXIT_COMPUTE_UNITS/);
  const sendExitTxBlockStart = src.indexOf('async function sendExitTx');
  const sendExitTxBlockEnd = src.indexOf('async function getFreshActivePosition', sendExitTxBlockStart);
  const sendExitTxBlock = src.slice(sendExitTxBlockStart, sendExitTxBlockEnd);
  assert.doesNotMatch(sendExitTxBlock, /isComputeUnitExhausted/);
  assert.doesNotMatch(sendExitTxBlock, /Exit TX kehabisan compute unit/);
  assert.doesNotMatch(sendExitTxBlock, /exit send retry failed/);
  assert.doesNotMatch(sendExitTxBlock, /maxRetries:\s*3.*maxRetries:\s*3/s);
});

test('evilPanda treats trailing-profit exits as non-emergency fee path', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const normalizedExitReason = normalizeExitReason\(reason\)/);
  assert.match(src, /normalizedExitReason === 'STOP_LOSS'/);
  assert.match(src, /normalizedExitReason === 'OUT_OF_RANGE'/);
  assert.doesNotMatch(src, /STOP_LOSS\|SCENARIO_C\|SUPPORT\|TRAILING\|BEARISH\|PANIC\|OUT_OF_RANGE/);
});

test('monitor exit policy keeps trailing primary and adds bearish defensive TA fallback for agent-managed positions', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');

  assert.match(evilPandaSrc, /function getConfiguredMaxHoldHours/);
  assert.match(evilPandaSrc, /function getConfiguredTrailingStopPct/);
  assert.match(evilPandaSrc, /function getConfiguredTrailingTriggerPct/);
  assert.match(evilPandaSrc, /function getConfiguredTrailingDropPct/);
  assert.match(evilPandaSrc, /function evaluateAgentDefensiveTaExit/);
  assert.match(evilPandaSrc, /Defensive TA inactive: Supertrend=/);
  assert.match(evilPandaSrc, /Bearish ST \+ RSI\(2\)=/);
  assert.match(evilPandaSrc, /Bearish ST active but TA confirmation not met/);
  assert.match(evilPandaSrc, /action:\s*'MAX_HOLD'/);
  assert.match(evilPandaSrc, /TP \(PRIMARY_TRAILING_STOP\)/);
  assert.match(evilPandaSrc, /const trailingStopPct = getConfiguredTrailingStopPct\(\)/);
  assert.match(evilPandaSrc, /if \(trailingStopPct > 0 && pnlPct >= trailingStopPct\)/);
  assert.match(evilPandaSrc, /Primary TP target hit/);
  assert.match(evilPandaSrc, /TP \(FALLBACK_TRAILING\)/);
  assert.match(evilPandaSrc, /const trailingEligible = trailingTriggerPct > 0 && pnlPct >= trailingTriggerPct/);
  assert.match(evilPandaSrc, /trailingDrawdownPct >= trailingDropPct/);
  assert.match(evilPandaSrc, /const agentDefensiveSignal = await fetchExitSignal\(reg\.tokenXMint\)/);
  assert.match(evilPandaSrc, /const agentDefensiveDecision = evaluateAgentDefensiveTaExit\(agentDefensiveSignal, \{ ageMs \}\)/);
  assert.match(evilPandaSrc, /TA_EXIT_AGENT/);
  assert.match(evilPandaSrc, /exitScenario: `DEFENSIVE_\$\{agentDefensiveDecision\.scenario \|\| 'TA'\}`/);
  assert.match(evilPandaSrc, /exitReason: `TAKE_PROFIT_C: \$\{agentDefensiveDecision\.reason\}`/);
  assert.match(evilPandaSrc, /TP hold: primary trailing target, fallback trailing, and defensive TA not triggered/);
  assert.match(evilPandaSrc, /taReason: agentDefensiveDecision\.reason \|\| 'Primary\/fallback trailing profit not triggered'/);
  assert.match(evilPandaSrc, /taSignal: agentDefensiveSignal/);
  assert.doesNotMatch(evilPandaSrc, /const takeProfitMinNetPnlPct = getConfiguredTakeProfitMinNetPnlPct\(\)/);
  assert.doesNotMatch(evilPandaSrc, /pnlPct < takeProfitMinNetPnlPct/);
  assert.match(hunterSrc, /getExitDisplayMeta/);
  assert.match(hunterSrc, /Posisi Di Tutup \(\$\{exitMeta\.title\}\)/);
  assert.match(hunterSrc, /function buildExitTriggerNotification/);
  assert.match(hunterSrc, /reasonLabel = ''/);
  assert.match(hunterSrc, /if \(action === 'MAX_HOLD'\)/);
  assert.match(hunterSrc, /safeExit\(positionPubkey, 'MAX_HOLD_EXIT'\)/);
  assert.doesNotMatch(evilPandaSrc, /Trailing TP/);
});

test('evilPanda exit path applies fee-first auto swap with residual swap behind policy gate', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /getTokenBalanceRaw/);
  assert.match(src, /buildExitSwapPolicy/);
  assert.match(src, /buildTakeProfitExitSwapPolicy/);
  assert.match(src, /async function waitForExitTokenBalanceSettle/);
  assert.match(src, /async function auditExitResidualTokenBalances/);
  assert.match(src, /attemptGatedExitSwapToSol/);
  assert.match(src, /AGENT_EXIT_FEE_SWAP/);
  assert.match(src, /AGENT_EXIT_SWAP_BALANCE_SETTLE/);
  assert.match(src, /const residualMintCandidates = \[reg\.tokenXMint, reg\.tokenYMint\]/);
  assert.match(src, /const shouldSwapResidual = swapPolicy\.swapMode === 'all' \|\| swapPolicy\.allowResidualSwap/);
  assert.match(src, /AGENT_EXIT_SWAP_STAGE_DONE mode=TP_FULL_SWEEP/);
  assert.match(src, /swapCompletionStatus/);
  assert.match(src, /feeSwapStatus/);
  assert.match(src, /residualSwapStatus/);
  assert.match(src, /residualTokenBalances/);
  assert.match(src, /residualSwapOutSol/);
  assert.doesNotMatch(src, /swapToSol\(mint, rawBalance, null, swapOptions\)/);
});

test('take profit exit forces full-swap policy while claimFees stays claim-only', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const meteoraSrc = readFileSync(resolve(process.cwd(), 'src/solana/meteora.js'), 'utf8');
  const exitBlockStart = evilPandaSrc.indexOf('const cfg = getConfig();');
  const exitBlockEnd = evilPandaSrc.indexOf('if (swapPolicy.swapMode !== \'off\') {', exitBlockStart);
  const exitPolicyBlock = evilPandaSrc.slice(exitBlockStart, exitBlockEnd);
  const claimStart = meteoraSrc.indexOf('export async function claimFees');
  const claimEnd = meteoraSrc.indexOf('// ─── Top Pools ───────────────────────────────────────────────────', claimStart);
  const claimBlock = meteoraSrc.slice(claimStart, claimEnd);

  assert.match(evilPandaSrc, /function isTakeProfitExitReason/);
  assert.match(exitPolicyBlock, /isTakeProfitExitReason\(reason, normalizedExitReason\)/);
  assert.match(evilPandaSrc, /return text\.startsWith\('TAKE_PROFIT'\)/);
  assert.match(exitPolicyBlock, /buildTakeProfitExitSwapPolicy/);
  assert.match(evilPandaSrc, /swapMode:\s*'all'/);
  assert.match(evilPandaSrc, /allowResidualSwap:\s*true/);
  assert.match(evilPandaSrc, /NO_FEE_DELTA_AFTER_SETTLE/);
  assert.match(evilPandaSrc, /AGENT_EXIT_FEE_SWAP_SKIP_ERROR/);
  assert.match(evilPandaSrc, /AGENT_EXIT_RESIDUAL_SWAP_SKIP_ERROR/);
  assert.match(evilPandaSrc, /tpFullSweep: isTakeProfitExitReason\(reason, normalizedExitReason\)/);
  assert.match(claimBlock, /export async function claimFees/);
  assert.match(claimBlock, /claimAllRewards\(\{/);
  assert.doesNotMatch(claimBlock, /attemptGatedSwapToSol/);
  assert.doesNotMatch(claimBlock, /RESIDUAL_SWAP_DONE/);
  assert.doesNotMatch(claimBlock, /swapMode:\s*'all'/);
});

test('jupiter swap wrapper returns structured execution errors for caller observability', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/utils/jupiter.js'), 'utf8');
  const swapToSolStart = src.indexOf('export async function swapToSol');
  const swapToSolEnd = src.indexOf('// ── swapAllToSOL', swapToSolStart);
  const swapToSolBlock = src.slice(swapToSolStart, swapToSolEnd);
  assert.match(src, /reason:\s*'SWAP_EXECUTION_ERROR'/);
  assert.match(src, /error:\s*e\.message/);
  assert.doesNotMatch(swapToSolBlock, /return null;/);
});

test('meteora close flow applies fee-first guarded swap and optional residual swap', () => {
  const meteoraPath = resolve(process.cwd(), 'src/solana/meteora.js');
  const src = readFileSync(meteoraPath, 'utf8');
  assert.match(src, /function buildCloseSwapPolicy/);
  assert.match(src, /const shouldSwapFeeOnly = swapPolicy\.swapMode === 'fee_only' \|\| swapPolicy\.swapMode === 'all'/);
  assert.match(src, /const shouldSwapResidual = swapPolicy\.swapMode === 'all' \|\| swapPolicy\.allowResidualSwap/);
  assert.match(src, /attemptGatedSwapToSol/);
  assert.match(src, /FEE_CLAIM_DONE/);
  assert.match(src, /RESIDUAL_SWAP_DONE/);
  assert.match(src, /RESIDUAL_SWAP_SKIP/);
  assert.doesNotMatch(src, /await executeTransactions\(\[removeLiqTx\]/);
});

test('meteora close flow stays one-shot and does not retain fallback close branches', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/solana/meteora.js'), 'utf8');
  assert.match(src, /removeLiquidity\(\{\s*position:\s*positionPubkey,\s*user:\s*wallet\.publicKey,\s*fromBinId,\s*toBinId,\s*bps:\s*new BN\(10000\),\s*shouldClaimAndClose:\s*true/);
  assert.match(src, /closePositionDLMM\] Account masih ada setelah close attempt pertama/);
  assert.match(src, /manual_review/);
  assert.doesNotMatch(src, /shouldClaimAndClose:\s*false/);
  assert.doesNotMatch(src, /cleanup cycle/);
  assert.doesNotMatch(src, /cleanupDone/);
  assert.doesNotMatch(src, /re-run removeLiquidity/);
  assert.doesNotMatch(src, /Last resort: closePosition/);
});

test('deploy path blocks duplicate pool entries before opening a second position', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(evilPandaSrc, /hasTrackedPoolPosition\(poolAddress\)/);
  assert.match(evilPandaSrc, /already has an active or pending position/);
  assert.match(hunterSrc, /hasActivePoolAddress/);
  assert.match(hunterSrc, /!hasActivePoolAddress\(poolAddress\)/);
  assert.match(hunterSrc, /\|\| hasActivePoolAddress\(poolAddress\)/);
});

test('dryRun creates isolated paper positions while real exits remain real', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(evilPandaSrc, /const paperMode = executionMode === 'paper'/);
  assert.match(evilPandaSrc, /if \(paperMode\) \{[\s\S]*paper:\s*true,[\s\S]*executionMode:\s*'paper'/);
  assert.match(evilPandaSrc, /if \(normalizeExecutionMode\(reg\?\.executionMode\) !== 'real'\)/);
  const exitStart = evilPandaSrc.indexOf('export async function exitPosition');
  const exitEnd = evilPandaSrc.indexOf('export async function reconcileStartupPositions', exitStart);
  const exitBlock = evilPandaSrc.slice(exitStart, exitEnd);
  assert.doesNotMatch(exitBlock, /isDryRun\(\)/);
  assert.match(hunterSrc, /openPaperPositionFromDeployPlan/);
  assert.match(hunterSrc, /paperMonitorLoop/);
  assert.match(hunterSrc, /closePaperPosition\(positionId,/);
});

test('hunter sends realtime PnL snapshots to Telegram on configured interval', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /function getRealtimePnlIntervalMs/);
  assert.match(src, /async function notifyRealtimePnl/);
  assert.match(src, /📊 <b>Realtime PnL<\/b>/);
  assert.doesNotMatch(src, /Display: <code>\$/);
  assert.doesNotMatch(src, /PnL USD: <code>/);
  assert.doesNotMatch(src, /SOL\/USD: <code>/);
  assert.match(src, /Interval: <code>\$\{intervalSec\}s<\/code>/);
  assert.match(src, /await notifyRealtimePnl\(\{ positionPubkey, symbol, status \}\)/);
});

test('hunter wires Pool Impact Guard only inside active monitor loop', () => {
  const src = readFileSync(hunterPath, 'utf8');
  const monitorStart = src.indexOf('async function monitorLoop');
  assert.notEqual(monitorStart, -1);
  const monitorEnd = src.indexOf('export function spawnMonitorForRestoredPositions', monitorStart);
  const monitorBlock = src.slice(monitorStart, monitorEnd);

  assert.match(src, /import \{ evaluatePoolImpactGuard \} from '\.\.\/risk\/poolImpactGuard\.js'/);
  assert.match(monitorBlock, /poolImpactGuardEnabled === true/);
  assert.match(monitorBlock, /poolImpactCheckIntervalMs/);
  assert.match(monitorBlock, /lastPoolImpactCheckAt/);
  assert.match(monitorBlock, /canRunPoolImpactGuard/);
  assert.match(monitorBlock, /poolImpactSamples: nextPoolImpactSamples\.slice\(-20\)/);
  assert.match(monitorBlock, /evaluatePoolImpactGuard\(\{/);
  assert.match(monitorBlock, /poolImpactDecision\.action === 'FORCE_EXIT'/);
  assert.match(monitorBlock, /safeExit\(positionPubkey, 'POOL_IMPACT_GUARD'\)/);
});

test('scout agent prompt uses DLMM LP breakout screening fields', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /INITIAL SCREENING FILTER FOR DLMM LIQUIDITY PROVIDER/);
  assert.match(src, /LP STYLE ENTRY/);
  assert.match(src, /Supertrend 15m harus bullish/);
  assert.match(src, /Last closed M15 candle HARUS close di atas garis Supertrend/);
  assert.match(src, /reclaim baru \$\{Number\(entrySignals\.closedM15ReclaimConsecutiveAboveLineCount \|\| 0\)\} candle di atas Supertrend; tunggu minimal 2 candle close/);
  assert.match(src, /M5, volume, dan price-change hanya konteks tambahan, BUKAN hard gate entry/);
  assert.match(src, /PASS jika breakout fresh jelas atau momentum masih hidup saat pullback sehat di atas Supertrend/);
  assert.match(src, /breakout fresh belum terkonfirmasi/);
  assert.match(src, /MOMENTUM_ALIVE/);
  assert.match(src, /TA Supertrend 15m:/);
  assert.match(src, /TA M5 Change:/);
  assert.match(src, /OKX Wash Trading:/);
  assert.match(src, /GMGN Top10:/);
  assert.match(src, /entry_readiness/);
  assert.match(src, /breakout_quality/);
  assert.match(src, /Entry=\$\{entryReadiness\}/);
  assert.match(src, /Breakout=\$\{breakoutQuality\}/);
  assert.match(src, /const CycleReport = \[\]/);
  assert.match(src, /generateFinalCycleReport/);
});

test('general agent final decision prompt requires mature breakout momentum', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /PRINCIPAL DLMM LIQUIDITY PROVIDER \(FINAL DECISION MAKER\)/);
  assert.match(src, /Kamu tidak mengejar entry dekat supertrend/);
  assert.match(src, /Supertrend 15m bullish, closed M15 reclaim sudah valid, snapshot fresh/);
  assert.match(src, /Kalau konfirmasi belum lengkap, jangan deploy/);
  assert.match(src, /Entry = terkonfirmasi, bukan harga yang sudah keburu lari jauh dari snapshot/);
  assert.match(src, /High-level Summary:/);
  assert.match(src, /Meridian Gate:/);
  assert.match(src, /GMGN Total Fees:/);
  assert.match(src, /DEPLOY jika:/);
});

test('/autoscreen uses single final scan report flow', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.js'), 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(src, /sendImmediateTopPoolsReport\(chatId\)/);
  assert.match(src, /async function runSilentScan\(\{ emitFinalReport = false, source = 'startup' \} = \{\}\)/);
  assert.match(src, /setNotifyMuted\(true\)/);
  assert.match(src, /await runImmediateAutoscreenScan\(\{ source: 'manual_command', emitFinalReport: true \}\);/);
  assert.match(src, /setNotifyMuted\(false\)/);
  assert.match(src, /startAutoScreeningRuntime\(chatId, \{ snapshotTopPools: false \}\)/);
  assert.doesNotMatch(src, /startAutoScreeningRuntime\(chatId, \{ snapshotTopPools: true \}\)/);
  assert.doesNotMatch(hunterSrc, /Laporan tetap dikirim/);
  assert.match(src, /stopScreeningLoop\(\);[\s\S]*runScreeningLoop\(\);/);
  assert.match(src, /let\s+_screeningScanInFlight\s*=\s*false;/);
  assert.match(src, /if \(_screeningScanInFlight\) \{\s*console\.log\('\[screening-loop\] ⏭️ Skip tick: scan masih berjalan\.'\);/);
  assert.doesNotMatch(src, /global\.screeningInterval/);
});

test('instant scan report includes freshness labels for auditability', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /Freshness: <code>\$\{escapeHTML\(String\(pool\?._screeningRank\?\.freshnessState \|\| 'UNKNOWN'\)\.toUpperCase\(\)\)\}<\/code>/);
  assert.match(src, /freshnessPriorityDelta/);
  assert.match(src, /activityPercentile/);
});

test('final scan report is suppressed when deploy slots are saturated', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /if \(isDeploySlotSaturated\(getEntrySlotUsage\(\)\)\) \{/);
  assert.match(src, /Final cycle report disenyapkan karena slot penuh/);
});

test('active position analyst prompt holds through healthy bullish momentum', () => {
  const src = readFileSync(analystPath, 'utf8');
  assert.match(src, /ACTIVE POSITION YIELD MANAGER FOR DLMM/);
  assert.match(src, /Jangan close hanya karena profit kecil turun sedikit/);
  assert.match(src, /Selama supertrend 15m masih bullish dan momentum M5 masih sehat/);
  assert.match(src, /momentum_state/);
  assert.match(src, /range_health_status/);
});

test('deploy natural failures are silenced from Telegram notifications', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /function isNaturalDeployError/);
  assert.match(src, /'simulation failed'/);
  assert.match(src, /'slippage'/);
  assert.match(src, /'timeout'/);
  assert.match(src, /'blockhash'/);
  assert.match(src, /deployPosition natural fail silenced/);
});

test('slot-saturated watch promotion stays quiet for new radar candidates', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /function isDeploySlotSaturated\(slotUsage = getEntrySlotUsage\(\)\)/);
  assert.match(src, /SLOT_SATURATED_PROMOTION_PAUSED/);
  assert.match(src, /if \(!isDeploySlotSaturated\(slotUsage\)\) \{/);
  assert.match(src, /await notify\(\s*`👀 <b>WATCH<\/b>/);
  assert.match(src, /if \(slotSaturated\) continue;/);
  assert.match(src, /reportManager\.setSlotSaturatedSummaryOnly\(slotSaturated\)/);
});

test('single-slot deploy mode selects one winner and leaves runners-up on standby', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /const singleSlotMode = maxPositions <= 1;/);
  assert.match(src, /const selectedWinner = singleSlotMode/);
  assert.match(src, /const deployCandidates = singleSlotMode/);
  assert.match(src, /const standbyCandidates = singleSlotMode/);
  assert.match(src, /Mode 1 slot: 1 kandidat terbaik dipilih untuk deploy/);
  assert.match(src, /for \(const winner of deployCandidates\)/);
  assert.match(src, /if \(singleSlotMode\) \{\s*break;\s*\}/);
  assert.doesNotMatch(src, /for \(const winner of eligibleWinners\)/);
});

test('exit telegram messages display Meteora fee-only PnL', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');

  assert.match(evilPandaSrc, /export async function calculateFeeOnlyPnl/);
  assert.match(evilPandaSrc, /feePnlPct = Number\(deploySol\) > 0 \? \(feePnlSol \/ Number\(deploySol\)\) \* 100 : 0/);
  assert.match(evilPandaSrc, /return \{ action: 'STOP_LOSS', currentValueSol, pnlPct, \.\.\.feeOnlyPnl, inRange/);
  assert.match(evilPandaSrc, /currentValueSol, pnlPct, \.\.\.feeOnlyPnl, inRange/);

  assert.match(hunterSrc, /function buildExitTriggerNotification/);
  assert.match(hunterSrc, /Fee PnL: <code>\$\{Number\(feePnlSol\)\.toFixed\(6\)\} SOL \/ \$\{feeSign\}\$\{Number\(feePnlPct\)\.toFixed\(2\)\}%<\/code>/);
  assert.match(hunterSrc, /Fee PnL: <code>unavailable<\/code>/);
  assert.match(hunterSrc, /Position Value: <code>\$\{Number\(currentValueSol\)\.toFixed\(4\)\} SOL<\/code>/);
  assert.match(hunterSrc, /Total Exposure PnL: <code>/);
  assert.match(hunterSrc, /return \{ ok: true, \.\.\.exitResult \}/);
  assert.doesNotMatch(hunterSrc, /`PnL: <code>\+?\$\{pnlPct\.toFixed\(2\)\}%<\/code>\\n`/);
});

test('exit close notifications use unified display metadata for all close families', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const exitReasonsSrc = readFileSync(resolve(process.cwd(), 'src/utils/exitReasons.js'), 'utf8');
  const exitReportSrc = readFileSync(resolve(process.cwd(), 'src/utils/exitReport.js'), 'utf8');

  assert.match(hunterSrc, /getExitDisplayMeta/);
  assert.match(hunterSrc, /function buildExitTriggerNotification/);
  assert.match(hunterSrc, /function buildExitClosedNotification/);
  assert.match(hunterSrc, /buildClosedPositionReport\(\{/);
  assert.match(hunterSrc, /function formatAutoSwapStatusLine/);
  assert.match(hunterSrc, /function formatResidualBalanceLines/);
  assert.match(hunterSrc, /buildExitTriggerNotification\(\{/);
  assert.match(hunterSrc, /buildExitClosedNotification\(\{ positionPubkey, exitMeta, exitResult, balance \}\)/);
  assert.match(hunterSrc, /isUnifiedPerformanceClose/);
  assert.match(evilPandaSrc, /symbol: reg\?\.symbol \|\| reg\?\.patternLearningEntry\?\.symbol \|\| tokenSymbol/);
  assert.match(hunterSrc, /depositSol: exitResult\?\.deploySol/);
  assert.match(hunterSrc, /inRange: exitResult\?\.inRangeAtClose/);
  assert.match(hunterSrc, /lines\.push\(`Reason: <code>\$\{escapeHTML\(reasonLabel\)\}<\/code>`\)/);
  assert.match(hunterSrc, /Reason: <code>\$\{escapeHTML\(exitMeta\.reasonLabel\)\}<\/code>/);
  assert.match(hunterSrc, /Auto Swap: <code>\$\{completionLabel\}<\/code> \| Fee: <code>\$\{feeLabel\}<\/code> \| Residual: <code>\$\{residualLabel\}<\/code>/);
  assert.match(hunterSrc, /Residual Token: <code>/);
  assert.match(exitReportSrc, /🟢/);
  assert.match(exitReportSrc, /🔴/);
  assert.match(exitReportSrc, /⚪/);
  assert.match(exitReportSrc, /Take Home Pay/);
  assert.match(exitReportSrc, /Range at Close/);
  assert.match(exitReasonsSrc, /export function getExitDisplayMeta/);
  assert.match(exitReasonsSrc, /Trailing Profit Trigger/);
  assert.match(exitReasonsSrc, /Defensive Exit Trigger/);
  assert.match(exitReasonsSrc, /Stop Loss Trigger/);
  assert.match(exitReasonsSrc, /Safe Exit Trigger/);
  assert.match(exitReasonsSrc, /Manual Close Trigger/);
  assert.match(exitReasonsSrc, /Pool Impact Trigger/);
});

test('out-of-range close notifications use the compact minimal layout', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const branchStart = hunterSrc.indexOf("if (normalizedExitTitle === 'OUT OF RANGE')");
  const branchEnd = hunterSrc.indexOf('const lines = [', branchStart + 1);
  const branchSrc = branchStart >= 0 && branchEnd > branchStart
    ? hunterSrc.slice(branchStart, branchEnd + 500)
    : hunterSrc;

  assert.match(branchSrc, /normalizedExitTitle === 'OUT OF RANGE'/);
  assert.match(branchSrc, /✅ <b>Posisi Di Tutup \(OUT OF RANGE\)<\/b>/);
  assert.match(branchSrc, /Token: <b>\$\{tokenLabel\}<\/b>/);
  assert.match(branchSrc, /Reason: <code>\$\{escapeHTML\(exitMeta\.reasonLabel \|\| 'Out of Range Trigger'\)\}<\/code>/);
  assert.match(branchSrc, /Balance: <code>\$\{balanceNum\} SOL<\/code>/);
  assert.doesNotMatch(branchSrc, /Position: <code>/);
  assert.doesNotMatch(branchSrc, /Fee PnL:/);
  assert.doesNotMatch(branchSrc, /Position Value:/);
  assert.doesNotMatch(branchSrc, /Total Exposure PnL:/);
  assert.doesNotMatch(branchSrc, /Wallet Net Delta:/);
  assert.doesNotMatch(branchSrc, /Rent Refund/);
});
