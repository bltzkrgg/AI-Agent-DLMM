import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

test('evilPanda uses monolith positions with one Meteora account for the full range', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const posKp = Keypair\.generate\(\)/);
  assert.match(src, /let rangeMax = activeBin\.binId - offsetMinBins/);
  assert.match(src, /if \(\(rangeMax - rangeMin\) > 68\) \{ rangeMin = rangeMax - 68; \}/);
  assert.doesNotMatch(src, /rangeMax = activeBin\.binId - offsetMinBins - 1/);
  assert.doesNotMatch(src, /rangeMax - rangeMin > 1000/);
  assert.match(src, /initializePositionAndAddLiquidityByStrategy/);
  assert.match(src, /sendTransaction\(tx, \[wallet, posKp\]/);
  assert.match(src, /const activePos = userPositions\.find\(p => p\.publicKey\.toString\(\) === positionPubkey\)/);
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

test('evilPanda retries close cleanup before reporting manual exit failure', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /async function buildClosePositionTxs/);
  assert.match(src, /shouldClaimAndClose:\s*false/);
  assert.match(src, /claimSwapFee/);
  assert.match(src, /closePositionIfEmpty/);
  assert.match(src, /closePosition/);
  assert.match(src, /cleanupAttempt = 1; cleanupAttempt <= 3/);
  assert.match(src, /getFreshActivePosition/);
  assert.match(src, /accountInfo === null/);
});

test('evilPanda exit path uses high compute budget with CU retry', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /EXIT_COMPUTE_UNITS:\s*1_200_000/);
  assert.match(src, /EXIT_MAX_COMPUTE_UNITS:\s*1_400_000/);
  assert.match(src, /injectPriorityFee\(tx,\s*\{\s*units:\s*EP_CONFIG\.EXIT_COMPUTE_UNITS/);
  assert.match(src, /isComputeUnitExhausted/);
  assert.match(src, /Exit TX kehabisan compute unit/);
});

test('evilPanda exit path swaps residual non-SOL tokens using raw balances', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /getTokenBalanceRaw/);
  assert.match(src, /residualMints = \[\.\.\.new Set\(\[reg\.tokenXMint, reg\.tokenYMint\]\.filter\(/);
  assert.match(src, /Swap residual token → SOL/);
  assert.match(src, /swapToSol\(mint, rawBalance, null, \{ isUrgent: true \}\)/);
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

test('scout agent prompt uses DLMM LP breakout screening fields', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /INITIAL SCREENING FILTER FOR DLMM LIQUIDITY PROVIDER/);
  assert.match(src, /breakout yang matang/);
  assert.match(src, /Supertrend 15m harus bullish/);
  assert.match(src, /Candle M5 harus hijau/);
  assert.match(src, /entry_readiness/);
  assert.match(src, /breakout_quality/);
  assert.match(src, /Entry=\$\{entryReadiness\}/);
  assert.match(src, /Breakout=\$\{breakoutQuality\}/);
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
