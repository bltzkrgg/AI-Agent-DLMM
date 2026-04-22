import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { PublicKey } from '@solana/web3.js';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSolana, getConnection, getWallet, getWalletBalance, runMidnightSweeper, checkGasReserve } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates, getLastRadarSnapshot } from './agents/hunterAlpha.js';
import { runHealerAlpha, runPanicWatchdog, executeTool, runSelfHealingSync } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons, pinLesson, unpinLesson, deleteLesson, clearAllLessons, formatLessonsList, getBrainSummary } from './learn/lessons.js';
import { getConfig, getThresholds, updateConfig, isConfigKeySupported } from './config.js';
import { handleConfirmationReply, getSafetyStatus, setStartingBalanceUsd } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats, loadLibrary } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/coinfilter.js';
import { safeNum, escapeHTML } from './utils/safeJson.js';
import { getOpenPositions, getPositionStats, listPendingReconcileIssues, listRecentFailedOperations } from './db/database.js';
import { getPositionInfo, getPositionInfoLight, getSolPriceUsd, claimFees } from './solana/meteora.js';
import { padR, hr, kv, codeBlock, formatPnl, shortAddr, shortStrat } from './utils/table.js';
import { initMonitor } from './monitor/positionMonitor.js';
import { autoEvolveIfReady, runEvolutionCycle } from './learn/evolve.js';
import { getTodayResults, formatDailyReport, savePerformanceSnapshot, backupAllData } from './market/strategyPerformance.js';
import { recordExitEvent, getExitsByTrigger, getExitsByZone, getPatientExitAnalysis, getTAESummary, getTriggerComparison, getExitEventCount } from './db/exitTracking.js';
import { runStartupModelCheck, formatModelStatus, testModel, testCurrentModel, fetchFreeModels } from './agent/modelCheck.js';
import { discoverAllModels, formatModelList, listAvailableModels, getModelInfo, initializeModelDiscovery } from './agent/modelDiscovery.js';
import { runOpportunityScanner } from './market/opportunityScanner.js';
import { addSmartWallet, removeSmartWallet, formatWalletList } from './market/smartWallets.js';
import { formatPoolMemoryReport } from './market/poolMemory.js';
import { recalibrateWeights, formatWeightsReport } from './market/signalWeights.js';
import { getWalletPositions, isLPAgentEnabled } from './market/lpAgent.js';
import { validateRuntimeEnv } from './runtime/env.js';
import { resolvePositionSnapshot } from './app/positionSnapshot.js';
import { evaluateDeployReadiness } from './app/deployReadiness.js';
import { getWorktreeHealth } from './app/worktreeHealth.js';
import { getSignalReportHealth } from './app/signalReportHealth.js';
import { DbBackup } from './db/backup.js';
import { initializeRpcManager, getRpcMetrics } from './utils/helius.js';
import { CircuitBreaker } from './safety/circuitBreaker.js';
import { createMessageTransport } from './telegram/messageTransport.js';
import { performGitPull, performNpmInstall, performPostUpdateChecks } from './utils/shell.js';

// ─── PID lock — cegah multiple instance ─────────────────────────
const PID_FILE = new URL('../../bot.pid', import.meta.url).pathname;
if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(oldPid, 0); // cek apakah proses masih jalan
    console.error(`❌ Bot sudah jalan (PID ${oldPid}). Hentikan dulu dengan: kill ${oldPid}`);
    process.exit(1);
  } catch {
    // proses lama sudah mati, hapus PID file lama
    unlinkSync(PID_FILE);
  }
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch { } });

const bootCfg = getConfig();

// ─── Validate env ────────────────────────────────────────────────
const { missing } = validateRuntimeEnv({
  requireTrading: true,
  requireGmgn: true,
});
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  console.error('Copy env.example to .env and fill in all values.');
  process.exit(1);
}

const ALLOWED_ID = parseInt(process.env.ALLOWED_TELEGRAM_ID);
if (isNaN(ALLOWED_ID)) {
  console.error('❌ ALLOWED_TELEGRAM_ID must be a numeric Telegram user ID');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  filepath: false, // Sultan Final Sync: Silence deprecation warnings for cleaner terminal output
  polling: {
    interval: 2000,
    autoStart: true,
    params: {
      timeout: 60
    }
  }
});
const cfg = bootCfg;
initMonitor(bot, ALLOWED_ID);

// ─── Shared Utilities ───────────────────────────────────────────
const transport = createMessageTransport(bot, ALLOWED_ID);
const sendLong = transport.sendLong;

async function notify(text) {
  return transport.notify(text).catch(e => {
    console.error('Notify error:', e.message);
    return null;
  });
}

async function urgentNotify(text) {
  const urgentText = `🚨 <b>URGENT INTERVENTION REQUIRED</b>\n\n${text}\n\n⚠️ <i>Sistem menghentikan sementara operasional untuk posisi ini. Silakan cek manual.</i>`;
  return transport.notify(urgentText).catch(e => console.error('Urgent notify error:', e.message));
}

// Initialize DB backup system
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BOT_DB_PATH || join(__dirname, '../data.db');
const dbBackup = new DbBackup(dbPath);

// Initialize Circuit Breaker untuk system safety
const circuitBreaker = new CircuitBreaker({
  errorThreshold: 3,
  errorWindow: 5 * 60 * 1000,
  latencyThreshold: 5000,
  latencyWindow: 5 * 60 * 1000,
  healthCheckInterval: 30000,
  recoverySuccessThreshold: 3,
  autoStart: true,
  onTrip: async (info) => {
    const msg = `🚨 <b>CIRCUIT BREAKER TRIPPED</b>\n\nReason: ${info.reason}\nTime: ${new Date(info.tripTime).toISOString()}\n\n⛔ Trading paused (Hunter/Healer offline)`;
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'HTML' }).catch(() => { });
  },
  onRecover: async (info) => {
    const timeOpen = (info.timeOpenMs / 1000 / 60).toFixed(2);
    const msg = `✅ <b>CIRCUIT BREAKER RECOVERED</b>\n\nRecovery time: ${new Date(info.recoveryTime).toISOString()}\nDowntime: ${timeOpen} minutes\n\n🚀 Trading resumed (Hunter/Healer online)`;
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'HTML' }).catch(() => { });
  },
  onHealthCheck: async (info) => {
    if (info.state !== 'CLOSED') {
      console.log(`CB health check (${info.state}):`, info.metrics);
    }
  },
});

// Initialize API fallback providers (dengan circuit breaker)
const rpcManager = initializeRpcManager(circuitBreaker);

let solanaReady = false;
try {
  initSolana();
  solanaReady = true;
} catch (e) {
  console.warn(`⚠️ Solana wallet init failed: ${e.message}`);
  console.warn('Bot will start but trading features will be disabled until wallet is fixed.');
}

const _dryRun = cfg.dryRun;
console.log(`🦞 Meteora DLMM Bot started! Mode: ${_dryRun ? 'DRY RUN' : 'LIVE'}`);

// Kirim sinyal standby pas bot nyala
const bootStatus = solanaReady ? '🚀 <b>Bot Started!</b>' : '⚠️ <b>Bot Started (DEGRADED)</b>';
const walletNote = solanaReady ? '' : '\n<i>Wallet/RPC gagal inisialisasi. Fitur trading dipause.</i>';

const bootMsg = `${bootStatus} (Mode: Survivalist)\n\n` +
  `🛡️ Hunter: <b>${solanaReady ? 'ON' : 'OFF'}</b> (Standby ⏳)\n` +
  `🩺 Healer: <b>${solanaReady ? 'ON' : 'OFF'}</b> (Standby ⏳)\n${walletNote}\n\n` +
  `<i>Sesuai jadwal, bot akan mulai bekerja dalam ${cfg.managementIntervalMin} - ${cfg.screeningIntervalMin} menit.</i>`;
bot.sendMessage(ALLOWED_ID, bootMsg, { parse_mode: 'HTML' }).catch(() => { });

async function syncStartingBalanceBaseline() {
  if (!solanaReady) return;
  try {
    const [balance, solPriceUsd] = await Promise.all([
      getWalletBalance(),
      getSolPriceUsd().catch(() => 150),
    ]);
    const balanceUsd = safeNum(balance) * solPriceUsd;
    setStartingBalanceUsd(safeNum(balanceUsd.toFixed(2)));
  } catch (e) {
    console.warn(`⚠️ Failed to sync starting balance baseline: ${e.message}`);
  }
}

await syncStartingBalanceBaseline();

// ─── Health check: Detect manually-closed positions ────────────────
async function syncPositionStates() {
  if (!solanaReady) return;
  try {
    const connection = getConnection();
    const openPositions = getOpenPositions();

    if (!openPositions || openPositions.length === 0) {
      console.log('✅ No open positions to sync');
      return;
    }

    console.log(`🔍 Syncing on-chain state for ${openPositions.length} open positions...`);
    const { closePositionWithPnl } = await import('./db/database.js');

    let closedCount = 0;
    for (const pos of openPositions) {
      try {
        const positionPubKey = new PublicKey(pos.position_address);
        const accountInfo = await connection.getAccountInfo(positionPubKey);

        if (accountInfo === null) {
          // Position account tidak ada on-chain tapi masih di DB → closed manual
          console.log(`⚠️ Position ${pos.position_address} closed manually (account not found on-chain)`);
          await closePositionWithPnl(pos.position_address, {
            pnlUsd: 0,
            pnlPct: 0,
            feesUsd: 0,
            closeReason: 'manually_closed',
            lifecycleState: 'closed_manual',
          });
          closedCount++;
        }
      } catch (e) {
        console.warn(`⚠️ Could not check position ${pos.position_address}: ${e.message}`);
      }
    }

    if (closedCount > 0) {
      console.log(`✅ Synced: ${closedCount} manually-closed positions detected and updated`);
    }
  } catch (e) {
    console.warn(`⚠️ Position sync failed: ${e.message}`);
  }
}

await syncPositionStates();
await runSelfHealingSync(notify);

async function getLpPnlMap() {
  const pnlMap = new Map();
  if (!isLPAgentEnabled() || !solanaReady) return pnlMap;

  try {
    const owner = getWallet()?.publicKey?.toString?.();
    const positions = await getWalletPositions(owner);
    if (!Array.isArray(positions)) return pnlMap;
    for (const position of positions) {
      if (position?.address && Number.isFinite(position.pnlPct)) {
        pnlMap.set(position.address, position.pnlPct);
      }
    }
  } catch { /* best-effort */ }

  return pnlMap;
}


// ─── Busy flags — cegah 2 cycle jalan bersamaan ──────────────────
// Menggunakan timestamp (Date.now()) untuk mendukung lock expiration
let _hunterBusy = 0;
let _healerBusy = 0;
let _screeningBusy = 0;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 menit
let _lastEntryGuardAlertAt = 0;
let _lastEntryGuardAlertMsg = '';
let _signalRefreshBusy = false;
let _lastSignalRefreshAt = 0;
let _signalRefreshFailCount = 0;
let _lastSignalRefreshError = '';
let _lastSignalConservativeAlertAt = 0;
let _lastSignalBlockedAlertAt = 0;

function isAutonomyPaused(cfg = getConfig()) {
  return String(cfg?.autonomyMode || 'active').toLowerCase() === 'paused';
}

function summarizeEntryGuard() {
  const liveCfg = getConfig();
  const stage = String(liveCfg.deploymentStage || 'full').toLowerCase();
  const openPos = getOpenPositions();
  const pendingReconcile = listPendingReconcileIssues(200);
  const manualReviewOpen = openPos.filter(p => p.lifecycle_state === 'manual_review').length;

  const stageMaxPositions = stage === 'canary'
    ? Math.min(liveCfg.maxPositions, Math.max(1, Number(liveCfg.canaryMaxPositions || 1)))
    : liveCfg.maxPositions;

  const reasons = [];
  if (stage === 'shadow') {
    reasons.push('Stage SHADOW aktif (entry live diblokir).');
  }
  if (isAutonomyPaused(liveCfg)) {
    reasons.push('Autonomy mode PAUSED.');
  }
  if (liveCfg.autoPauseOnManualReview !== false && manualReviewOpen >= (liveCfg.manualReviewPauseThreshold || 1)) {
    reasons.push(`manual_review terbuka: ${manualReviewOpen} posisi.`);
  }
  if (pendingReconcile.length > 0) {
    reasons.push(`pending reconcile: ${pendingReconcile.length} item.`);
  }

  return {
    stage,
    stageMaxPositions,
    openPositions: openPos.length,
    manualReviewOpen,
    pendingReconcile: pendingReconcile.length,
    reasons,
    entryAllowed: reasons.length === 0,
  };
}

async function maybeNotifyEntryGuard(reasons, { force = false } = {}) {
  if (!Array.isArray(reasons) || reasons.length === 0) return;
  const msg = reasons.join(' | ');
  const now = Date.now();
  const cooldownMs = 15 * 60 * 1000;
  const shouldSend = force || msg !== _lastEntryGuardAlertMsg || (now - _lastEntryGuardAlertAt) > cooldownMs;
  if (!shouldSend) return;
  _lastEntryGuardAlertMsg = msg;
  _lastEntryGuardAlertAt = now;
  await notify(`⏸️ Entry Guard aktif: ${escapeHTML(msg)}`).catch(() => { });
}

async function refreshSignalReportInternal({ force = false } = {}) {
  const cfgNow = getConfig();
  if (cfgNow.signalAutoRefreshEnabled === false) return { skipped: true, reason: 'disabled' };
  if (_signalRefreshBusy) return { skipped: true, reason: 'busy' };

  const intervalMs = Math.max(5, Number(cfgNow.signalAutoRefreshIntervalMin || 180)) * 60 * 1000;
  if (!force && _lastSignalRefreshAt > 0 && (Date.now() - _lastSignalRefreshAt) < intervalMs) {
    return { skipped: true, reason: 'cooldown' };
  }

  const inputsRaw = String(cfgNow.signalAutoRefreshInputs || '').trim();
  if (!inputsRaw) return { skipped: true, reason: 'no_inputs' };

  _signalRefreshBusy = true;
  _lastSignalRefreshAt = Date.now();

  const scriptPath = join(__dirname, '../scripts/buildSignalAccuracyReport.js');
  const args = [scriptPath, '--inputs', inputsRaw, '--strict', 'false'];

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: join(__dirname, '..') });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', (err) => resolve({ ok: false, error: err?.message || 'spawn_failed' }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `signal_report_exit_${code}` });
    });
  });

  _signalRefreshBusy = false;
  if (result.ok) {
    _signalRefreshFailCount = 0;
    _lastSignalRefreshError = '';
  } else {
    _signalRefreshFailCount += 1;
    _lastSignalRefreshError = result.error || 'signal refresh failed';
  }
  return result;
}

async function ensureSignalReportFresh() {
  const cfgNow = getConfig();
  if (cfgNow.signalAutoRefreshEnabled === false) {
    return { mode: 'normal', report: getSignalReportHealth({ reportPath: cfgNow.signalReportPath, maxAgeHours: cfgNow.signalReportMaxAgeHours }) };
  }

  let report = getSignalReportHealth({
    reportPath: cfgNow.signalReportPath,
    maxAgeHours: cfgNow.signalReportMaxAgeHours,
  });

  const staleOrInvalid = (!report.available || !report.passed || report.stale);
  if (staleOrInvalid) {
    await refreshSignalReportInternal({ force: true });
    report = getSignalReportHealth({
      reportPath: cfgNow.signalReportPath,
      maxAgeHours: cfgNow.signalReportMaxAgeHours,
    });
  }

  const hardFailLimit = Math.max(1, Number(cfgNow.signalAutoRefreshFailureLimit || 3));
  const stillBad = (!report.available || !report.passed || report.stale);
  const blocked = stillBad && _signalRefreshFailCount >= hardFailLimit;

  if (blocked) {
    return {
      mode: 'blocked',
      reason: `Signal auto-refresh gagal ${_signalRefreshFailCount}x (limit ${hardFailLimit})`,
      report,
    };
  }

  if (stillBad) {
    return {
      mode: 'conservative',
      reason: `Signal report belum fresh/lolos, mode konservatif aktif (${_signalRefreshFailCount}/${hardFailLimit} fail)`,
      report,
    };
  }

  return { mode: 'normal', report };
}

function getDeployReadinessSnapshot() {
  const cfgNow = getConfig();
  const cbState = circuitBreaker.getState();
  const guard = summarizeEntryGuard();
  const failedOps = listRecentFailedOperations(6, 50);
  const worktree = getWorktreeHealth();
  const signalReport = getSignalReportHealth({
    reportPath: cfgNow.signalReportPath,
    maxAgeHours: cfgNow.signalReportMaxAgeHours,
  });
  const taeSummary = getTAESummary() || {};
  const taeExitCount = getExitEventCount();
  const taeWinRatePct = Number(taeSummary.overall_win_rate);
  const readiness = evaluateDeployReadiness({
    solanaReady,
    circuitState: cbState.state,
    pendingReconcile: guard.pendingReconcile,
    manualReviewOpen: guard.manualReviewOpen,
    manualReviewThreshold: cfgNow.manualReviewPauseThreshold || 1,
    autoPauseOnManualReview: cfgNow.autoPauseOnManualReview !== false,
    failedOps6h: failedOps.length,
    deploymentStage: cfgNow.deploymentStage,
    dryRun: cfgNow.dryRun,
    autoScreeningEnabled: cfgNow.autoScreeningEnabled,
    autonomyMode: cfgNow.autonomyMode,
    taeExitCount,
    taeWinRatePct: Number.isFinite(taeWinRatePct) ? taeWinRatePct : null,
    minTaeSamplesForFullStage: cfgNow.minTaeSamplesForFullStage,
    minTaeWinRateForFullStage: cfgNow.minTaeWinRateForFullStage,
    worktreeClean: worktree.clean,
    worktreeDirtyCount: worktree.dirtyCount,
    worktreeCheckAvailable: worktree.available,
    signalReportRequired: cfgNow.requireSignalReportForLive !== false,
    signalReportAvailable: signalReport.available,
    signalReportPassed: signalReport.passed,
    signalReportAgeHours: signalReport.ageHours,
    signalReportMaxAgeHours: cfgNow.signalReportMaxAgeHours,
    signalAutoRefreshEnabled: cfgNow.signalAutoRefreshEnabled !== false,
    signalAutoRefreshFailureCount: _signalRefreshFailCount,
    signalAutoRefreshFailureLimit: cfgNow.signalAutoRefreshFailureLimit,
  });

  return {
    cfgNow,
    cbState,
    guard,
    worktree,
    failedOps,
    taeExitCount,
    taeWinRatePct: Number.isFinite(taeWinRatePct) ? taeWinRatePct : null,
    signalReport,
    signalRefresh: {
      busy: _signalRefreshBusy,
      lastRunAt: _lastSignalRefreshAt || null,
      failCount: _signalRefreshFailCount,
      lastError: _lastSignalRefreshError || null,
    },
    readiness,
  };
}

// triggerHunter — dipanggil dari /hunt dan loop auto-screening
async function triggerHunter(targetCount = null, options = {}) {
  const { ignoreAutonomyPause = false } = options;
  if (!solanaReady) {
    notify('⚠️ Wallet/RPC belum siap. Perbaiki koneksi Solana sebelum menjalankan Hunter.').catch(() => { });
    return;
  }
  const guard = summarizeEntryGuard();
  const effectiveReasons = ignoreAutonomyPause
    ? guard.reasons.filter(r => r !== 'Autonomy mode PAUSED.')
    : guard.reasons;
  if (effectiveReasons.length > 0) {
    maybeNotifyEntryGuard(effectiveReasons, { force: true }).catch(() => { });
    return;
  }
  if (!circuitBreaker.isHealthy()) {
    notify(`⚠️ Circuit Breaker AKTIF (state: ${circuitBreaker.getState().state}). Trading sedang dipause karena sistem degraded.`).catch(() => { });
    return;
  }
  if (_hunterBusy && (Date.now() - _hunterBusy < LOCK_TIMEOUT_MS)) return;
  const liveCfg = getConfig();
  const openPos = getOpenPositions();
  // Cek kuota: jika targetCount diberikan, cek apakah masih ada slot
  // Jika tidak ada targetCount, gunakan maxPositions global
  const stageMax = guard.stageMaxPositions;
  const effectiveMax = targetCount != null
    ? Math.min(openPos.length + targetCount, stageMax)   // buka targetCount posisi baru
    : stageMax;
  if (openPos.length >= effectiveMax) {
    notify(`⚠️ Posisi sudah penuh (${openPos.length}/${effectiveMax}). Tutup posisi dulu sebelum entry baru.`).catch(() => { });
    return;
  }
  _hunterBusy = Date.now();
  try {
    // Aegis Pulse: Lewatkan bot & ALLOWED_ID agar Hunter bisa melakukan editMessage
    await runHunterAlpha(notify, bot, ALLOWED_ID, {
      targetCount,
      maxPositionsCap: stageMax,
    });
  }
  catch (e) {
    await urgentNotify(`❌ <b>Hunter Panic</b>\nReason: <code>${escapeHTML(e.message)}</code>`);
    console.error(`Hunter Critical Failure:`, e);
  }
  finally { _hunterBusy = 0; }
}

// Healer — hanya manage posisi, tidak ada reopen prompt
async function runHealerWithReopenCheck(options = {}) {
  const { ignoreAutonomyPause = false } = options;
  if (!solanaReady) return;
  if (!ignoreAutonomyPause && isAutonomyPaused()) {
    console.log('⏭ Healer skip — autonomy paused');
    return;
  }
  if (!circuitBreaker.isHealthy()) {
    console.log(`⏭ Healer skip — Circuit Breaker ${circuitBreaker.getState().state}`);
    return;
  }
  await checkGasReserve().catch(() => { });
  await runHealerAlpha(notify);
}


// ─── High-Frequency Watchdog (Panic Exit) ───────────────────────
// Berjalan tiap 5 menit untuk nangkis dump cepat (Supertrend + OOR) tanpa LLM.
cron.schedule('*/5 * * * *', async () => {
  if (!solanaReady) return;
  if (isAutonomyPaused()) return;

  // SHARED LOCK: Jangan jalan kalau Healer utama lagi kerja
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) {
    console.log('⏭ Watchdog skip — Healer loop sedang berjalan');
    return;
  }

  _healerBusy = Date.now();
  console.log('🩺 [index] High-Frequency Watchdog (Panic Guard) started...');
  try {
    await checkGasReserve().catch(() => { });
    await runPanicWatchdog(notify);
    console.log('✅ [index] Watchdog completed.');
  } catch (e) {
    console.error('Watchdog error:', e.message);
  } finally {
    _healerBusy = 0; // Lepas kunci
  }
});

// ─── Hourly Position Recovery (Layer 7 Self-Healing) ────────────
cron.schedule('0 * * * *', async () => {
  if (!solanaReady) return;
  try {
    await runSelfHealingSync(notify);
  } catch (e) {
    console.error('Hourly self-healing error:', e.message);
  }
});

// ─── Cron jobs ───────────────────────────────────────────────────
// Semua cron jalan setiap menit dan cek interval live dari config.
// Ini memungkinkan perubahan interval via /setconfig TANPA restart bot.

let _lastHealerRun = Date.now(); // delay run pertama sampai interval berlalu
let _lastScreeningRun = Date.now();
let _lastBalanceWarningAt = 0; // cooldown notif saldo low

cron.schedule('* * * * *', async () => {
  if (!solanaReady) return; // Prevent management spam if no wallet
  const liveCfg = getConfig();
  const now = Date.now();
  if (now - _lastHealerRun < liveCfg.managementIntervalMin * 60 * 1000) return;
  // Update SETELAH cek busy — supaya timer tidak mundur saat healer masih jalan
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) { console.log('⏭ Healer skip — masih berjalan'); return; }
  _lastHealerRun = now;
  _healerBusy = Date.now();
  try {
    await runHealerWithReopenCheck();
    autoEvolveIfReady(notify).catch(e => console.error('Auto-evolve error:', e.message));
    try { recalibrateWeights(); } catch { /* data belum cukup, skip */ }
    savePerformanceSnapshot();
  }
  catch (e) {
    await urgentNotify(`🩺 <b>Healer Panic</b>\nReason: <code>${escapeHTML(e.message)}</code>\n\n<i>Check Solscan for hanging transactions.</i>`);
    console.error(`Healer Critical Failure:`, e);
  }
  finally { _healerBusy = 0; }
});

// ─── Auto-screening Hunter — interval dibaca live dari config ────
// Aktif hanya jika autoScreeningEnabled = true di config.
// Screen pool terbaik, langsung deploy kandidat teratas (tanpa approval).

async function runAutoScreening() {
  if (!solanaReady) return;
  if (isAutonomyPaused()) {
    console.log('⏭ Auto-screening skip — autonomy paused');
    return;
  }
  if (!circuitBreaker.isHealthy()) {
    console.log(`⏭ Auto-screening skip — Circuit Breaker ${circuitBreaker.getState().state}`);
    return;
  }
  const now = Date.now();
  const isHunterBusy = _hunterBusy && (now - _hunterBusy < LOCK_TIMEOUT_MS);
  const isScreeningBusy = _screeningBusy && (now - _screeningBusy < LOCK_TIMEOUT_MS);
  if (isScreeningBusy || isHunterBusy) return;

  const liveCfg = getConfig();
  if (!liveCfg.autoScreeningEnabled) return;
  const signalState = await ensureSignalReportFresh();
  if (signalState.mode === 'blocked') {
    console.log(`⏭ Auto-screening skip — ${signalState.reason}`);
    const now = Date.now();
    if (now - _lastSignalBlockedAlertAt > 30 * 60 * 1000) {
      _lastSignalBlockedAlertAt = now;
      await notify(`⛔ Auto-screening pause: ${escapeHTML(signalState.reason)}`).catch(() => { });
    }
    return;
  }
  const guard = summarizeEntryGuard();
  if (!guard.entryAllowed) {
    console.log(`⏭ Auto-screening skip — Entry Guard aktif (${guard.reasons.join(' | ')})`);
    await maybeNotifyEntryGuard(guard.reasons).catch(() => { });
    return;
  }

  // ─── Daily Circuit Breaker Check ─────────────────────────────
  // Jika PnL hari ini ditutup minus lebih dari dailyLossLimitUsd ($5), Hunter istirahat.
  const today = getTodayResults();
  const dailyPnl = today.totalPnlUsd + today.totalFeesUsd; // Net harian $
  if (dailyPnl < -liveCfg.dailyLossLimitUsd) {
    const isFirstAlert = Date.now() - _lastBalanceWarningAt > 12 * 60 * 60 * 1000;
    if (isFirstAlert) {
      _lastBalanceWarningAt = Date.now();
      urgentNotify(
        `🛡️ *DAILY CIRCUIT BREAKER ACTIVE*\n\n` +
        `Net PnL Hari Ini: \`$${dailyPnl.toFixed(2)}\`\n` +
        `Limit Kerugian: \`$${liveCfg.dailyLossLimitUsd.toFixed(2)}\`\n\n` +
        `_Batas kerugian harian tercapai. Hunter dipaksa istirahat demi keamanan modal lu, Bos!_`
      ).catch(() => { });
    }
    console.log(`[index] Daily Circuit Breaker: Skip screening (Daily PnL: $${dailyPnl.toFixed(2)})`);
    return;
  }

  const openPos = getOpenPositions();
  const conservativeMax = Math.max(1, Number(liveCfg.signalConservativeMaxPositions || 1));
  const effectiveMax = signalState.mode === 'conservative'
    ? Math.min(guard.stageMaxPositions, conservativeMax)
    : guard.stageMaxPositions;
  if (openPos.length >= effectiveMax) {
    console.log(`⏭ Hunter skip — slot penuh (${openPos.length}/${effectiveMax}) [stage:${guard.stage}${signalState.mode === 'conservative' ? '|signal=conservative' : ''}]`);
    return;
  }

  const balance = await getWalletBalance().catch(() => '0');
  const needed = liveCfg.deployAmountSol + (liveCfg.gasReserve ?? 0.02);

  if (safeNum(balance) < needed) {
    const balNum = safeNum(balance).toFixed(4);
    console.log(`⏭ Hunter skip — saldo low (${balNum} < ${needed.toFixed(2)})`);

    // Log internal & skip (notifikasi sudah ditangani oleh Global Low Gas Alert per jam)
    console.log(`⏭ Hunter skip — saldo low (${balNum} < ${needed.toFixed(2)})`);
    return;
  }

  // Reset warning kalau saldo sudah cukup lagi
  _lastBalanceWarningAt = 0;

  _screeningBusy = Date.now();
  _hunterBusy = Date.now();
  try {
    if (signalState.mode === 'conservative') {
      const now = Date.now();
      if (now - _lastSignalConservativeAlertAt > 30 * 60 * 1000) {
        _lastSignalConservativeAlertAt = now;
        await notify(`⚠️ Signal report belum fresh/lolos. Hunter jalan mode konservatif (${openPos.length}/${effectiveMax} posisi max).`).catch(() => { });
      }
    }
    await runHunterAlpha(notify, bot, ALLOWED_ID, {
      maxPositionsCap: effectiveMax,
    });
  } catch (e) {
    console.error('Auto-screening error:', e.message);
    notify(`❌ Auto-screening error: ${e.message}`).catch(() => { });
  } finally {
    _screeningBusy = 0;
    _hunterBusy = 0;
  }
}

cron.schedule('* * * * *', async () => {
  if (!solanaReady) return; // Prevent screening spam if no wallet
  const liveCfg = getConfig();
  const now = Date.now();
  if (now - _lastScreeningRun < liveCfg.screeningIntervalMin * 60 * 1000) return;
  _lastScreeningRun = now;
  try { await runAutoScreening(); }
  catch (e) { console.error('Auto-screening cron error:', e.message); }
});


// ─── Daily Backup jam 2 pagi ─────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  try {
    savePerformanceSnapshot();
    const count = backupAllData();
    console.log(`💾 Daily backup selesai: ${count} file disimpan ke backups/`);

    // Backup database
    const dbBackupPath = await dbBackup.createBackup();
    if (dbBackupPath) {
      console.log(`💾 Database backup created: ${dbBackupPath}`);
    }
  } catch (e) { console.error('Daily backup error:', e.message); }
});

// ─── Daily Results Report jam 9 malam ────────────────────────────
cron.schedule('0 21 * * *', async () => {
  try {
    const results = getTodayResults();
    await notify(formatDailyReport(results));
  } catch (e) { console.error('Daily results error:', e.message); }
});

// ─── Opportunity Scanner — setiap 15 menit ───────────────────────
// Scan top 25 pools untuk strategi: Evil Panda Master
// Alert dikirim regardless posisi terbuka / balance / status deploy
// KOMENTAR: Dimatikan atas permintaan user untuk mengurangi noise notifikasi.
// ─── Hourly Pulse Report & Gas Alert ──────────────────
cron.schedule('0 * * * *', async () => {
  if (!solanaReady) return;
  try {
    const balance = await getWalletBalance();
    const balNum = safeNum(balance);
    const openPos = getOpenPositions();

    // 1. Send Pulse Report (if enabled)
    const cfg = getConfig();
    if (cfg.hourlyPulseEnabled) {
      let msg = `💓 *HOURLY PULSE REPORT*\n\n` +
        `• Wallet: +${balNum.toFixed(4)} SOL\n` +
        `• Active Positions: ${openPos.length}\n` +
        `• Status: 🎋 Auto-Harvest ${cfg.autoHarvestEnabled ? 'Active' : 'Disabled'}\n\n` +
        `_Sistem berjalan normal. Semua penjaga gawang aktif._`;

      await notify(msg);
    }

    // 2. Gas Alert (Keep existing logic)
    if (balNum < 0.05) {
      const walletAddr = getWallet().publicKey.toString();
      await urgentNotify(
        `⛽ *URGENT: Saldo SOL Kritis!*\n\n` +
        `Sisa saldo: \`${balNum.toFixed(4)} SOL\`\n` +
        `Target wallet: \`${walletAddr}\`\n\n` +
        `_Segera isi bensin biar si Healer gak mogok pas mau nyelametin modal lu, Bos!_`
      );
    }
  } catch (e) {
    console.error('Hourly Pulse / Gas Alert error:', e.message);
  }
});

// ─── Midnight Sweeper — setiap hari jam 1 pagi ──────────────────
cron.schedule('0 1 * * *', async () => {
  try {
    await runMidnightSweeper(notify);
  } catch (e) { console.error('Midnight sweeper error:', e.message); }
});

// ─── Daily Briefing jam 7 pagi ───────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    await syncStartingBalanceBaseline();
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const stats = getPositionStats();
    const memStats = getMemoryStats();
    const instincts = getInstinctsContext();

    const briefLines = [
      kv('Balance', `${safeNum(balance).toFixed(4)} SOL`, 12),
      kv('Posisi', `${openPos.length} / ${getConfig().maxPositions} terbuka`, 12),
      hr(38),
      kv('Closed', `${stats.closedPositions}  Win: ${stats.winRate}  Avg: ${stats.avgPnl}`, 12),
      kv('Total PnL', `+$${stats.totalPnlUsd}  Fees: +$${stats.totalFeesUsd}`, 12),
      kv('Range Eff', `${memStats.avgRangeEfficiency}`, 12),
      hr(38),
      kv('Instincts', `${memStats.instinctCount}  Evolusi: ${memStats.evolutionCount}x`, 12),
      kv('Last Evolve', memStats.lastAutoEvolution
        ? new Date(memStats.lastAutoEvolution).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(',', '')
        : 'Belum pernah', 12),
      hr(38),
      getConfig().dryRun ? '🟡 Mode: DRY RUN' : '🔴 Mode: LIVE',
      getConfig().autoScreeningEnabled ? `🤖 Auto-Screen: ON (${getConfig().screeningIntervalMin}min)` : '🤖 Auto-Screen: OFF',
    ];
    let text = `☀️ <b>Daily Briefing</b>\n\n<pre><code>${briefLines.join('\n')}</code></pre>`;
    if (instincts) text += `\n${instincts}`;

    await notify(text);
  } catch (e) { console.error('Daily briefing error:', e.message); }
});

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/testmodel/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Testing model connection...');
  try {
    // Test API + fetch available models (operasi lambat, tapi ini memang tujuannya)
    const [testResult, discoveredModels] = await Promise.all([
      testCurrentModel(),
      discoverAllModels(),
    ]);
    let text = formatModelStatus();
    text += `\n\n<b>Test Result:</b> ${testResult.ok ? '✅ OK' : `❌ ${testResult.error}`}\n`;
    if (discoveredModels.length > 0) {
      text += `\n📋 <b>All discovered models (${discoveredModels.length}):</b>\n`;
      // Show top models by quality
      const topModels = listAvailableModels({ sortBy: 'quality' }).slice(0, 10);
      topModels.forEach(m => {
        const free = m.isFree ? ' 🆓' : '';
        text += `• <code>${m.id}</code>${free}\n`;
      });
      if (discoveredModels.length > 10) {
        text += `... and ${discoveredModels.length - 10} more\n`;
      }
    }
    await sendLong(chatId, text, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/model(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const modelId = match[1]?.trim();

  if (!modelId) {
    // Tampilkan status instan — TANPA API call (gunakan /testmodel untuk test)
    try {
      const text = formatModelStatus();
      await sendLong(chatId, text, { parse_mode: 'HTML' });

      // Also show available models discovered from configured providers
      const discoveredModels = listAvailableModels({ sortBy: 'quality' });
      if (discoveredModels.length > 0) {
        const modelList = formatModelList(discoveredModels);
        await sendLong(chatId, modelList, { parse_mode: 'HTML' });
      }
    } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
    return;
  }

  // Reset ke default
  if (modelId === 'reset') {
    updateConfig({ activeModel: null });
    const fallback = process.env.AI_MODEL || getConfig().generalModel || 'openai/gpt-4o-mini';
    const envNote = process.env.AI_MODEL
      ? `\n\n⚠️ <code>AI_MODEL</code> env aktif: <code>${process.env.AI_MODEL}</code>\n<i>/model command tidak bisa override env. Hapus <code>AI_MODEL</code> dari .env untuk pakai /model.</i>`
      : '';
    bot.sendMessage(chatId, `✅ <b>Model di-reset</b>\n\nKembali ke: <code>${fallback}</code>${envNote}`, { parse_mode: 'HTML' });
    return;
  }

  // Warn jika AI_MODEL env aktif — /model command tidak akan efektif
  if (process.env.AI_MODEL) {
    bot.sendMessage(
      chatId,
      `⚠️ <b>AI_MODEL env aktif</b>\n\nEnv: <code>${escapeHTML(process.env.AI_MODEL)}</code>\n\n` +
      `<code>/model</code> command tidak bisa override env var.\n` +
      `Hapus atau ubah <code>AI_MODEL</code> di file <code>.env</code> lalu restart bot untuk ganti model.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  bot.sendMessage(chatId, `🔄 Testing <code>${modelId}</code>...`, { parse_mode: 'HTML' });
  const result = await testModel(modelId);

  if (!result.ok) {
    bot.sendMessage(
      chatId,
      `❌ <b>Model gagal</b>\n\nModel: <code>${escapeHTML(modelId)}</code>\nError: <code>${escapeHTML(result.error)}</code>\n\n<i>Coba model lain: <code>/model &lt;model_id&gt;</code></i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Model valid — simpan ke config, berlaku segera tanpa restart
  updateConfig({ activeModel: modelId });
  bot.sendMessage(
    chatId,
    `✅ <b>Model berhasil diganti</b>\n\nModel: <code>${escapeHTML(modelId)}</code>\n\n<i>Berlaku segera — tidak perlu restart.</i>\nReset ke default: <code>/model reset</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/results/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  try {
    const results = getTodayResults();
    await sendLong(msg.chat.id, formatDailyReport(results), { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

// 📊 TAE Exit Tracking Analytics
bot.onText(/\/tae_stats/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  try {
    const summary = getTAESummary();
    const byTrigger = getTriggerComparison();
    const byZone = getExitsByZone();
    const patientAnalysis = getPatientExitAnalysis();
    const totalCount = getExitEventCount();

    if (totalCount === 0) {
      await bot.sendMessage(msg.chat.id,
        `📊 <b>TAE Exit Tracking</b>\n\n` +
        `⏳ <i>No exit events recorded yet. System ready!</i>\n` +
        `Monitor this dashboard after first positions close.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    let report = `📊 <b>TAE SYSTEM ANALYTICS</b>\n\n`;

    // Overall Summary
    report += `<b>📈 Overall Performance:</b>\n`;
    report += `├─ Total Exits: <code>${summary.total_exits}</code>\n`;
    report += `├─ Avg PnL: <code>${(summary.overall_avg_pnl || 0).toFixed(2)}%</code>\n`;
    report += `├─ Win Rate: <code>${summary.overall_win_rate ? summary.overall_win_rate.toFixed(1) : '0'}%</code> (${summary.total_wins || 0}W)\n`;
    report += `├─ Avg Hold: <code>${summary.avg_hold || 0}</code> min\n`;
    report += `├─ Best Exit: <code>+${(summary.best_exit || 0).toFixed(2)}%</code>\n`;
    report += `├─ Worst Exit: <code>${(summary.worst_exit || 0).toFixed(2)}%</code>\n`;
    report += `├─ Total PnL USD: <code>$${(summary.total_pnl_usd || 0).toFixed(2)}</code>\n`;
    report += `└─ Total Fees: <code>$${(summary.total_fees || 0).toFixed(2)}</code>\n\n`;

    // Performance by Trigger
    if (byTrigger.length > 0) {
      report += `<b>🎯 Exit Triggers Performance:</b>\n`;
      for (const t of byTrigger) {
        const total = Number(t.total || 0);
        const wins = Number(t.wins || 0);
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(0) : 0;
        report += `├─ <code>${t.exit_trigger}</code>\n`;
        report += `│  ├─ Count: ${total} | Avg PnL: <code>${(t.avg_pnl_pct || 0).toFixed(2)}%</code>\n`;
        report += `│  ├─ Win Rate: <code>${winRate}%</code> (${wins}/${total})\n`;
        report += `│  └─ Avg Hold: <code>${(t.avg_hold_min || 0).toFixed(0)}</code> min\n`;
      }
      report += `\n`;
    }

    // Performance by Zone
    if (byZone.length > 0) {
      report += `<b>🎪 Zone Performance:</b>\n`;
      for (const z of byZone) {
        const winRate = z.count > 0 ? ((z.wins / z.count) * 100).toFixed(0) : 0;
        report += `├─ <code>${z.exit_zone}</code>\n`;
        report += `│  ├─ Avg PnL: <code>${(z.avg_pnl_pct || 0).toFixed(2)}%</code> (${z.count} exits)\n`;
        report += `│  └─ Win Rate: <code>${winRate}%</code>\n`;
      }
      report += `\n`;
    }

    // LP Patience Modifier Impact
    if (patientAnalysis.length > 0) {
      report += `<b>⏸️ LP Patience Modifier Impact:</b>\n`;
      for (const p of patientAnalysis) {
        const mode = p.mode || (p.lper_patience_active === 1 ? 'Active (High Fee)' : 'Inactive (Low Fee)');
        const winRate = p.count > 0 ? ((p.wins / p.count) * 100).toFixed(1) : 0;
        report += `├─ ${mode}\n`;
        report += `│  ├─ Avg PnL: <code>${(p.avg_pnl_pct || 0).toFixed(2)}%</code>\n`;
        report += `│  └─ Win Rate: <code>${winRate}%</code> (${p.count} exits)\n`;
      }
      report += `\n`;
    }

    report += `<i>Updated: ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC</i>`;

    await sendLong(msg.chat.id, report, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[tae_stats] Error:', e.message);
    bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id,
    `🦞 <b>AI-Agent-DLMM</b> <code>[LIVE]</code>\n\n` +
    `🐼 <b>Hunter</b> — Adaptive Panda logic\n` +
    `🩺 <b>Healer</b> — Autonomous position management\n` +
    `🧠 <b>Brain</b> — Intelligence dashboard\n\n` +
    `<b>Monitoring:</b>\n` +
    `• <code>/status</code> — On-chain position details\n` +
    `• <code>/radar_report</code> — 🛰️ Radar report full di Telegram\n` +
    `• <code>/results</code> — Daily PnL report\n\n` +
    `<b>Control:</b>\n` +
    `• <code>/hunting</code> — 🦅 Sultan Sniper Trigger\n` +
    `• <code>/heal</code> — 🩺 Position Management\n` +
    `• <code>/claim &lt;position&gt;</code> — 💸 Claim fees manual\n` +
    `• <code>/zap &lt;addr&gt;</code> — 🆘 Emergency Exit\n` +
    `• <code>/check &lt;mint&gt;</code> — 🔍 RugCheck\n` +
    `• <code>/autoscreen on|off</code> — Toggle Autonomy\n` +
    `• <code>/pause</code> / <code>/resume</code> — Pause/lanjut loop otonom\n` +
    `• <code>/stage [shadow|canary|full]</code> — Deployment Gate\n` +
    `• <code>/override_range &lt;pct&gt; [strategy]</code> — Override range entry\n` +
    `• <code>/rollback</code> — Safe-mode rollback cepat\n` +
    `• <code>/dryrun on|off</code> — Toggle Simulation\n\n` +
    `<b>Brain &amp; Evolution:</b>\n` +
    `<code>/brain</code> <code>/lessons</code> <code>/evolve</code> <code>/evolve_memory</code> <code>/poolmemory</code>\n\n` +
    `<b>Admin:</b>\n` +
    `<code>/setconfig</code> <code>/safety</code> <code>/providers</code> <code>/model</code> <code>/health</code> <code>/preflight</code>\n` +
    `<code>/system_update</code> — 🚀 Upgrade Aegis Supreme (v75.9)\n\n` +
    `<i>Atau chat bebas untuk instruksi manual!</i>`,
    { parse_mode: 'HTML' }
  );
});


bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const [balance, openPos, stats, lpPnlMap] = await Promise.all([
      getWalletBalance(),
      Promise.resolve(getOpenPositions()),
      Promise.resolve(getPositionStats()),
      getLpPnlMap(),
    ]);
    const memStats = getMemoryStats();

    // Fetch on-chain data per posisi: range status + PnL live
    const chainMap = {}; // positionAddress → { status, pnlSol, pnlPct, feeSol, manualClose }
    await Promise.all(openPos.map(async (pos) => {
      try {
        const onChain = await getPositionInfo(pos.pool_address);
        const match = onChain?.find(p => p.address === pos.position_address);
        if (!match && Array.isArray(onChain)) {
          // On-chain lookup berhasil tapi posisi tidak ada → kemungkinan ditutup manual
          chainMap[pos.position_address] = { status: 'Manual', manualClose: true };
        } else if (match) {
          const snapshot = resolvePositionSnapshot({
            dbPosition: pos,
            livePosition: match,
            providerPnlPct: lpPnlMap.get(pos.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
          });
          chainMap[pos.position_address] = {
            status: snapshot.status,
            pnlSol: snapshot.pnlSol,
            pnlPct: snapshot.pnlPct,
            feeSol: snapshot.feeSol,
            pnlSource: snapshot.pnlSource,
            lifecycleState: snapshot.lifecycleState,
            manualClose: false,
          };
        } else {
          chainMap[pos.position_address] = { status: 'NoData' };
        }
      } catch {
        chainMap[pos.position_address] = { status: 'Err' };
      }
    }));

    // Detect suspected manual close, but never mutate DB from /status.
    // Reconciliation must happen in healer flow after stronger verification.
    for (const pos of openPos) {
      const c = chainMap[pos.position_address] || { status: 'Unknown' };
      if (c?.manualClose) {
        let accountExists = true;
        try {
          const info = await getConnection().getAccountInfo(new PublicKey(pos.position_address));
          accountExists = info !== null;
        } catch {
          accountExists = true;
        }

        if (!accountExists) {
          chainMap[pos.position_address] = {
            ...c,
            status: 'SuspectClosed',
            suspectedManualClose: true,
          };
          notify(
            `⚠️ <b>Suspected Manual Close</b>\n\n` +
            `Pool     : <code>${pos.pool_address}</code>\n` +
            `Posisi   : <code>${pos.position_address}</code>\n` +
            `Strategi : ${pos.strategy_used || '-'}\n\n` +
            `<i>Posisi tidak terlihat via SDK/API dan account on-chain tidak ditemukan.</i>\n` +
            `<i>Status bersifat sementara; healer akan reconcile sebelum perubahan DB.</i>`
          ).catch(() => { });
        } else {
          chainMap[pos.position_address] = {
            ...c,
            status: 'RPCInconsistent',
            manualClose: false,
            suspectedManualClose: false,
          };
        }
      }
    }

    // Keep all open positions visible in /status.
    const activePos = openPos;

    // ── Header ───────────────────────────────────────────────────
    let text = `📊 <b>Status Bot</b> — 🐼 <b>ADAPTIVE PANDA</b>\n\n`;

    const pnlSign = (v) => safeNum(v) >= 0 ? '+' : '';
    const headerLines = [
      kv('Balance', `${safeNum(balance).toFixed(4)} SOL`, 10),
      kv('Posisi', `${activePos.length} / ${getConfig().maxPositions}`, 10),
      kv('Closed', `${stats.closedPositions}  Win: ${stats.winRate}`, 10),
      kv('PnL', `${pnlSign(stats.totalPnlUsd)}$${safeNum(stats.totalPnlUsd || 0).toFixed(2)}  Fees: +$${safeNum(stats.totalFeesUsd || 0).toFixed(2)}`, 10),
      kv('Instincts', `${memStats.instinctCount}`, 10),
    ];
    text += codeBlock(headerLines) + '\n';

    // ── Positions table ──────────────────────────────────────────
    if (activePos.length === 0) {
      text += `_Tidak ada posisi terbuka._`;
    } else {
      // Col widths: Pool=10, Strategi=11, PnL=11, Status=8
      const W = [10, 11, 11, 8];
      const rows = [
        [padR('POOL', W[0]), padR('STRATEGI', W[1]), padR('PnL◎', W[2]), 'STATUS'],
        [hr(W[0]), hr(W[1]), hr(W[2]), hr(W[3])],
        ...activePos.map(pos => {
          const cd = chainMap[pos.position_address];
          const pnlStr = cd?.pnlSol != null
            ? `${cd.pnlSol >= 0 ? '+' : ''}${cd.pnlSol.toFixed(4)}`
            : '?';
          const pctStr = cd?.pnlPct != null
            ? ` (${cd.pnlPct >= 0 ? '+' : ''}${cd.pnlPct.toFixed(1)}%)`
            : '';
          return [
            padR(shortAddr(pos.pool_address), W[0]),
            padR(shortStrat(pos.strategy_used), W[1]),
            padR(pnlStr + pctStr, W[2]),
            cd?.status || '?',
          ];
        }),
        [hr(W[0]), hr(W[1]), hr(W[2]), hr(W[3])],
        ...activePos.map(pos => {
          const cd = chainMap[pos.position_address];
          const openedAt = new Date(pos.created_at)
            .toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })
            .replace(',', '');
          const feeStr = cd?.feeSol != null ? `  Fee:+${cd.feeSol.toFixed(4)}◎` : '';
          const lifecycleStr = cd?.lifecycleState ? `  ${cd.lifecycleState}` : '';
          return [`  ${openedAt}  ${shortAddr(pos.position_address)}${feeStr}${lifecycleStr}`, '', '', ''];
        }),
      ];

      const tableLines = rows.map(cols =>
        cols.map((c, i) => i < W.length - 1 ? padR(c, W[i] + 2) : c).join('')
      );
      text += `<pre><code>${tableLines.join('\n')}</code></pre>`;
    }

    await sendLong(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/(?:evolve_memory|instinct_evolve)/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Menjalankan Evolution Cycle...');
  try {
    const updates = await runEvolutionCycle();
    if (updates) {
      bot.sendMessage(chatId, `✅ <b>Evolusi Berhasil</b>\n\nThresholds diperbarui: <code>${Object.keys(updates).join(', ')}</code>`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada update yang diperlukan. Thresholds saat ini masih optimal berdasarkan data trade terakhir.');
    }
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/brain/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const summary = getBrainSummary();
    bot.sendMessage(chatId, summary, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

// /pos — snapshot posisi cepat via REST API (tanpa LLM, tanpa on-chain RPC)
bot.onText(/\/pos$/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const openPos = getOpenPositions();
    if (!openPos.length) {
      return bot.sendMessage(chatId, '<i>Tidak ada posisi terbuka.</i>', { parse_mode: 'HTML' });
    }

    const poolsToCheck = [...new Set(openPos.map(p => p.pool_address))];
    const [results, lpPnlMap] = await Promise.all([
      Promise.allSettled(poolsToCheck.map(addr => getPositionInfoLight(addr))),
      getLpPnlMap(),
    ]);

    // Build chainMap: positionAddress → pos data
    const chainMap = {};
    for (let i = 0; i < poolsToCheck.length; i++) {
      const r = results[i];
      if (r.status !== 'fulfilled' || !r.value?.length) continue;
      for (const pos of r.value) chainMap[pos.address] = pos;
    }

    const time = new Date().toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
    });
    let text = `📊 <b>Posisi Terbuka — ${time} WIB</b>\n\n`;

    for (const pos of openPos) {
      const cd = chainMap[pos.position_address];
      const deploySol = safeNum(pos.deployed_sol ?? 0);
      const snapshot = cd ? resolvePositionSnapshot({
        dbPosition: pos,
        livePosition: cd,
        providerPnlPct: lpPnlMap.get(pos.position_address),
        directPnlPct: Number.isFinite(cd?.pnlPct) ? cd.pnlPct : null,
      }) : null;
      const pnlPct = snapshot ? snapshot.pnlPct.toFixed(2) : '?';
      const pnlSign = safeNum(pnlPct) >= 0 ? '+' : '';
      const rangeIcon = cd ? (cd.inRange ? '🟢' : '🔴') : '⚪';
      const oorLabel = cd && !cd.inRange ? ' OOR' : '';
      const feesStr = cd ? `${(cd.feeCollectedSol || 0).toFixed(4)} SOL` : '?';
      const strat = pos.strategy_used ? ` · ${pos.strategy_used}` : '';
      const symbol = pos.token_x_symbol || pos.token_x?.slice(0, 6) || '?';

      // Invert harga kalau SOL pair dan data dari REST API (tidak ada displayCurrentPrice)
      const WSOL_M = 'So11111111111111111111111111111111111111112';
      const isSOLP = pos.token_y === WSOL_M;
      const rawPrice = cd?.currentPrice;
      const priceDisp = cd?.displayCurrentPrice != null
        ? `${cd.displayCurrentPrice} ${cd.priceUnit || ''}`
        : rawPrice > 0
          ? `${isSOLP ? (1 / rawPrice).toFixed(4) : rawPrice.toFixed(8)} ${isSOLP ? `${symbol}/SOL` : ''}`
          : '';

      text +=
        `${rangeIcon} <code>${pos.pool_address.slice(0, 8)}...</code> <b>${symbol}/SOL</b>${strat}${oorLabel}\n` +
        `  PnL: <code>${pnlSign}${pnlPct}%</code>  Fees: <code>${feesStr}</code>  Deploy: <code>${deploySol.toFixed(4)} SOL</code>\n` +
        (snapshot?.lifecycleState ? `  State: <code>${snapshot.lifecycleState}</code>\n` : '') +
        (priceDisp ? `  Harga: <code>${priceDisp}</code>\n` : '');
    }

    text += `\n<i>Data via Meteora API — gunakan /status untuk data on-chain penuh.</i>`;
    await sendLong(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/zap(?:\s+(\S+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const target = match[1]?.trim();

  if (!target) {
    return bot.sendMessage(chatId, '🆘 <b>Emergency Zap Out</b>\n\nGunakan: <code>/zap &lt;mint_atau_pool_address&gt;</code>\n\n<i>Perintah ini akan menutup posisi dan swap SEMUA token ke SOL secara paksa via Jupiter (3x retry).</i>', { parse_mode: 'HTML' });
  }

  const openPos = getOpenPositions();
  const matchPos = openPos.find(p => p.position_address === target || p.pool_address === target || p.token_x === target);

  if (!matchPos) {
    return bot.sendMessage(chatId, `❌ Posisi tidak ditemukan untuk: <code>${escapeHTML(target)}</code>`, { parse_mode: 'HTML' });
  }

  bot.sendMessage(chatId, `⚠️ <b>KONFIRMASI ZAP OUT</b>\n\nKamu akan menutup paksa posisi:\nToken: <b>${matchPos.token_x_symbol || 'unknown'}</b>\nPool: <code>${shortAddr(matchPos.pool_address)}</code>\n\nKetik <code>GAS ZAP</code> untuk mengeksekusi.`, { parse_mode: 'HTML' });

  const confirmHandler = async (cMsg) => {
    if (cMsg.from.id === ALLOWED_ID && cMsg.text === 'GAS ZAP' && cMsg.chat.id === chatId) {
      bot.removeListener('message', confirmHandler);
      bot.sendMessage(chatId, '🚀 <b>ZAPPING OUT...</b> ⚡', { parse_mode: 'HTML' });
      try {
        await executeTool('zap_out', {
          pool_address: matchPos.pool_address,
          position_address: matchPos.position_address,
          reasoning: 'MANUAL_ZAP_EMERGENCY'
        }, notify);
      } catch (e) {
        bot.sendMessage(chatId, `❌ Zap failed: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
      }
    } else if (cMsg.from.id === ALLOWED_ID && cMsg.chat.id === chatId && cMsg.text !== 'GAS ZAP' && !cMsg.text.startsWith('/')) {
      bot.removeListener('message', confirmHandler);
      bot.sendMessage(chatId, '❌ Zap dibatalkan.');
    }
  };
  bot.on('message', confirmHandler);
  setTimeout(() => bot.removeListener('message', confirmHandler), 30000);
});

bot.onText(/\/pools/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Analisa dan tampilkan 5 pool DLMM terbaik berdasarkan fee APR saat ini');
});

bot.onText(/\/(hunt|hunting)/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const now = Date.now();
  const isHunterBusy = _hunterBusy && (now - _hunterBusy < LOCK_TIMEOUT_MS);
  const isScreeningBusy = _screeningBusy && (now - _screeningBusy < LOCK_TIMEOUT_MS);
  if (isHunterBusy || isScreeningBusy) {
    bot.sendMessage(msg.chat.id, '⏳ Hunter sedang berjalan (atau terkunci). Tunggu siklus saat ini selesai.');
    return;
  }
  bot.sendMessage(msg.chat.id, '🦅 Menjalankan Hunter Alpha...');
  try { await triggerHunter(null, { ignoreAutonomyPause: true }); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/heal/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) {
    bot.sendMessage(msg.chat.id, '⏳ Healer sedang berjalan. Tunggu siklus saat ini selesai.');
    return;
  }
  bot.sendMessage(msg.chat.id, '🩺 Menjalankan Healer Alpha...');
  _healerBusy = Date.now();
  try { await runHealerWithReopenCheck({ ignoreAutonomyPause: true }); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
  finally { _healerBusy = 0; }
});


bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const tokenMint = match[1]?.trim();
  if (!tokenMint) {
    bot.sendMessage(chatId, '⚠️ Format: <code>/check &lt;token_mint&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  bot.sendMessage(chatId, `🔍 Screening <code>${tokenMint.slice(0, 16)}...</code>`, { parse_mode: 'HTML' });
  try {
    const result = await screenToken(tokenMint);
    bot.sendMessage(chatId, formatScreenResult(result), { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/system_update/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;

  const text = `🔄 <b>SYSTEM UPDATE &amp; RESTART</b>\n\n` +
    `Anda akan melakukan pembaruan sistem:\n` +
    `1. Ambil kode terbaru (<code>git pull</code>)\n` +
    `2. Update dependensi (<code>npm install</code>)\n` +
    `3. Jalankan migrasi database otomatis\n` +
    `4. Restart bot (via PM2)\n\n` +
    `⚠️ <b>PERINGATAN</b>: Pastikan bot berjalan menggunakan PM2 di VPS agar bisa restart otomatis.\n\n` +
    `Ketik <code>GAS UPDATE</code> untuk mengeksekusi pembaruan.`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

  const updateHandler = async (cMsg) => {
    if (cMsg.from.id === ALLOWED_ID && cMsg.text === 'GAS UPDATE' && cMsg.chat.id === chatId) {
      bot.removeListener('message', updateHandler);
      bot.sendMessage(chatId, '📥 <b>Memulai Update...</b>', { parse_mode: 'HTML' });

      try {
        // Step 1: Git Pull
        bot.sendMessage(chatId, '📡 <code>git pull</code> dalam proses...', { parse_mode: 'HTML' });
        const gitResult = await performGitPull();
        bot.sendMessage(chatId, `✅ <b>Git Pull Success:</b>\n<pre><code>${gitResult}</code></pre>`, { parse_mode: 'HTML' });

        // Step 2: NPM Install
        bot.sendMessage(chatId, '📦 <code>npm install</code> dalam proses (Mungkin agak lama)...', { parse_mode: 'HTML' });
        await performNpmInstall();
        bot.sendMessage(chatId, '✅ <b>NPM Install Success.</b>', { parse_mode: 'HTML' });

        // Step 3: Post-update health checks (block restart jika gagal)
        bot.sendMessage(chatId, '🧪 Menjalankan post-update checks (<code>lint + readiness tests</code>)...', { parse_mode: 'HTML' });
        const checksOutput = await performPostUpdateChecks();
        const preview = escapeHTML((checksOutput || '').slice(-3500));
        bot.sendMessage(chatId, `✅ <b>Post-update checks passed</b>\n<pre><code>${preview || 'OK'}</code></pre>`, { parse_mode: 'HTML' });

        // Step 4: Restart
        bot.sendMessage(chatId, '🚀 <b>Memicu Restart Sistem...</b> Bot akan offline sebentar.', { parse_mode: 'HTML' });

        setTimeout(() => {
          process.exit(0); // Trigger PM2 Restart
        }, 1000);

      } catch (err) {
        bot.sendMessage(chatId, `❌ <b>Update Gagal:</b>\n\n<code>${escapeHTML(err.message)}</code>`, { parse_mode: 'HTML' });
      }
    } else if (cMsg.from.id === ALLOWED_ID && cMsg.chat.id === chatId && cMsg.text !== 'GAS UPDATE' && !cMsg.text.startsWith('/')) {
      bot.removeListener('message', updateHandler);
      bot.sendMessage(chatId, '❌ Update dibatalkan.');
    }
  };

  bot.on('message', updateHandler);
  setTimeout(() => bot.removeListener('message', updateHandler), 60000); // 1 minute timeout
});

bot.onText(/\/library/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const ROOT = join(__dirname, '../data');
  const DATA_FILES = [
    join(ROOT, 'memory.json'),
    join(ROOT, 'lessons.json'),
    join(ROOT, 'strategyPerformance.json'),
    join(__dirname, '../strategy-library.json'),
  ];
  const stats = getLibraryStats();
  let text = `📚 <b>Strategy Library</b>\n\n`;
  text += `Total: ${stats.totalStrategies} | Built-in: ${stats.builtinCount} | Research: ${stats.researchedCount}\n`;
  text += `Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Belum ada'}\n\n`;
  text += `<b>Top Strategi:</b>\n`;
  stats.topStrategies.forEach((s, i) => {
    text += `${i + 1}. ${escapeHTML(s.name)} (<i>${escapeHTML(s.type)}</i>) — ${(s.confidence * 100).toFixed(0)}%\n`;
  });
  text += `\n<i>/research untuk tambah strategi dari artikel</i>`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /strategy_report — per-strategy performance: trades, win rate, avg PnL, confidence
bot.onText(/\/strategy_report/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const library = loadLibrary();
  const strategies = library.strategies || [];

  if (strategies.length === 0) {
    await sendLong(chatId, `📊 Strategy library kosong.`);
    return;
  }

  let text = `📊 <b>Strategy Performance Report</b>\n\n`;

  for (const s of strategies) {
    const history = Array.isArray(s.performanceHistory) ? s.performanceHistory : [];
    const trades   = history.length;
    const wins     = history.filter(p => p.profitable).length;
    const winRate  = trades > 0 ? ((wins / trades) * 100).toFixed(0) : '—';
    const avgPnl   = trades > 0
      ? (history.reduce((sum, p) => sum + (Number(p.pnlPct) || 0), 0) / trades).toFixed(2)
      : '—';
    const conf     = typeof s.confidence === 'number' ? (s.confidence * 100).toFixed(0) + '%' : '—';

    text += `<b>${escapeHTML(s.name)}</b> <i>(${escapeHTML(s.id)})</i>\n`;
    text += `  Trades: ${trades} | Win: ${winRate}% | Avg PnL: ${avgPnl}% | Conf: ${conf}\n\n`;
  }

  text += `<i>Confidence diperbarui otomatis setelah 3+ trade.</i>`;
  await sendLong(chatId, text);
});

// Research sessions state
const researchSessions = new Map();

bot.onText(/\/research/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const inlineText = msg.text.replace('/research', '').trim();
  if (inlineText.length > 100) {
    await processResearchArticle(chatId, inlineText);
    return;
  }
  researchSessions.set(msg.from.id, true);
  bot.sendMessage(chatId,
    `🔬 <b>Research Mode Aktif</b>\n\nPaste artikel strategi DLMM sekarang.\n<i>/cancel untuk batal.</i>`,
    { parse_mode: 'HTML' }
  );
});

async function processResearchArticle(chatId, articleText) {
  bot.sendMessage(chatId, '🔬 Menganalisa artikel...');
  try {
    const summary = await summarizeArticle(articleText);
    const result = await extractStrategiesFromArticle(articleText);
    let text = `📰 <b>Ringkasan:</b>\n${escapeHTML(summary)}\n\n`;
    if (result.extracted.length === 0) {
      text += `⚠️ ${escapeHTML(result.message)}`;
    } else {
      text += `✅ <b>${result.extracted.length} Strategi Ditemukan:</b>\n\n`;
      result.extracted.forEach((s, i) => {
        text += `<b>${i + 1}. ${escapeHTML(s.name)}</b> (<i>${escapeHTML(s.type)}</i>)\n`;
        text += `📊 Market: ${escapeHTML(s.marketConditions?.trend?.join(', '))}\n`;
        text += `🎯 Entry: ${escapeHTML(s.entryConditions)}\n`;
        text += `🚪 Exit: ${escapeHTML(s.exitConditions)}\n\n`;
      });
      text += `<i>Strategi aktif di Library dan akan dipakai Hunter Alpha.</i>`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
}


bot.onText(/\/evolve/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Evolving dari trading history...');
  try {
    const result = await evolveFromTrades();
    let text = `🧬 <b>Evolution Round ${getMemoryStats().evolutionCount}</b>\n\n`;
    text += `${escapeHTML(result.summary)}\n\n`;
    text += `Win rate: ${result.stats.winRate}% | Avg PnL: $${result.stats.avgPnl}\n\n`;
    if (result.appliedWeights) {
      const w = result.appliedWeights;
      text += `⚖️ <b>Darwin Weights Diperbarui:</b>\n`;
      text += `  mcap: ${w.mcap} | fee/TVL: ${w.feeActiveTvlRatio} | volume: ${w.volume} | holders: ${w.holderCount}\n\n`;
    }
    text += `<b>${result.newInstincts.length} Instincts Baru:</b>\n`;
    result.newInstincts.forEach((inst, i) => {
      text += `${i + 1}. [${(inst.confidence * 100).toFixed(0)}%] ${escapeHTML(inst.pattern)}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/learn(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const poolArg = match[1]?.trim();
  bot.sendMessage(chatId, '📚 Mempelajari top LPers...');
  try {
    if (poolArg) {
      const lessons = await learnFromPool(poolArg);
      bot.sendMessage(chatId,
        `✅ <b>${lessons.length} lessons baru:</b>\n\n` + lessons.map((l, i) => `${i + 1}. ${escapeHTML(l.lesson)}`).join('\n\n'),
        { parse_mode: 'HTML' }
      );
    } else {
      const candidates = getCandidates();
      if (!candidates.length) { bot.sendMessage(chatId, '⚠️ Jalankan /hunt dulu.'); return; }
      const { lessons, errors } = await learnFromMultiplePools(candidates.slice(0, 3).map(c => c.address));
      let text = `✅ <b>${lessons.length} lessons dari ${Math.min(3, candidates.length)} pool:</b>\n\n`;
      text += lessons.slice(0, 6).map((l, i) => `${i + 1}. ${escapeHTML(l.lesson)}`).join('\n\n');
      if (errors.length) text += `\n\n⚠️ ${errors.length} pool gagal`;
      bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }
  } catch (e) { bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }); }
});

bot.onText(/\/lessons/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  sendLong(msg.chat.id, formatLessonsList(), { parse_mode: 'HTML' }).catch(() => { });
});

// /pinlesson <index> — pin lesson ke tier 1 (selalu masuk prompt)
bot.onText(/\/pinlesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null; // 1-based dari user
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: <code>/pinlesson &lt;nomor&gt;</code> (lihat nomor di /lessons)', { parse_mode: 'HTML' });
    return;
  }
  const result = pinLesson(idx);
  if (!result.ok) {
    bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(result.reason)}</code>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `📌 <b>Lesson di-pin!</b>\n\n<i>"${escapeHTML(result.lesson)}"</i>\n\nLesson ini akan selalu masuk ke prompt agent.`, { parse_mode: 'HTML' });
  }
});

// /unpinlesson <index>
bot.onText(/\/unpinlesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null;
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: <code>/unpinlesson &lt;nomor&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const result = unpinLesson(idx);
  bot.sendMessage(msg.chat.id, result.ok ? '✅ <b>Lesson di-unpin.</b>' : `❌ <code>${escapeHTML(result.reason)}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/deletelesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null;
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: <code>/deletelesson &lt;nomor&gt;</code> (lihat nomor di /lessons)', { parse_mode: 'HTML' });
    return;
  }
  const result = deleteLesson(idx);
  if (result.ok) {
    bot.sendMessage(msg.chat.id, `✅ Lesson dihapus: <i>${escapeHTML(result.lesson)}</i>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ <code>${escapeHTML(result.reason)}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/clearlessons/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const result = clearAllLessons();
  bot.sendMessage(msg.chat.id, result.ok ? '🗑️ <b>Semua lessons telah dihapus.</b>' : `❌ <code>${escapeHTML(result.reason || 'Gagal menghapus lessons.')}</code>`, { parse_mode: 'HTML' });
});


bot.onText(/\/safety/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const s = getSafetyStatus();
  let text = `🛡️ <b>Safety Status</b>\n\n`;
  text += `${s.frozen ? '⛔ <b>FROZEN</b>' : '✅ <b>Active</b>'}\n`;
  text += `Daily PnL: $${s.dailyPnlUsd} | Drawdown: ${s.drawdownPct}%\n`;
  text += `Stop-loss: ${s.stopLossPct}% | Max drawdown: ${s.maxDailyDrawdownPct}%\n`;
  text += `Confirm before deploy: ${s.requireConfirmation ? 'Ya' : 'Tidak'}\n`;
  text += `Pending confirmations: ${s.pendingConfirmations}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});


bot.onText(/\/(strategies|addstrategy|deletestrategy)(.*)/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  handleStrategyCommand(bot, msg, ALLOWED_ID);
});

// ─── Smart Wallet commands ────────────────────────────────────────

// /addwallet <address> <label>
bot.onText(/\/addwallet(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const address = match[1]?.trim();
  const label = match[2]?.trim() || 'unknown';
  if (!address) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: <code>/addwallet &lt;address&gt; &lt;label&gt;</code>\nContoh: <code>/addwallet 7xKd...1bAz alpha_lp_1</code>', { parse_mode: 'HTML' });
    return;
  }
  const { ok, reason } = addSmartWallet(address, label);
  bot.sendMessage(msg.chat.id,
    ok ? `✅ <b>Smart wallet ditambahkan!</b>\n<code>${escapeHTML(address.slice(0, 16))}...</code> — ${escapeHTML(label)}` : `❌ <code>${escapeHTML(reason)}</code>`,
    { parse_mode: 'HTML' }
  );
});

// /removewallet <address>
bot.onText(/\/removewallet(?:\s+(\S+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const address = match[1]?.trim();
  if (!address) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: <code>/removewallet &lt;address&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const { ok, reason } = removeSmartWallet(address);
  bot.sendMessage(msg.chat.id, ok ? '✅ <b>Wallet dihapus dari list.</b>' : `❌ <code>${escapeHTML(reason)}</code>`, { parse_mode: 'HTML' });
});

// /listwallet
bot.onText(/\/listwallet/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  sendLong(msg.chat.id, formatWalletList(), { parse_mode: 'HTML' }).catch(() => { });
});

// ─── Pool Memory command ──────────────────────────────────────────

// /poolmemory — tampilkan top/worst pools berdasarkan riwayat deploy
bot.onText(/\/poolmemory/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  sendLong(msg.chat.id, formatPoolMemoryReport(), { parse_mode: 'HTML' }).catch(() => { });
});

// /dryrun on|off — toggle dry run mode
bot.onText(/\/dryrun(?:\s+(on|off))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();
  if (!toggle) {
    const current = getConfig().dryRun;
    bot.sendMessage(chatId,
      `🟡 <b>Dry Run Mode</b>: ${current ? 'ON' : 'OFF'}\n\nGunakan <code>/dryrun on</code> atau <code>/dryrun off</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  const enable = toggle === 'on';
  updateConfig({ dryRun: enable });
  bot.sendMessage(chatId,
    `${enable ? '🟡' : '🔴'} <b>Dry Run</b>: ${enable ? 'ON — TX tidak akan dieksekusi' : 'OFF — Mode LIVE aktif'}\n\n` +
    (enable ? '<i>Semua open/close/claim/swap akan disimulasikan saja.</i>' : '<i>Trading berjalan normal.</i>'),
    { parse_mode: 'HTML' }
  );
});

// /pause — pause loop otonom (watchdog/healer/hunter auto)
bot.onText(/\/pause$/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const before = getConfig();
  const next = updateConfig({ autonomyMode: 'paused' });
  bot.sendMessage(msg.chat.id,
    `⏸️ <b>Autonomy Paused</b>\n\n` +
    `autonomyMode: <code>${next.autonomyMode}</code>\n` +
    `autoScreeningEnabled: <code>${next.autoScreeningEnabled}</code>\n\n` +
    `<i>Loop otonom dihentikan sementara. Command manual (/hunt, /heal, /zap) tetap bisa dipakai.</i>`,
    { parse_mode: 'HTML' }
  );
  if (before.autonomyMode !== next.autonomyMode) {
    notify('⏸️ Autonomy mode dipause via command /pause.').catch(() => { });
  }
});

// /resume — lanjutkan loop otonom
bot.onText(/\/resume$/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const before = getConfig();
  const next = updateConfig({ autonomyMode: 'active' });
  bot.sendMessage(msg.chat.id,
    `▶️ <b>Autonomy Resumed</b>\n\n` +
    `autonomyMode: <code>${next.autonomyMode}</code>\n` +
    `autoScreeningEnabled: <code>${next.autoScreeningEnabled}</code>`,
    { parse_mode: 'HTML' }
  );
  if (before.autonomyMode !== next.autonomyMode) {
    notify('▶️ Autonomy mode diaktifkan lagi via command /resume.').catch(() => { });
  }
});

// /claim <positionAddress> — manual fee claim untuk posisi tertentu
bot.onText(/\/claim(?:\s+(\S+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const positionAddress = match[1]?.trim();
  if (!positionAddress) {
    bot.sendMessage(chatId, `ℹ️ Gunakan: <code>/claim &lt;position_address&gt;</code>`, { parse_mode: 'HTML' });
    return;
  }

  const openPos = getOpenPositions();
  const pos = openPos.find(p => p.position_address === positionAddress);
  if (!pos) {
    bot.sendMessage(chatId, `❌ Posisi <code>${escapeHTML(positionAddress)}</code> tidak ditemukan di open positions.`, { parse_mode: 'HTML' });
    return;
  }

  bot.sendMessage(chatId, `💸 Claiming fees untuk <code>${escapeHTML(positionAddress.slice(0, 8))}...</code>`, { parse_mode: 'HTML' }).catch(() => { });
  try {
    await claimFees(pos.pool_address, pos.position_address);
    bot.sendMessage(chatId,
      `✅ <b>Claim berhasil</b>\n\n` +
      `Position: <code>${escapeHTML(pos.position_address)}</code>\n` +
      `Pool: <code>${escapeHTML(pos.pool_address)}</code>\n\n` +
      `<i>Tip: jalankan /status untuk lihat update fee/PnL terbaru.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Claim gagal: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  }
});

// /claim_fees <positionAddress> — alias for /claim (ergonomic Telegram shorthand)
bot.onText(/\/claim_fees(?:\s+(\S+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const positionAddress = match[1]?.trim();
  if (!positionAddress) {
    bot.sendMessage(chatId, `ℹ️ Gunakan: <code>/claim_fees &lt;position_address&gt;</code>`, { parse_mode: 'HTML' });
    return;
  }

  const openPos = getOpenPositions();
  const pos = openPos.find(p => p.position_address === positionAddress);
  if (!pos) {
    bot.sendMessage(chatId, `❌ Posisi <code>${escapeHTML(positionAddress)}</code> tidak ditemukan di open positions.`, { parse_mode: 'HTML' });
    return;
  }

  bot.sendMessage(chatId, `💸 Claiming fees untuk <code>${escapeHTML(positionAddress.slice(0, 8))}...</code>`, { parse_mode: 'HTML' }).catch(() => { });
  try {
    await claimFees(pos.pool_address, pos.position_address);
    bot.sendMessage(chatId,
      `✅ <b>Claim berhasil</b>\n\n` +
      `Position: <code>${escapeHTML(pos.position_address)}</code>\n` +
      `Pool: <code>${escapeHTML(pos.pool_address)}</code>\n\n` +
      `<i>Tip: jalankan /status untuk lihat update fee/PnL terbaru.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Claim gagal: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  }
});

// /rollback or /safemode — harden runtime before intervention/deploy
bot.onText(/\/(?:rollback|safemode)/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const before = getConfig();
  const next = updateConfig({
    dryRun: true,
    autoScreeningEnabled: false,
    deploymentStage: 'shadow',
    autonomyMode: 'paused',
  });
  const changed = [];
  if (before.dryRun !== next.dryRun) changed.push(`dryRun: ${before.dryRun} → ${next.dryRun}`);
  if (before.autoScreeningEnabled !== next.autoScreeningEnabled) changed.push(`autoScreeningEnabled: ${before.autoScreeningEnabled} → ${next.autoScreeningEnabled}`);
  if (String(before.deploymentStage) !== String(next.deploymentStage)) changed.push(`deploymentStage: ${before.deploymentStage} → ${next.deploymentStage}`);
  if (String(before.autonomyMode) !== String(next.autonomyMode)) changed.push(`autonomyMode: ${before.autonomyMode} → ${next.autonomyMode}`);

  bot.sendMessage(chatId,
    `🛑 <b>Safe Rollback Aktif</b>\n\n` +
    `Mode aman diterapkan:\n` +
    `• dryRun = <code>${next.dryRun}</code>\n` +
    `• autoScreeningEnabled = <code>${next.autoScreeningEnabled}</code>\n` +
    `• deploymentStage = <code>${next.deploymentStage}</code>\n` +
    `• autonomyMode = <code>${next.autonomyMode}</code>\n\n` +
    (changed.length ? `<i>Perubahan: ${escapeHTML(changed.join(' | '))}</i>` : '<i>Nilai sudah dalam mode aman sejak awal.</i>'),
    { parse_mode: 'HTML' }
  );
});

// /autoscreen on|off [interval] — toggle auto-screening (alias: /autohunter)
bot.onText(/\/(?:autoscreen|autohunter)(?:\s+(on|off))?(?:\s+(\d+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();
  const intervalArg = match[2];

  if (!toggle) {
    const current = getConfig().autoScreeningEnabled;
    bot.sendMessage(chatId,
      `🤖 <b>Auto-Screening</b>: ${current ? '✅ ON' : '❌ OFF'}\n\n` +
      `Gunakan <code>/autoscreen on [interval]</code> atau <code>/autoscreen off</code> untuk toggle.\n` +
      `Interval screening: ${getConfig().screeningIntervalMin} menit\n` +
      `Stage: <code>${getConfig().deploymentStage}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const enable = toggle === 'on';
  if (enable) {
    const snap = getDeployReadinessSnapshot();
    if (!snap.readiness.ready) {
      const blockerText = snap.readiness.blockers.join(' | ');
      bot.sendMessage(chatId,
        `⛔ <b>Auto-screening ditolak</b>\n\n` +
        `Sistem belum ready untuk entry live.\n` +
        `Blockers: <code>${escapeHTML(blockerText)}</code>\n\n` +
        `<i>Jalankan /preflight untuk detail dan action items.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  }
  const updates = { autoScreeningEnabled: enable };

  if (enable && intervalArg) {
    const val = parseInt(intervalArg);
    if (val >= 5 && val <= 1440) {
      updates.screeningIntervalMin = val;
    }
  }

  updateConfig(updates);

  if (enable) {
    bot.sendMessage(chatId,
      `🤖 <b>Auto-Screening</b>: ✅ Diaktifkan\n` +
      `Interval: ${getConfig().screeningIntervalMin} menit\n\n` +
      `⏳ <i>Bot akan mengikuti jadwal interval yang sudah ditentukan.</i>`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(chatId, `🤖 <b>Auto-Screening</b>: ❌ Dimatikan. Hunter tidak akan auto-deploy.`, { parse_mode: 'HTML' });
  }
});

// /stage [shadow|canary|full] [canaryMax] [force] — runtime deployment stage gate
bot.onText(/\/stage(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const rawArgs = match[1]?.trim();
  const cfgNow = getConfig();

  if (!rawArgs) {
    const guard = summarizeEntryGuard();
    const reasonText = guard.reasons.length ? guard.reasons.join(' | ') : 'none';
    bot.sendMessage(chatId,
      `🧭 <b>Deployment Stage</b>\n\n` +
      `Stage: <code>${cfgNow.deploymentStage}</code>\n` +
      `Canary Max Positions: <code>${cfgNow.canaryMaxPositions}</code>\n` +
      `Effective Max (stage): <code>${guard.stageMaxPositions}</code>\n` +
      `Entry Guard: <code>${guard.entryAllowed ? 'OPEN' : 'BLOCKED'}</code>\n` +
      `Reasons: <code>${escapeHTML(reasonText)}</code>\n\n` +
      `<i>Ubah: /stage shadow|canary|full [canaryMax] [force]</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  const requestedStage = tokens[0]?.toLowerCase();
  const canaryArgToken = tokens.find(t => /^\d+$/.test(t));
  const canaryArg = canaryArgToken ? parseInt(canaryArgToken, 10) : null;
  const force = tokens.some(t => t.toLowerCase() === 'force' || t === '--force');
  const allowedStages = ['shadow', 'canary', 'full'];
  if (!allowedStages.includes(requestedStage)) {
    bot.sendMessage(chatId, `❌ Stage tidak valid. Gunakan: <code>/stage shadow|canary|full [canaryMax] [force]</code>`, { parse_mode: 'HTML' });
    return;
  }

  if (requestedStage === 'full' && !force) {
    const snap = getDeployReadinessSnapshot();
    const readinessForFull = evaluateDeployReadiness({
      ...snap.readiness,
      solanaReady,
      circuitState: snap.cbState.state,
      pendingReconcile: snap.guard.pendingReconcile,
      manualReviewOpen: snap.guard.manualReviewOpen,
      manualReviewThreshold: snap.cfgNow.manualReviewPauseThreshold || 1,
      autoPauseOnManualReview: snap.cfgNow.autoPauseOnManualReview !== false,
      failedOps6h: snap.failedOps.length,
      deploymentStage: snap.cfgNow.deploymentStage,
      targetStage: 'full',
      dryRun: snap.cfgNow.dryRun,
      autoScreeningEnabled: snap.cfgNow.autoScreeningEnabled,
      autonomyMode: snap.cfgNow.autonomyMode,
      taeExitCount: snap.taeExitCount,
      taeWinRatePct: snap.taeWinRatePct,
      minTaeSamplesForFullStage: snap.cfgNow.minTaeSamplesForFullStage,
      minTaeWinRateForFullStage: snap.cfgNow.minTaeWinRateForFullStage,
      signalReportRequired: snap.cfgNow.requireSignalReportForLive !== false,
      signalReportAvailable: snap.signalReport.available,
      signalReportPassed: snap.signalReport.passed,
      signalReportAgeHours: snap.signalReport.ageHours,
      signalReportMaxAgeHours: snap.cfgNow.signalReportMaxAgeHours,
    });
    if (!readinessForFull.ready) {
      const blockerText = readinessForFull.blockers.join(' | ');
      bot.sendMessage(chatId,
        `⛔ <b>Stage FULL ditolak</b>\n\n` +
        `System readiness belum lolos.\n` +
        `Blockers: <code>${escapeHTML(blockerText)}</code>\n\n` +
        `<i>Perbaiki dulu atau override sadar risiko: /stage full force</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  }

  const updates = { deploymentStage: requestedStage };
  if (requestedStage === 'canary' && Number.isFinite(canaryArg) && canaryArg >= 1) {
    updates.canaryMaxPositions = canaryArg;
  }
  const next = updateConfig(updates);
  const guard = summarizeEntryGuard();
  bot.sendMessage(chatId,
    `✅ <b>Stage diperbarui</b>\n\n` +
    `deploymentStage: <code>${next.deploymentStage}</code>\n` +
    `canaryMaxPositions: <code>${next.canaryMaxPositions}</code>\n` +
    `effectiveMax: <code>${guard.stageMaxPositions}</code>\n` +
    `entryGuard: <code>${guard.entryAllowed ? 'OPEN' : 'BLOCKED'}</code>`,
    { parse_mode: 'HTML' }
  );
});

// /preflight — readiness gate sebelum deploy live
bot.onText(/\/preflight/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const snap = getDeployReadinessSnapshot();
    const { readiness, cfgNow, guard, cbState, taeExitCount, taeWinRatePct, worktree, signalReport } = snap;
    const blockersText = readiness.blockers.length ? readiness.blockers.join('\n') : 'none';
    const warningsText = readiness.warnings.length ? readiness.warnings.join('\n') : 'none';
    const status = readiness.ready ? '✅ READY' : '⛔ BLOCKED';
    const worktreeLabel = worktree.available
      ? `${worktree.clean ? 'CLEAN' : `DIRTY (${worktree.dirtyCount})`}`
      : 'UNKNOWN';
    const worktreeSample = (worktree.sample || []).length
      ? `\nDirty Sample:\n${worktree.sample.join('\n')}`
      : '';
    const worktreeError = worktree.error ? `\nCheck Error: ${worktree.error}` : '';

    const text = [
      `🧪 <b>Preflight Check</b>`,
      ``,
      `Status: <code>${status}</code>`,
      `Readiness Score: <code>${readiness.score}/100</code>`,
      `Stage: <code>${cfgNow.deploymentStage}</code>`,
      `Autonomy Mode: <code>${cfgNow.autonomyMode}</code>`,
      `Circuit Breaker: <code>${cbState.state}</code>`,
      `Pending Reconcile: <code>${guard.pendingReconcile}</code>`,
      `Manual Review Open: <code>${guard.manualReviewOpen}</code>`,
      `Worktree: <code>${worktreeLabel}</code>`,
      `Signal Report: <code>${signalReport.available ? (signalReport.passed ? 'PASS' : 'FAIL') : 'MISSING'}</code>`,
      `Signal Age: <code>${Number.isFinite(signalReport.ageHours) ? `${signalReport.ageHours.toFixed(1)}h` : 'N/A'}</code>`,
      `TAE Samples: <code>${taeExitCount}</code>`,
      `TAE Win Rate: <code>${Number.isFinite(taeWinRatePct) ? `${taeWinRatePct.toFixed(1)}%` : 'N/A'}</code>`,
      ``,
      `<b>Blockers</b>`,
      `<pre><code>${escapeHTML(blockersText)}</code></pre>`,
      `<b>Warnings</b>`,
      `<pre><code>${escapeHTML(warningsText)}</code></pre>`,
      `<b>Worktree Detail</b>`,
      `<pre><code>${escapeHTML(`${worktreeLabel}${worktreeSample}${worktreeError}`)}</code></pre>`,
      `<i>Tip: gunakan /health untuk incident detail, /rollback untuk safe-mode cepat.</i>`,
    ].join('\n');
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  }
});

// ─── Signal Weights command ───────────────────────────────────────

// /setconfig [key] [value] — baca atau ubah config tanpa restart
bot.onText(/\/setconfig(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const key = match[1]?.trim();
  const rawVal = match[2]?.trim();

  const cfg = getConfig();

  // Tanpa argumen → tampilkan config yang bisa diubah
  if (!key) {
    const lines = [
      `deployAmountSol          = ${cfg.deployAmountSol}`,
      `maxPositions             = ${cfg.maxPositions}`,
      `managementIntervalMin    = ${cfg.managementIntervalMin}`,
      `screeningIntervalMin     = ${cfg.screeningIntervalMin}`,
      `positionUpdateIntervalMin= ${cfg.positionUpdateIntervalMin}`,
      `takeProfitFeePct         = ${cfg.takeProfitFeePct}`,
      `trailingTriggerPct       = ${cfg.trailingTriggerPct}`,
      `trailingDropPct          = ${cfg.trailingDropPct}`,
      `stopLossPct              = ${cfg.stopLossPct}`,
      `outOfRangeWaitMinutes    = ${cfg.outOfRangeWaitMinutes}`,
      `minOrganic               = ${cfg.minOrganic}`,
      `minMcap                  = ${cfg.minMcap}`,
      `minVolume24h             = ${cfg.minVolume24h}`,
      `dexSeedSampleLimit       = ${cfg.dexSeedSampleLimit}`,
      `dexMinAgeHours           = ${cfg.dexMinAgeHours}`,
      `dexMaxAgeHours           = ${cfg.dexMaxAgeHours}`,
      `dexRequireKnownAge       = ${cfg.dexRequireKnownAge}`,
      `minTokenFeesSol          = ${cfg.minTokenFeesSol}`,
      `minTotalFeesSol          = ${cfg.minTotalFeesSol}`,
      `gmgnMinTotalFeesSol      = ${cfg.gmgnMinTotalFeesSol}`,
      `gmgnFailClosedCritical   = ${cfg.gmgnFailClosedCritical}`,
      `heritageModeEnabled      = ${cfg.heritageModeEnabled}`,
      `activePreset             = ${cfg.activePreset}`,
      `deploymentStage          = ${cfg.deploymentStage}`,
      `canaryMaxPositions       = ${cfg.canaryMaxPositions}`,
      `autoPauseOnManualReview  = ${cfg.autoPauseOnManualReview}`,
      `manualReviewPauseThreshold= ${cfg.manualReviewPauseThreshold}`,
      `autonomyMode            = ${cfg.autonomyMode}`,
      `autoScreeningEnabled     = ${cfg.autoScreeningEnabled}`,
      `dryRun                   = ${cfg.dryRun}`,
      `failSafeModeOnDataUnreliable= ${cfg.failSafeModeOnDataUnreliable}`,
      `minPriceSourcesForEntry  = ${cfg.minPriceSourcesForEntry}`,
      `oracleMaxPriceDivergencePct= ${cfg.oracleMaxPriceDivergencePct}`,
      `minTaeSamplesForFullStage= ${cfg.minTaeSamplesForFullStage}`,
      `minTaeWinRateForFullStage= ${cfg.minTaeWinRateForFullStage}`,
      `signalAutoRefreshEnabled = ${cfg.signalAutoRefreshEnabled}`,
      `signalAutoRefreshIntervalMin= ${cfg.signalAutoRefreshIntervalMin}`,
      `signalAutoRefreshFailureLimit= ${cfg.signalAutoRefreshFailureLimit}`,
      `signalConservativeMaxPositions= ${cfg.signalConservativeMaxPositions}`,
      `signalAutoRefreshInputs  = ${cfg.signalAutoRefreshInputs}`,
    ];
    return bot.sendMessage(chatId,
      `⚙️ <b>Config Saat Ini</b>\n\n<pre><code>${lines.join('\n')}</code></pre>\n\n<i>Ubah: <code>/setconfig key value</code></i>`,
      { parse_mode: 'HTML' }
    );
  }

  // Parse nilai
  if (!isConfigKeySupported(key)) {
    return bot.sendMessage(chatId,
      `❌ Key <code>${key}</code> tidak dikenal atau tidak bisa diubah.`,
      { parse_mode: 'HTML' }
    );
  }

  let parsed;
  if (rawVal === 'true') parsed = true;
  else if (rawVal === 'false') parsed = false;
  else if (!isNaN(rawVal)) parsed = parseFloat(rawVal);
  else parsed = rawVal;

  const result = updateConfig({ [key]: parsed });

  // Cek apakah key di-reject (tidak ada di result atau value tidak berubah)
  const saved = result[key];
  if (saved === undefined) {
    return bot.sendMessage(chatId,
      `❌ Key <code>${key}</code> tidak dikenal atau di luar batas yang diizinkan.`,
      { parse_mode: 'HTML' }
    );
  }

  bot.sendMessage(chatId,
    `✅ <b>Config diperbarui</b>\n\n<code>${key}</code> → <code>${saved}</code>\n\n<i>Berlaku segera, tidak perlu restart.</i>`,
    { parse_mode: 'HTML' }
  );
});

// /override_range [pct] [strategyName] — override price range strategy aktif
bot.onText(/\/override_range(?:\s+([0-9]*\.?[0-9]+))?(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const cfg = getConfig();
  const pctRaw = match[1];
  const strategyName = (match[2] || cfg.activeStrategy || 'Evil Panda').trim();
  const currentRange = cfg.strategyOverrides?.[strategyName]?.deploy?.priceRangePct;

  if (!pctRaw) {
    bot.sendMessage(chatId,
      `🎛️ <b>Override Range</b>\n\n` +
      `Strategy: <code>${escapeHTML(strategyName)}</code>\n` +
      `Current override: <code>${Number.isFinite(Number(currentRange)) ? `${Number(currentRange)}%` : 'not set'}</code>\n\n` +
      `<i>Set baru: /override_range &lt;persen&gt; [strategyName]</i>\n` +
      `<i>Contoh: /override_range 90 Evil Panda</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const pct = Number(pctRaw);
  if (!Number.isFinite(pct) || pct < 1 || pct > 95) {
    bot.sendMessage(chatId, `❌ Range tidak valid. Gunakan angka <code>1</code> sampai <code>95</code>.`, { parse_mode: 'HTML' });
    return;
  }

  const next = updateConfig({
    strategyOverrides: {
      [strategyName]: {
        deploy: {
          priceRangePct: pct,
        },
      },
    },
  });
  const saved = next.strategyOverrides?.[strategyName]?.deploy?.priceRangePct;
  bot.sendMessage(chatId,
    `✅ <b>Range override disimpan</b>\n\n` +
    `Strategy: <code>${escapeHTML(strategyName)}</code>\n` +
    `priceRangePct: <code>${saved}%</code>\n\n` +
    `<i>Berlaku di entry berikutnya.</i>`,
    { parse_mode: 'HTML' }
  );
});

function formatRadarReportTelegram(snapshot) {
  if (!snapshot) {
    return '⚠️ Radar belum tersedia. Jalankan <code>/hunting</code> dulu.';
  }
  const pf = snapshot.prefilter || {};
  const st = snapshot.stats || {};
  const rows = (snapshot.candidates || []).slice(0, 12).map((c, idx) => {
    const name = escapeHTML(String(c.name || c.address || 'TOKEN'));
    const mcap = safeNum(c.mcap).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const vol = safeNum(c.vol24h).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const age = Number.isFinite(c.ageHours) ? `${Number(c.ageHours).toFixed(1)}h` : 'n/a';
    const tag = c.isMatched ? 'MATCH' : 'VETO';
    const reason = c.isMatched ? 'ready' : escapeHTML(String(c.vetoReason || 'veto'));
    return `${idx + 1}. <b>${name}</b> | MCAP $${mcap} | VOL $${vol} | AGE ${age} | ${tag}\n   <code>${reason.slice(0, 160)}</code>`;
  });

  return [
    '🛰️ <b>Radar Report (Telegram Only)</b>',
    `<code>Updated:</code> ${escapeHTML(String(snapshot.timestamp || '-'))}`,
    '',
    `<b>Dex Prefilter</b>`,
    `<code>Seeded:</code> ${safeNum(pf.seeded)}`,
    `<code>Pass:</code> ${safeNum(pf.pass)} | <code>Rejected:</code> ${safeNum(pf.rejected)} | <code>Screened:</code> ${safeNum(pf.screened)}`,
    `<code>Rules:</code> mcap>=${safeNum(pf.minMcap).toLocaleString()} | vol24h>=${safeNum(pf.minVolume24h).toLocaleString()}`,
    '',
    `<b>Pipeline Stats</b>`,
    `<code>Radar Total:</code> ${safeNum(st.radarTotal)} | <code>Matched:</code> ${safeNum(st.matchedCount)} | <code>Exec Pools:</code> ${safeNum(st.executablePoolsCount)}`,
    `<code>Rejected:</code> DexPre ${safeNum(st.rejectedDexPrefilter)} | Security ${safeNum(st.rejectedSecurity)} | NoPool ${safeNum(st.rejectedNoPool)} | Cooldown ${safeNum(st.rejectedCooldown)}`,
    '',
    '<b>Top Candidates</b>',
    rows.length ? rows.join('\n') : '<i>Tidak ada kandidat pass di snapshot terakhir.</i>',
  ].join('\n');
}

// /radar_report — kirim laporan radar penuh via Telegram text.
bot.onText(/\/radar_report/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const snapshot = getLastRadarSnapshot();
  const report = formatRadarReportTelegram(snapshot);
  await sendLong(chatId, report, { parse_mode: 'HTML' }).catch(() => {
    bot.sendMessage(chatId, report, { parse_mode: 'HTML' }).catch(() => {});
  });
});

// NOTE:
// Handler /hunt sudah didefinisikan di atas.
// Jangan daftarkan ulang command yang sama karena bisa memicu double execution.

// /weights — tampilkan/recalibrate bobot Darwinian

// /providers — tampilkan status RPC, candle providers, dan circuit breaker
bot.onText(/\/providers/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  try {
    const rpcMetrics = getRpcMetrics();
    const candleMetrics = candleManager?.getMetrics() || { error: 'Candle manager not initialized' };
    const cbState = circuitBreaker.getState();

    let report = '📡 <b>API Provider &amp; Safety Status</b>\n\n';

    // Circuit Breaker status
    const cbStatusIcon = cbState.state === 'CLOSED' ? '✅' : '⛔';
    const cbTimeOpen = cbState.timeOpenMs > 0 ? ` (open ${(cbState.timeOpenMs / 1000 / 60).toFixed(1)}m)` : '';
    report += `🔌 <b>Circuit Breaker</b>\n${cbStatusIcon} ${cbState.state}${cbTimeOpen}\n`;
    if (cbState.tripReason) {
      report += `Reason: ${cbState.tripReason}\n`;
    }
    report += `Errors: ${cbState.errorCount}, Latencies: ${cbState.latencyCount}\n\n`;

    if (rpcMetrics.providers) {
      report += '🔗 <b>RPC Providers</b>\n';
      rpcMetrics.providers.forEach(p => {
        const status = p.healthy ? '✅' : '❌';
        report += `${status} ${p.name}: errors=${p.errors}, last="${p.lastError || 'OK'}"\n`;
      });
      report += `Cache size: ${rpcMetrics.cacheSize} entries\n\n`;
    } else if (rpcMetrics.error) {
      report += `⚠️ RPC: ${rpcMetrics.error}\n\n`;
    }

    if (candleMetrics.providers) {
      report += '📊 <b>Candle Providers</b>\n';
      candleMetrics.providers.forEach(p => {
        const status = p.healthy ? '✅' : '❌';
        report += `${status} ${p.name}: errors=${p.errors}, last="${p.lastError || 'OK'}"\n`;
      });
    }

    sendLong(msg.chat.id, report, { parse_mode: 'HTML' }).catch(() => { });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  }
});

// /health — ringkasan readiness deploy + incident signal
bot.onText(/\/health/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const { cfgNow, cbState, guard, readiness, taeExitCount, taeWinRatePct } = getDeployReadinessSnapshot();
    const pending = listPendingReconcileIssues(50);
    const failedOps = listRecentFailedOperations(6, 10);

    const cbStatus = cbState.state === 'CLOSED' ? '✅ CLOSED' : `⛔ ${cbState.state}`;
    const reasons = guard.reasons.length ? guard.reasons.join(' | ') : 'none';
    const failLines = failedOps.length === 0
      ? 'none'
      : failedOps
        .slice(0, 5)
        .map(op => {
          const t = new Date(op.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(',', '');
          const action = op.action || op.operation_type || 'unknown';
          return `${t} | ${action}`;
        })
        .join('\n');

    const report = [
      '🩺 <b>System Health</b>',
      '',
      `<b>Gate & Stage</b>`,
      `• readiness: <code>${readiness.ready ? 'READY' : 'BLOCKED'} (${readiness.score}/100)</code>`,
      `• deploymentStage: <code>${cfgNow.deploymentStage}</code>`,
      `• canaryMaxPositions: <code>${cfgNow.canaryMaxPositions}</code>`,
      `• effectiveMax: <code>${guard.stageMaxPositions}</code>`,
      `• entryGuard: <code>${guard.entryAllowed ? 'OPEN' : 'BLOCKED'}</code>`,
      `• guardReasons: <code>${escapeHTML(reasons)}</code>`,
      '',
      `<b>Runtime Safety</b>`,
      `• circuitBreaker: <code>${cbStatus}</code>`,
      `• dryRun: <code>${cfgNow.dryRun}</code>`,
      `• autonomyMode: <code>${cfgNow.autonomyMode}</code>`,
      `• autoScreening: <code>${cfgNow.autoScreeningEnabled}</code>`,
      `• pendingReconcile: <code>${pending.length}</code>`,
      `• manualReviewOpen: <code>${guard.manualReviewOpen}</code>`,
      `• taeSamples: <code>${taeExitCount}</code>`,
      `• taeWinRate: <code>${Number.isFinite(taeWinRatePct) ? `${taeWinRatePct.toFixed(1)}%` : 'N/A'}</code>`,
      '',
      `<b>Recent Failed Ops (6h)</b>`,
      `<pre><code>${escapeHTML(failLines)}</code></pre>`,
    ].join('\n');

    await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  }
});

// ─── Message handler ─────────────────────────────────────────────

let _chatBusy = false;

bot.on('message', async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;


  if (handleConfirmationReply(msg.text)) return;

  if (researchSessions.has(msg.from.id)) {
    researchSessions.delete(msg.from.id);
    await processResearchArticle(msg.chat.id, msg.text);
    return;
  }

  if (isInStrategySession(msg.from.id)) {
    handleStrategyCommand(bot, msg, ALLOWED_ID);
    return;
  }

  // Cegah double-request saat AI masih berpikir
  if (_chatBusy) {
    bot.sendMessage(msg.chat.id, '⏳ Masih memproses pesan sebelumnya...').catch(() => { });
    return;
  }

  await handleMessage(msg, msg.text);
});

async function handleMessage(msg, text) {
  _chatBusy = true;
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => { });
  try {
    const response = await processMessage(text);
    await sendLong(msg.chat.id, escapeHTML(response), { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: <code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
  } finally {
    _chatBusy = false;
  }
}

let _pollingRestartCount = 0;
const MAX_POLLING_RESTARTS = 10;

bot.on('polling_error', (e) => {
  const isTimeout = e.message?.includes('ETIMEDOUT') || e.message?.includes('timeout');

  // Jika hanya timeout biasa, jangan penuhi log dengan warning kecuali EFATAL
  if (isTimeout && !e.message?.includes('EFATAL')) {
    return; // Abaikan timeout transien
  }

  console.error('Polling error:', e.message);

  if (e.code === 'EFATAL' || e.message?.includes('EFATAL')) {
    if (_pollingRestartCount >= MAX_POLLING_RESTARTS) {
      console.error(`❌ Polling restart limit (${MAX_POLLING_RESTARTS}x) tercapai.`);
      return;
    }

    _pollingRestartCount++;
    const delay = Math.min(10000 * _pollingRestartCount, 60000);
    console.warn(`⚠️ Koneksi terputus (EFATAL) — mencoba pulihkan dalam ${delay / 1000}s... (${_pollingRestartCount}/${MAX_POLLING_RESTARTS})`);

    setTimeout(async () => {
      try {
        await bot.stopPolling().catch(() => { });
        await new Promise(r => setTimeout(r, 2000));
        await bot.startPolling();
        console.log('✅ Koneksi Telegram berhasil dipulihkan.');
        _pollingRestartCount = 0;
      } catch (err) {
        console.error('❌ Pemulihan koneksi gagal:', err.message);
      }
    }, delay);
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down...`);
  try {
    const openPos = getOpenPositions();
    console.log(`📍 Open positions at shutdown: ${openPos.length}`);
    // Notify Telegram before stopping polling so the message can be delivered
    if (openPos.length > 0) {
      const posLines = openPos.map(p => `• <code>${p.position_address.slice(0, 8)}</code> @ ${p.pool_address.slice(0, 8)}`).join('\n');
      await notify(`⚠️ <b>Bot Shutting Down (${signal})</b>\n\n${openPos.length} posisi masih terbuka:\n${posLines}\n\n<i>Posisi TIDAK ditutup otomatis — monitor secara manual.</i>`).catch(() => {});
    } else {
      await notify(`🛑 <b>Bot Shutdown (${signal})</b>\n\nTidak ada posisi terbuka.`).catch(() => {});
    }
    circuitBreaker.destroy();
    bot.stopPolling();
  } catch { }
  // Give Telegram a moment to flush the message
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tangkap uncaught exceptions supaya bot tidak mati tiba-tiba
process.on('uncaughtException', (e) => {
  console.error('❌ Uncaught Exception:', e.message, e.stack);
  notify(`⚠️ <b>Uncaught error (bot tetap jalan):</b>\n<code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('❌ Unhandled Rejection:', msg);
  notify(`⚠️ <b>Unhandled promise rejection:</b>\n<code>${escapeHTML(msg)}</code>`, { parse_mode: 'HTML' }).catch(() => { });
});

// ─── Startup ─────────────────────────────────────────────────────

setTimeout(async () => {
  try {
    // Initialize model discovery to discover all available models from configured providers
    console.log('🔍 Initializing model discovery...');
    await initializeModelDiscovery();

    const balance = await getWalletBalance();
    const today = getTodayResults();
    const dailyPnl = today.totalPnlUsd + today.totalFeesUsd;
    const cbStatus = dailyPnl < -cfg.dailyLossLimitUsd ? '🛑 LOCKED (Loss Limit)' : '✅ READY';

    await notify(
      `🚀 <b>Bot Started!</b>\n\n` +
      `💰 Balance: ${balance} SOL | 📊 Daily PnL: <code>$${dailyPnl.toFixed(2)}</code>\n` +
      `🛡️ Circuit Breaker: <b>${cbStatus}</b>\n` +
      `🧭 Stage: <code>${cfg.deploymentStage}</code> (canaryMax ${cfg.canaryMaxPositions})\n` +
      `🦅 Hunter: ${cfg.autoScreeningEnabled ? '🤖 auto-screen ON' : '⏸ auto-screen OFF'} | 🩺 Healer: ON\n\n` +
      `/status untuk cek posisi | /start untuk semua commands`,
      { parse_mode: 'HTML' }
    );
    await runStartupModelCheck(notify);
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
