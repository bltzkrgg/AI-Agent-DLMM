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
  assert.doesNotMatch(hunterSrc, /Manual close terdeteksi/);
  assert.match(hunterSrc, /MANUAL_CLOSE_TELEGRAM_SENT/);
  assert.match(hunterSrc, /shouldAlertManualClose/);
  assert.match(hunterSrc, /closeFailureMeta/);
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
  assert.match(indexSrc, /Manual Close Watcher/);
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
  assert.match(indexSrc, /if \(isDiscoveryPaused\(\)\) \{\s*await bot\.sendMessage\(chatId, `⏸️ \$\{getPausedMessage\(\)\}`/);
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

test('evilPanda uses monolith positions with one Meteora account for the full range', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /(?:const|let) posKp = Keypair\.generate\(\)/);
  assert.match(src, /let rangeMax = activeBin\.binId - offsetMinBins/);
  assert.match(src, /const rangeMaxBins = getConfiguredDeployRangeMaxBins\(\)/);
  assert.match(src, /if \(\(rangeMax - rangeMin \+ 1\) > rangeMaxBins\)/);
  assert.match(src, /selectRentFreeRange/);
  assert.match(src, /assertRangeDoesNotRequireBinArrayInit/);
  assert.match(src, /VETO_NON_REFUNDABLE_RENT/);
  assert.match(src, /RANGE_ADJUSTED_FOR_RENT/);
  assert.match(src, /RENT_FREE_SEARCH_SLACK_ARRAYS/);
  assert.match(src, /findAdaptiveRentFreeRange/);
  assert.match(src, /searchSlackArrays/);
  assert.match(src, /RANGE_ADJUSTED_FOR_RENT/);
  assert.doesNotMatch(src, /rangeMax = activeBin\.binId - offsetMinBins - 1/);
  assert.doesNotMatch(src, /rangeMax - rangeMin > 1000/);
  assert.match(src, /initializePositionAndAddLiquidityByStrategy/);
  assert.match(src, /sendTransaction\(tx, \[wallet, posKp\]/);
  assert.match(src, /const activePos = userPositions\.find\(p => p\.publicKey\.toString\(\) === positionPubkey\)/);
});

test('blocked deploy results are handled by hunter and queue callers', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const queueSrc = readFileSync(resolve(process.cwd(), 'src/utils/pendingDeployQueue.js'), 'utf8');
  assert.match(hunterSrc, /deployResult && typeof deployResult === 'object' && deployResult\.blocked/);
  assert.match(hunterSrc, /Deploy Ditolak/);
  assert.match(hunterSrc, /recordGate\(winner\._record, 'SCOUT_AGENT', 'DEFER'/);
  assert.match(queueSrc, /result && typeof result === 'object' && result\.blocked/);
  assert.match(queueSrc, /Deploy Ditolak \(Queue\)/);
  assert.match(queueSrc, /Adjust range gagal untuk pool\/range ini\. Pool lain tetap normal\./);
  assert.doesNotMatch(queueSrc, /Queue menghormati veto non-refundable rent/);
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
  assert.match(src, /async function buildCloseEmptyPositionTxs/);
  assert.match(src, /async function executeExitCloseWithZapPreferred/);
  assert.match(src, /ZAP_OUT_FAIL/);
  assert.match(src, /EMPTY CLOSE TX confirmed/);
  assert.match(src, /fallbackMode = 'legacy'/);
  assert.match(src, /fallbackMode:\s*'legacy'/);
  assert.doesNotMatch(src, /fallbackMode:\s*'empty_only'/);
  assert.match(src, /withExitAccountingLock\(\(\) => withPermanentAwareBackoff/);
  assert.match(src, /buildPermanentExitError\(/);
  assert.match(src, /EXIT_FALLBACK_USED/);
  assert.match(src, /async function buildClosePositionTxs/);
  assert.match(src, /shouldClaimAndClose:\s*false/);
  assert.match(src, /claimSwapFee/);
  assert.match(src, /closePositionIfEmpty/);
  assert.match(src, /closePosition/);
  assert.doesNotMatch(src, /maxCleanupAttempts/);
  assert.doesNotMatch(src, /cleanupAttempt = 1; cleanupAttempt <=/);
  assert.doesNotMatch(src, /getFreshActivePosition/);
});

test('evilPanda exit path uses high compute budget with CU retry', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /EXIT_COMPUTE_UNITS:\s*1_200_000/);
  assert.match(src, /EXIT_MAX_COMPUTE_UNITS:\s*1_400_000/);
  assert.match(src, /injectPriorityFee\(tx,\s*\{\s*units:\s*EP_CONFIG\.EXIT_COMPUTE_UNITS/);
  assert.match(src, /isComputeUnitExhausted/);
  assert.match(src, /Exit TX kehabisan compute unit/);
});

test('evilPanda treats trailing-profit exits as non-emergency fee path', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const normalizedExitReason = normalizeExitReason\(reason\)/);
  assert.match(src, /normalizedExitReason === 'STOP_LOSS'/);
  assert.match(src, /normalizedExitReason === 'OUT_OF_RANGE'/);
  assert.doesNotMatch(src, /STOP_LOSS\|SCENARIO_C\|SUPPORT\|TRAILING\|BEARISH\|PANIC\|OUT_OF_RANGE/);
});

test('evilPanda exit path applies fee-first auto swap with residual swap behind policy gate', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /getTokenBalanceRaw/);
  assert.match(src, /buildExitSwapPolicy/);
  assert.match(src, /attemptGatedExitSwapToSol/);
  assert.match(src, /AGENT_EXIT_FEE_SWAP/);
  assert.match(src, /const shouldSwapResidual = swapPolicy\.swapMode === 'all' \|\| swapPolicy\.allowResidualSwap/);
  assert.doesNotMatch(src, /swapToSol\(mint, rawBalance, null, swapOptions\)/);
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

test('deploy path blocks duplicate pool entries before opening a second position', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(evilPandaSrc, /hasTrackedPoolPosition\(poolAddress\)/);
  assert.match(evilPandaSrc, /already has an active or pending position/);
  assert.match(hunterSrc, /hasActivePoolAddress/);
  assert.match(hunterSrc, /!hasActivePoolAddress\(poolAddress\)/);
  assert.match(hunterSrc, /\|\| hasActivePoolAddress\(poolAddress\)/);
});

test('dryRun mode only simulates tx in evilPanda and hunter', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(evilPandaSrc, /if \(isDryRun\(\)\) \{/);
  assert.match(evilPandaSrc, /simulateTransaction\(tx, \{ commitment: 'processed' \}\)/);
  assert.match(evilPandaSrc, /DRY_RUN_SIMULATION_FAILED/);
  assert.match(hunterSrc, /Dry-run deploy disimulasikan/);
  assert.match(hunterSrc, /Dry-run exit disimulasikan/);
  assert.match(hunterSrc, /Tidak ada transaksi real yang dikirim karena mode dryRun aktif/);
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
  assert.match(src, /price reclaim\/bounce sehat/);
  assert.match(src, /Supertrend 15m harus bullish/);
  assert.match(src, /Candle M5 harus hijau/);
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
  assert.match(src, /harga break jauh di atas supertrend 15m bullish/);
  assert.match(src, /Kalau bullish momentum belum terbentuk, jangan deploy/);
  assert.match(src, /Entry = breakout matang, bukan harga yang baru menyentuh garis/);
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

test('exit telegram messages display Meteora fee-only PnL', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');

  assert.match(evilPandaSrc, /export async function calculateFeeOnlyPnl/);
  assert.match(evilPandaSrc, /feePnlPct = Number\(deploySol\) > 0 \? \(feePnlSol \/ Number\(deploySol\)\) \* 100 : 0/);
  assert.match(evilPandaSrc, /return \{ action: 'STOP_LOSS', currentValueSol, pnlPct, \.\.\.feeOnlyPnl, inRange/);
  assert.match(evilPandaSrc, /currentValueSol, pnlPct, \.\.\.feeOnlyPnl, inRange/);

  assert.match(hunterSrc, /Fee PnL: <code>\$\{feePnlSol\.toFixed\(6\)\} SOL \/ \$\{feeSign\}\$\{feePnlPct\.toFixed\(2\)\}%<\/code>/);
  assert.match(hunterSrc, /Fee PnL: <code>unavailable<\/code>/);
  assert.match(hunterSrc, /Position Value: <code>\$\{currentValueSol\.toFixed\(4\)\} SOL<\/code>/);
  assert.match(hunterSrc, /Total Exposure PnL: <code>/);
  assert.match(hunterSrc, /return \{ ok: true, \.\.\.exitResult \}/);
  assert.doesNotMatch(hunterSrc, /`PnL: <code>\+?\$\{pnlPct\.toFixed\(2\)\}%<\/code>\\n`/);
});
