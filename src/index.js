/**
 * src/index.js — Linear Sniper Bot (RPC-First)
 *
 * Entry point bersih. Tidak ada DB import, tidak ada circuit breaker,
 * tidak ada strategy manager, tidak ada deployReadiness.
 *
 * Boot sequence:
 *   1. Init Solana (RPC + Wallet)
 *   2. Init Telegram bot
 *   3. Register commands (status, start/stop, config, manual exit)
 *   4. Jalankan runLinearLoop() — loop tak berhenti sampai /stop
 */

'use strict';

import 'dotenv/config';
import TelegramBot              from 'node-telegram-bot-api';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { initSolana, getWalletBalance }   from './solana/wallet.js';
import { getConfig, updateConfig, isConfigKeySupported, resolveNestedKey, SETCONFIG_WHITELIST } from './config.js';
import { runLinearLoop, stopLoop, setNotifyFn, setNotifyMuted, isRunning, getCurrentPosition, getActivePositions, setShutdownInProgress, closeAllActivePositionsByUser, closeAllActivePositionsForShutdown, retryFailedShutdownPositions, runAutoscreening, spawnMonitorForRestoredPositions, startManualCloseWatcher, startPendingTaRadarWatcher, stopPendingTaRadarWatcher, startTaWatchWatcher, stopTaWatchWatcher, scanAndDeploy, updatePnlStatus, inventoryManagement, submitManualCaPool } from './agents/hunterAlpha.js';
import { getActivePositionCount, reconcileStartupPositions, EP_CONFIG } from './sniper/evilPanda.js';
import { analyzePerformance, formatEvolutionReport }     from './learn/statelessEvolve.js';
import { generateBriefing, formatActivePositionsTelegram } from './telegram/briefing.js';
import { readBlacklist, removeFromBlacklist }            from './learn/tokenBlacklist.js';
import { validateRuntimeEnv }             from './runtime/env.js';
import { safeNum, escapeHTML }            from './utils/safeJson.js';
import { formatTakeProfitRiskLabel }      from './utils/exitReasons.js';
import { initializeRpcManager }           from './utils/helius.js';
import { createMessageTransport }         from './telegram/messageTransport.js';
import { getTodayResults }                from './db/database.js';
import { deleteRuntimeState, getRuntimeState, setRuntimeState } from './runtime/state.js';
import { startDeployQueueWatcher, stopDeployQueueWatcher, setDeployQueueNotifyFn, setDeployQueueDeployFn, setDeployQueueMonitorFn } from './utils/pendingDeployQueue.js';
import { deployPosition } from './sniper/evilPanda.js';
import { sendImmediateTopPoolsReport }    from './agents/hunterAlpha.js';

// ── PID Lock — cegah multiple instance ───────────────────────────
const PID_FILE = new URL('../bot.pid', import.meta.url).pathname;
if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(oldPid, 0);
    console.error(`❌ Bot sudah jalan (PID ${oldPid}). Stop dulu: kill ${oldPid}`);
    process.exit(1);
  } catch {
    unlinkSync(PID_FILE);
  }
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });

// ── Env Validation ────────────────────────────────────────────────
const { missing } = validateRuntimeEnv({ requireTrading: true, requireGmgn: true });
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.AI_MODEL) {
  console.warn(
    `⚠️ Global AI override aktif via AI_MODEL=${process.env.AI_MODEL}. ` +
    `Ini akan menimpa screeningModel/managementModel/agentModel dari .env atau config.`
  );
}

const ALLOWED_ID = parseInt(process.env.ALLOWED_TELEGRAM_ID);
if (isNaN(ALLOWED_ID)) {
  console.error('❌ ALLOWED_TELEGRAM_ID harus berupa angka.');
  process.exit(1);
}

// ── Solana Init ───────────────────────────────────────────────────
initializeRpcManager();
initSolana();

// ── Telegram Bot ──────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  filepath: false,
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

const transport = createMessageTransport(bot);

async function sendLong(chatId, text, opts = {}) {
  const MAX = 4000;
  const rawText = String(text ?? '');

  const sendChunk = async (chunk) => {
    try {
      await bot.sendMessage(chatId, chunk, opts);
      return true;
    } catch (_err) {
      if (opts?.parse_mode === 'HTML') {
        try {
          await bot.sendMessage(chatId, chunk.replace(/<\/?[^>]+>/g, ''), { ...opts, parse_mode: undefined });
          return true;
        } catch (_fallbackErr) {
          return false;
        }
      }
      return false;
    }
  };

  if (rawText.length <= MAX) {
    return sendChunk(rawText);
  }

  const lines = rawText.split('\n');
  let buffer = '';
  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length > MAX) {
      if (buffer) {
        await sendChunk(buffer);
        buffer = '';
      }
      if (line.length > MAX) {
        for (let i = 0; i < line.length; i += MAX) {
          const slice = line.slice(i, i + MAX);
          await sendChunk(slice);
        }
      } else {
        buffer = line;
      }
      continue;
    }
    buffer = candidate;
  }

  if (buffer) {
    await sendChunk(buffer);
  }
}

// ── Notify helper ─────────────────────────────────────────────────
const CHAT_ID = ALLOWED_ID; // bot hanya punya satu user
const OPERATOR_DISCOVERY_PAUSED_KEY = 'operatorDiscoveryPaused';
const AUTO_SCREENING_RUNTIME_KEY = 'autoScreeningRuntimeEnabled';
const AUTO_SCREENING_ACTIVE_POSITION_PAUSE_KEY = 'autoScreeningPausedByActivePositions';
function isDiscoveryPaused() {
  const state = getRuntimeState(OPERATOR_DISCOVERY_PAUSED_KEY, null);
  return state === true || state?.paused === true;
}

function setAutoScreeningRuntimeEnabled(enabled, reason = 'OPERATOR_RESUME') {
  setRuntimeState(AUTO_SCREENING_RUNTIME_KEY, {
    enabled: Boolean(enabled),
    reason,
    updatedAt: Date.now(),
  });
}

function isAutoScreeningRuntimeEnabled() {
  const state = getRuntimeState(AUTO_SCREENING_RUNTIME_KEY, null);
  if (state === true || state?.enabled === true) return true;
  if (state === false || state?.enabled === false) return false;
  return getConfig().autoScreeningEnabled === true;
}

function clearAutoScreeningRuntimeEnabled() {
  deleteRuntimeState(AUTO_SCREENING_RUNTIME_KEY);
}

function setAutoScreeningPausedByActivePositions(paused, reason = 'ACTIVE_POSITIONS_OPEN') {
  if (paused) {
    setRuntimeState(AUTO_SCREENING_ACTIVE_POSITION_PAUSE_KEY, {
      paused: true,
      reason,
      pausedAt: Date.now(),
      activePositionCount: getActivePositionCount(),
    });
    return;
  }
  deleteRuntimeState(AUTO_SCREENING_ACTIVE_POSITION_PAUSE_KEY);
}

function isAutoScreeningPausedByActivePositions() {
  const state = getRuntimeState(AUTO_SCREENING_ACTIVE_POSITION_PAUSE_KEY, null);
  return state === true || state?.paused === true;
}

function syncAutoScreeningWithActivePositions(source = 'autoscreen') {
  const activePositionCount = Math.max(0, Number(getActivePositionCount() || 0));
  if (activePositionCount > 0) {
    if (!isAutoScreeningPausedByActivePositions()) {
      console.log(
        `[autoscreen] ${source}: paused because ${activePositionCount} active position(s) are still open.`
      );
    }
    setAutoScreeningPausedByActivePositions(true, 'ACTIVE_POSITIONS_OPEN');
    return { blocked: true, activePositionCount };
  }

  if (isAutoScreeningPausedByActivePositions()) {
    console.log(`[autoscreen] ${source}: resumed because no active positions remain.`);
    setAutoScreeningPausedByActivePositions(false);
  }

  return { blocked: false, activePositionCount: 0 };
}

function pauseDiscovery(reason = 'TELEGRAM_STOP') {
  setRuntimeState(OPERATOR_DISCOVERY_PAUSED_KEY, {
    paused: true,
    reason,
    pausedAt: Date.now(),
  });
  console.log(`[operator-stop] discovery/deploy paused reason=${reason}`);
}

function resumeDiscovery(reason = 'OPERATOR_RESUME') {
  if (isDiscoveryPaused()) {
    deleteRuntimeState(OPERATOR_DISCOVERY_PAUSED_KEY);
    console.log(`[operator-stop] resumed by ${reason}`);
  }
}

function getPausedMessage() {
  return `Discovery/deploy is paused by <code>/stop</code>. Use <code>/autoscreen on</code>, <code>/hunt</code>, or <code>/screening on</code> to resume.`;
}

async function notify(msg, opts = {}) {
  try {
    await sendLong(CHAT_ID, msg, { parse_mode: 'HTML', ...opts });
  } catch {}
}

function buildSetconfigHelpSections() {
  const bySection = (section) => Object.entries(SETCONFIG_WHITELIST)
    .filter(([, m]) => m.section === section)
    .map(([k, m]) => `  <code>${k}</code> — ${m.desc}`)
    .join('\n');

  return [
    `⚙️ <b>/setconfig — Kunci yang Bisa Diubah</b>\n\n` +
    `Format: <code>/setconfig [key] [value]</code>\n` +
    `atau:   <code>/setconfig [section].[key] [value]</code>\n\n` +
    `<b>💰 Finance:</b>\n${bySection('finance')}\n\n` +
    `<b>🔍 Discovery:</b>\n${bySection('discovery')}\n\n` +
    `<b>🆕 Alerts:</b>\n${bySection('alerts')}\n\n` +
    `<b>🎯 Strategy:</b>\n${bySection('strategy')}`,
    `<b>🕯️ Entry:</b>\n${bySection('entry')}\n\n` +
    `<b>👀 Watch:</b>\n${bySection('watch')}\n\n` +
    `<b>📉 OOR:</b>\n${bySection('oor')}\n\n` +
    `<b>🛡️ Pool Impact Guard:</b>\n${bySection('poolImpactGuard')}\n\n` +
    `<b>🧠 Pool Pattern Learning:</b>\n${bySection('poolPatternLearning')}\n\n` +
    `<i>Contoh:\n` +
    `/setconfig deployAmountSol 1.5\n` +
    `/setconfig minTvl 50000\n` +
    `/setconfig alerts.intervalMin 5\n` +
    `/setconfig strategy.liquidityShape bidask\n` +
    `/setconfig strategy.liquidityShape spot\n` +
    `/setconfig deployRangeMaxBins 50\n` +
    `Catatan: shape ini global, jadi sekali diubah akan dipakai semua jalur deploy berikutnya.\n` +
    `/setconfig trailingTriggerPct 1\n` +
    `/setconfig trailingDropPct 0.5\n` +
    `/setconfig trailingStopPct 3\n` +
    `/setconfig taWatchEnabled true\n` +
    `/setconfig outOfRangeWaitMinutes 45\n` +
    `/setconfig oor.displayWaitMinutes 5\n` +
    `/setconfig oor.watchDisplayEnabled false\n` +
    `/setconfig poolImpactGuardEnabled true\n` +
    `/setconfig poolPatternLearningShadowMode true</i>`,
  ];
}

function buildSetconfigSectionMenu() {
  return {
    text: `⚙️ <b>AI-Agent-DLMM Config</b>\n\n` +
      `Pilih section:\n` +
      `[ Finance ] [ Discovery ]\n` +
      `[ Alerts ] [ Strategy ]\n` +
      `[ Entry ] [ Watch ]\n` +
      `[ OOR ]\n` +
      `[ Pool Impact Guard ]\n` +
      `[ Pool Pattern Learning ]\n\n` +
      `<i>Klik section untuk lihat key dan contoh /setconfig.</i>`,
    opts: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Finance', callback_data: 'setconfig_section:finance' },
            { text: 'Discovery', callback_data: 'setconfig_section:discovery' },
          ],
          [
            { text: 'Alerts', callback_data: 'setconfig_section:alerts' },
            { text: 'Strategy', callback_data: 'setconfig_section:strategy' },
          ],
          [
            { text: 'Entry', callback_data: 'setconfig_section:entry' },
            { text: 'Watch', callback_data: 'setconfig_section:watch' },
          ],
          [
            { text: 'OOR', callback_data: 'setconfig_section:oor' },
          ],
          [
            { text: 'Pool Impact', callback_data: 'setconfig_section:poolImpactGuard' },
          ],
          [
            { text: 'Pattern', callback_data: 'setconfig_section:poolPatternLearning' },
          ],
        ],
      },
    },
  };
}

function buildStartCommandPanel() {
  return {
    text: `🟢 <b>AI-Agent-DLMM Commands</b>\n\n` +
      `/start — lihat command\n` +
      `/status — posisi aktif\n` +
      `/hunt — mulai loop\n` +
      `/screening — scan manual top pool\n` +
      `/autoscreen — on/off auto-screening\n` +
      `/ca — kirim CA / pool Meteora\n` +
      `/evolve — saran config dari harvest.log\n` +
      `/balance — saldo wallet\n` +
      `/config — tampilkan config\n` +
      `/setconfig — ubah config\n` +
      `/dryrun — toggle dry run\n` +
      `/stop — hentikan loop\n` +
      `/exit — force exit posisi aktif`,
    opts: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '/start', callback_data: 'cmd:/start' },
            { text: '/status', callback_data: 'cmd:/status' },
          ],
          [
            { text: '/hunt', callback_data: 'cmd:/hunt' },
            { text: '/screening', callback_data: 'cmd:/screening' },
          ],
          [
            { text: '/autoscreen', callback_data: 'cmd:/autoscreen' },
          ],
          [
            { text: '/ca', callback_data: 'cmd:/ca' },
            { text: '/evolve', callback_data: 'cmd:/evolve' },
            { text: '/balance', callback_data: 'cmd:/balance' },
          ],
          [
            { text: '/config', callback_data: 'cmd:/config' },
            { text: '/setconfig', callback_data: 'cmd:/setconfig' },
          ],
          [
            { text: '/dryrun', callback_data: 'cmd:/dryrun' },
            { text: '/stop', callback_data: 'cmd:/stop' },
          ],
          [
            { text: '/exit', callback_data: 'cmd:/exit' },
          ],
        ],
      },
    },
  };
}

function buildActivationLaunchPanel() {
  return {
    text: `🟢 <b>AI-Agent-DLMM Activated</b>\n\n` +
      `Discovery priority dapat diarahkan lewat <code>/setconfig discovery.category</code>.\n` +
      `<i>Trending = activity-first. Top performers = fee-first.</i>`,
    opts: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Autoscreen ON', callback_data: 'cmd:/autoscreen on' },
          ],
          [
            { text: 'Start', callback_data: 'cmd:/start' },
          ],
        ],
      },
    },
  };
}

function buildSetconfigSectionDetail(section) {
  const titleMap = {
    finance: '💰 Finance',
    discovery: '🔍 Discovery',
    strategy: '🎯 Strategy',
    entry: '🕯️ Entry',
    watch: '👀 Watch',
    oor: '📉 OOR',
    poolImpactGuard: '🛡️ Pool Impact Guard',
    poolPatternLearning: '🧠 Pool Pattern Learning',
  };
  const bySection = (target) => Object.entries(SETCONFIG_WHITELIST)
    .filter(([, m]) => m.section === target)
    .map(([k, m]) => `- <code>${k}</code> — ${m.desc}`)
    .join('\n');
  const examples = {
    finance: [
      '/setconfig deployAmountSol 1.5',
      '/setconfig minSolToOpen 0.10',
      '/setconfig gasReserve 0.03',
      '/setconfig dailyLossLimitUsd 25',
    ],
    discovery: [
      '/setconfig minTvl 50000',
      '/setconfig maxTvl 5000000',
      '/setconfig minVolume 100000',
      '/setconfig maxMcap 1000000',
      '/setconfig discovery.category trending',
      '/setconfig discovery.category top performers',
    ],
    strategy: [
      '/setconfig strategy.liquidityShape bidask',
      '/setconfig deployRangeMaxBins 50',
      '/setconfig trailingTriggerPct 1',
      '/setconfig trailingDropPct 0.5',
      '/setconfig trailingStopPct 3',
      '/setconfig closeSwapMode all',
      '/setconfig closeResidualSwapEnabled true',
    ],
    entry: [
      '/setconfig entryDecisionMode strict',
      '/setconfig entryCandleSanityEnabled true',
      '/setconfig entryFinalProximityMaxDriftPct 2.5',
      '/setconfig entryMinVolumeRatio 1.5',
      '/setconfig entryM15MaxAgeSec 1800',
    ],
    watch: [
      '/setconfig watchIntervalSec 30',
      '/setconfig taWatchEnabled true',
      '/setconfig taWatchMaxPools 10',
      '/setconfig taWatchExpiryMin 60',
    ],
    oor: [
      '/setconfig outOfRangeWaitMinutes 45',
      '/setconfig oorDisplayWaitMinutes 5',
      '/setconfig oorWatchDisplayEnabled false',
    ],
    poolImpactGuard: [
      '/setconfig poolImpactGuardEnabled true',
      '/setconfig poolImpactPriceDropWarnPct 5',
      '/setconfig poolImpactPriceDropForceExitPct 15',
      '/setconfig poolImpactLowerRangeBufferPct 15',
    ],
    poolPatternLearning: [
      '/setconfig poolPatternLearningEnabled true',
      '/setconfig poolPatternLearningShadowMode true',
      '/setconfig poolPatternLearningMinSamples 30',
      '/setconfig poolPatternLearningMaxScoreDelta 0.25',
    ],
  };
  const label = titleMap[section] || '⚙️ Section';
  const lines = [
    `${label}`,
    '',
    'Bisa diubah:',
    bySection(section) || '- N/A',
    '',
    'Contoh:',
    ...(examples[section] || ['- N/A']).map((line) => ` ${line}`),
  ];
  return {
    text: lines.join('\n'),
    opts: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Kembali', callback_data: 'setconfig_menu' },
          ],
        ],
      },
    },
  };
}

function isSetconfigSection(data = '') {
  return String(data || '').startsWith('setconfig_section:');
}

function isCommandShortcut(data = '') {
  return String(data || '').startsWith('cmd:');
}

async function runCommandShortcut(chatId, commandText) {
  const text = String(commandText || '').trim();
  if (!chatId || !text) return false;
  await bot.processUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: {
        id: ALLOWED_ID,
        is_bot: false,
        first_name: 'Operator',
      },
      chat: {
        id: chatId,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
  return true;
}

async function runSilentScan({ emitFinalReport = false, source = 'startup' } = {}) {
  if (isDiscoveryPaused()) {
    return { blocked: true, policy: 'OPERATOR_DISCOVERY_PAUSED' };
  }
  console.log(`[autoscreen] AUTOSCREEN_SCAN_TRIGGER source=${source} silent=true`);
  setNotifyMuted(true);
  try {
    return await scanAndDeploy({ emitFinalReport });
  } finally {
    setNotifyMuted(false);
    if (!emitFinalReport) {
      console.log(`[autoscreen] AUTOSCREEN_FIRST_RUN_SUPPRESSED source=${source}`);
    }
  }
}

async function runImmediateAutoscreenScan({ source = 'manual_command', emitFinalReport = true } = {}) {
  if (isDiscoveryPaused()) {
    return { blocked: true, policy: 'OPERATOR_DISCOVERY_PAUSED' };
  }
  if (_screeningScanInFlight) {
    console.log(`[autoscreen] immediate scan skipped source=${source}: scan in-flight`);
    return { blocked: true, policy: 'SCREENING_SCAN_IN_FLIGHT' };
  }
  _screeningScanInFlight = true;
  try {
    console.log(`[autoscreen] AUTOSCREEN_SCAN_TRIGGER source=${source} silent=false`);
    return await scanAndDeploy({ emitFinalReport });
  } finally {
    _screeningScanInFlight = false;
  }
}

async function startAutoScreeningRuntime(chatId, { snapshotTopPools = false } = {}) {
  if (isDiscoveryPaused()) {
    return false;
  }
  setDeployQueueNotifyFn(notify);
  setDeployQueueDeployFn(deployPosition);
  startDeployQueueWatcher();
  startPendingTaRadarWatcher();
  startTaWatchWatcher();

  if (snapshotTopPools) {
    try {
      await sendImmediateTopPoolsReport(chatId);
    } catch (e) {
      console.error('[autoscreen] Snapshot top pools gagal:', e.message);
    }
  }
}

function stopAutoScreeningRuntime() {
  stopScreeningLoop();
  stopPendingTaRadarWatcher();
  stopTaWatchWatcher();
  stopDeployQueueWatcher();
}

async function resumeAutoScreeningRuntime(chatId, { snapshotTopPools = false, source = 'operator_resume' } = {}) {
  resumeDiscovery(source);
  setAutoScreeningRuntimeEnabled(true, source);
  stopScreeningLoop();
  await startAutoScreeningRuntime(chatId, { snapshotTopPools });
  return true;
}

async function urgentNotify(msg) {
  await notify(msg);
}

// Register notify ke hunterAlpha
setNotifyFn(notify);
setDeployQueueDeployFn(deployPosition);

// ── Commands ──────────────────────────────────────────────────────

function guard(msg) {
  return msg.from?.id === ALLOWED_ID;
}

function isLikelySolanaAddress(text = '') {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(text || '').trim());
}

async function processManualCaInput(chatId, poolAddress, { source = 'TELEGRAM_CA', announce = 'CA diterima' } = {}) {
  if (isDiscoveryPaused()) {
    await bot.sendMessage(chatId, `⏸️ ${getPausedMessage()}`, { parse_mode: 'HTML' });
    return;
  }

  await bot.sendMessage(
    chatId,
    `📥 <b>${escapeHTML(announce)}</b>\n` +
    `<code>${escapeHTML(poolAddress)}</code>\n` +
    `<i>Bot akan cek WATCH → QUEUE → DEPLOY. HOLD = pantau dulu, DROP = buang.</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await submitManualCaPool(poolAddress, { source });
    if (result?.ok) {
      setDeployQueueNotifyFn(notify);
      setDeployQueueDeployFn(deployPosition);
      startDeployQueueWatcher();
      startTaWatchWatcher();
    }

    if (result?.status === 'QUEUE') {
      await bot.sendMessage(
        chatId,
        `🟡 <b>QUEUE</b>\n` +
        `<b>${escapeHTML(result.symbol || 'UNKNOWN')}</b>\n` +
        `State: <code>DEPLOY</code>\n` +
        `Mode: <code>${escapeHTML(result.kind || 'UNKNOWN')}</code>\n` +
        `ST: <code>${escapeHTML(result.entrySignals?.taTrend || 'UNKNOWN')}</code> | ` +
        `M5: <code>${Number(result.entrySignals?.priceChangeM5 || 0).toFixed(2)}%</code> | ` +
        `Breakout: <code>${escapeHTML(result.entrySignals?.breakoutQuality || 'UNKNOWN')}</code>\n` +
        `<i>${escapeHTML(result.resolutionNote || 'Sudah masuk antrean deploy.')}</i>`,
        { parse_mode: 'HTML' }
      );
    } else if (result?.status === 'WATCH') {
      await bot.sendMessage(
        chatId,
        `👀 <b>WATCH</b>\n` +
        `<b>${escapeHTML(result.symbol || 'UNKNOWN')}</b>\n` +
        `State: <code>HOLD</code>\n` +
        `Mode: <code>${escapeHTML(result.kind || 'UNKNOWN')}</code>\n` +
        `ST: <code>${escapeHTML(result.entrySignals?.taTrend || 'UNKNOWN')}</code> | ` +
        `M5: <code>${Number(result.entrySignals?.priceChangeM5 || 0).toFixed(2)}%</code> | ` +
        `Breakout: <code>${escapeHTML(result.entrySignals?.breakoutQuality || 'UNKNOWN')}</code>\n` +
        `<i>${escapeHTML(result.resolutionNote || 'Dipantau sampai siap naik queue.')}</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await bot.sendMessage(
        chatId,
        `❌ <b>DROP</b>\n` +
        `<b>${escapeHTML(result?.symbol || poolAddress.slice(0, 8))}</b>\n` +
        `State: <code>DROP</code>\n` +
        `Reason: <i>${escapeHTML(result?.reason || 'Gagal memproses CA')}</i>`,
        { parse_mode: 'HTML' }
      );
    }
    return result;
  } catch (e) {
    await bot.sendMessage(
      chatId,
      `❌ <b>CA error</b>\n<code>${escapeHTML(e.message)}</code>`,
      { parse_mode: 'HTML' }
    );
    return { ok: false, status: 'ERROR', reason: e.message };
  }
}

// /start — daftar command
bot.onText(/\/start/, (msg) => {
  if (!guard(msg)) return;
  const panel = buildStartCommandPanel();
  sendLong(msg.chat.id, panel.text, panel.opts);
});

// /ca <pool_address> — manual input pool Meteora ke WATCH/QUEUE
bot.onText(/\/ca(?:\s+(\S+))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const poolAddress = String(match?.[1] || '').trim();

  if (!poolAddress) {
    bot.sendMessage(
      chatId,
      `ℹ️ <b>Gunakan /ca</b>\n` +
      `Format: <code>/ca &lt;token_ca_atau_pool&gt;</code>\n` +
      `Contoh: <code>/ca 6EQKNJD6KMTQv9KmhKDjs1jm1SRsNVGNqdKeEEiJpump</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await processManualCaInput(chatId, poolAddress, { source: 'TELEGRAM_CA', announce: 'CA diterima' });
});

// Raw CA input — jika user kirim pool address langsung, jalankan flow /ca yang sama
bot.on('message', async (msg) => {
  if (!guard(msg)) return;
  const text = String(msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  if (!isLikelySolanaAddress(text)) return;

  const chatId = msg.chat.id;
  await processManualCaInput(chatId, text, { source: 'TELEGRAM_RAW_CA', announce: 'CA terdeteksi langsung' });
});

// /status — status posisi saat ini
bot.onText(/\/status/, async (msg) => {
  if (!guard(msg)) return;
  const chatId   = msg.chat.id;
  const running  = isRunning();
  const posKey   = getCurrentPosition();
  const active   = Array.isArray(getActivePositions()) ? getActivePositions() : [];
  const balance  = await getWalletBalance();
  const cfg      = getConfig();

  const posLine = active.length > 0
    ? formatActivePositionsTelegram(active, { maxItems: 3 })
    : `\n\n🏦 <b>Posisi Aktif</b>: <code>0</code>\n   <i>Tidak ada posisi aktif.</i>`;

  bot.sendMessage(chatId,
    `📊 <b>Linear Sniper Status</b>\n\n` +
    `Loop: <code>${running ? '▶ RUNNING' : '⏹ STOPPED'}</code>\n` +
    `${posLine}\n` +
    `Balance: <code>${balance} SOL</code>\n` +
    `Deploy Amount: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
    `${formatTakeProfitRiskLabel(cfg.takeProfitMinNetPnlPct, cfg.stopLossPct)}\n` +
    `Anchor: <code>DLMM active bin</code> | Source: <code>frozen/live fallback</code>\n` +
    `TA: <code>info only (RSI ref ${cfg.smartExitRsi || 90})</code>`,
    { parse_mode: 'HTML' }
  );
});

// /hunt — mulai loop
bot.onText(/\/hunt/, async (msg) => {
  if (!guard(msg)) return;
  resumeDiscovery('TELEGRAM_HUNT');
  if (isRunning()) {
    bot.sendMessage(msg.chat.id, '⚠️ Loop sudah berjalan.', { parse_mode: 'HTML' });
    return;
  }
  bot.sendMessage(msg.chat.id, '▶️ <b>Memulai Multi-Agent Scheduler...</b>', { parse_mode: 'HTML' });
  
  const cfg = getConfig();
  
  // 1. Screening Loop (scanAndDeploy)
  const runScreening = async () => {
    while (isRunning()) {
      try {
        await scanAndDeploy();
      } catch (e) {
        console.error("⚠️ Screening Loop Error:", e.message);
      }
      const cfg = getConfig();
      const intervalMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;
      await new Promise(r => setTimeout(r, intervalMin * 60 * 1000));
    }
  };

  // 2. Realtime PnL Loop (updatePnlStatus)
  const runPnl = async () => {
    while (isRunning()) {
      try {
        // Beri jeda kecil agar tidak bertabrakan dengan Telegram Report dari Screening
        await new Promise(r => setTimeout(r, 2000));
        await updatePnlStatus();
      } catch (e) {
        console.error("⚠️ PnL Loop Error:", e.message);
      }
      const cfg = getConfig();
      const intervalSec = cfg.intervals?.realtimePnlIntervalSec || cfg.realtimePnlIntervalSec || 300;
      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  };

  // 3. Management Loop (inventoryManagement)
  const runManagement = async () => {
    while (isRunning()) {
      try {
        await new Promise(r => setTimeout(r, 5000));
        await inventoryManagement();
      } catch (e) {
        console.error("⚠️ Management Loop Error:", e.message);
      }
      const cfg = getConfig();
      const intervalMin = cfg.intervals?.managementIntervalMin || cfg.managementIntervalMin || 10;
      await new Promise(r => setTimeout(r, intervalMin * 60 * 1000));
    }
  };

  // Trigger LinearLoop to just set _running = true basically, 
  // or we can just call the loops if we handle `isRunning` state correctly.
  runLinearLoop().then(() => {
    runScreening();
    runPnl();
    runManagement();
  }).catch(e => {
    notify(`❌ <b>Scheduler crash:</b>\n<code>${escapeHTML(e.message)}</code>`);
  });
});


// /stop — hentikan loop (tidak force exit posisi)
bot.onText(/\/stop$/, async (msg) => {
  if (!guard(msg)) return;
  pauseDiscovery('TELEGRAM_STOP');
  stopLoop();
  stopAutoScreeningRuntime();
  bot.sendMessage(msg.chat.id,
    `⏹ <b>Autonomous discovery/deploy paused.</b>\n\n` +
    `Existing positions are not force-closed.\n` +
    `Use <code>/autoscreen on</code>, <code>/hunt</code>, or <code>/screening on</code> to resume.\n` +
    `Use <code>/exit</code> only if you want to force-close active positions.`,
    { parse_mode: 'HTML' }
  );
});

// /exit — force exit posisi aktif sekarang
bot.onText(/\/exit/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const active = Array.isArray(getActivePositions()) ? getActivePositions() : [];

  if (active.length === 0) {
    bot.sendMessage(chatId, 'ℹ️ Tidak ada posisi aktif untuk di-exit.', { parse_mode: 'HTML' });
    return;
  }

  bot.sendMessage(
    chatId,
    `⏳ <b>Force exit semua posisi aktif</b>\n` +
    `Total: <code>${active.length}</code>\n` +
    `<i>Bot akan verifikasi on-chain sebelum melapor sukses.</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    stopLoop();
    // Legacy: closeAllActivePositionsByUser('MANUAL_COMMAND', 180_000).
    const summary = await closeAllActivePositionsByUser('MANUAL_EXIT', 180_000);
    const balance = await getWalletBalance();

    if (summary.failed.length > 0 || summary.remaining > 0) {
      const failedLines = summary.failed.slice(0, 5)
        .map((r) => `${r.symbol || r.pubkey.slice(0,8)}: ${r.reason || 'FAILED'}`)
        .join('\n');
      bot.sendMessage(chatId,
        `⚠️ <b>Manual exit belum bersih</b>\n` +
        `Closed: <code>${summary.closed}/${summary.total}</code>\n` +
        `Remaining registry: <code>${summary.remaining}</code>\n` +
        (failedLines ? `<pre>${escapeHTML(failedLines)}</pre>\n` : '') +
        `Balance: <code>${balance} SOL</code>\n` +
        `<i>Posisi gagal tidak dihapus lokal agar bisa direconcile.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    bot.sendMessage(chatId,
      `✅ <b>Manual exit selesai dan verified.</b>\n` +
      `Closed: <code>${summary.closed}/${summary.total}</code>\n` +
      `Remaining registry: <code>0</code>\n` +
      `Balance: <code>${balance} SOL</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    bot.sendMessage(chatId,
      `❌ <b>Exit gagal:</b>\n<code>${escapeHTML(e.message)}</code>\n\n` +
      `⚠️ <i>Cek posisi on-chain secara manual!</i>`,
      { parse_mode: 'HTML' }
    );
  }
});

// /balance — saldo wallet
bot.onText(/\/balance/, async (msg) => {
  if (!guard(msg)) return;
  const balance = await getWalletBalance();
  bot.sendMessage(msg.chat.id, `💰 Balance: <code>${balance} SOL</code>`, { parse_mode: 'HTML' });
});

// /config — tampilkan config aktif per section
bot.onText(/\/config/, (msg) => {
  if (!guard(msg)) return;
  const cfg = getConfig();
  const finance = [
    `deployAmountSol       = ${cfg.deployAmountSol}`,
    `maxPositions          = ${cfg.maxPositions}`,
    `minSolToOpen          = ${cfg.minSolToOpen}`,
    `gasReserve            = ${cfg.gasReserve}`,
    `slippageBps           = ${cfg.slippageBps}`,
    `dailyLossLimitUsd     = ${cfg.dailyLossLimitUsd}`,
  ].join('\n');
  const discovery = [
    `meteoraDiscoveryLimit = ${cfg.meteoraDiscoveryLimit}`,
    `screeningTopPoolsLimit = ${cfg.screeningTopPoolsLimit}`,
    `discoveryTimeframe    = ${cfg.discoveryTimeframe}`,
    `discoveryCategory     = ${cfg.discoveryCategory}`,
    `discoveryPriority     = ${
      String(cfg.discoveryCategory || '').toLowerCase() === 'trending'
        ? 'activity-first'
        : String(cfg.discoveryCategory || '').toLowerCase() === 'top performers'
          ? 'fee-first'
          : 'fee-first'
    }`,
    `minTvl                = ${cfg.minTvl}`,
    `maxTvl                = ${cfg.maxTvl}`,
    `minVolume          = ${cfg.minVolume}`,
    `minHolders            = ${cfg.minHolders}`,
    `minOrganic            = ${cfg.minOrganic}`,
    `minMcap               = ${cfg.minMcap}`,
    `maxMcap               = ${cfg.maxMcap}`,
  ].join('\n');
  const strategy = [
      `stopLossPct           = ${cfg.stopLossPct}`,
      `trailingTriggerPct    = ${cfg.trailingTriggerPct}`,
      `trailingDropPct       = ${cfg.trailingDropPct}`,
      `trailingStopPct       = ${cfg.trailingStopPct}`,
      `dlmmLiquidityShape    = ${cfg.dlmmLiquidityShape}`,
      `deployRangeMaxBins    = ${cfg.deployRangeMaxBins}`,
      `takeProfitMinNetPnlPct = ${cfg.takeProfitMinNetPnlPct}`,
      `taWatchEnabled        = ${cfg.taWatchEnabled}`,
    `taWatchMaxPools       = ${cfg.taWatchMaxPools}`,
    `taWatchExpiryMin      = ${cfg.taWatchExpiryMin}`,
    `watchIntervalSec      = ${cfg.watchIntervalSec}`,
    `atrGuardEnabled       = ${cfg.atrGuardEnabled}`,
    `atrMultiplier         = ${cfg.atrMultiplier}`,
    `dryRun                = ${cfg.dryRun}`,
    `autoScreeningEnabled  = ${cfg.autoScreeningEnabled}`,
    `screeningIntervalMin  = ${cfg.screeningIntervalMin}`,
  ].join('\n');
  const oor = [
    `outOfRangeWaitMinutes = ${cfg.outOfRangeWaitMinutes} (close threshold)`,
    `oorDisplayWaitMinutes = ${cfg.oorDisplayWaitMinutes} (display only)`,
  ].join('\n');
  const management = [
    `managementIntervalMin = ${cfg.managementIntervalMin}`,
    `positionUpdateMin     = ${cfg.positionUpdateIntervalMin}`,
    `realtimePnlSec        = ${cfg.realtimePnlIntervalSec}`,
  ].join('\n');

  bot.sendMessage(msg.chat.id,
    `⚙️ <b>AI-Agent-DLMM Config</b>\n\n` +
    `<b>💰 Finance</b>\n<pre><code>${finance}</code></pre>\n` +
    `<b>🔍 Discovery</b>\n<pre><code>${discovery}</code></pre>\n` +
    `<b>🎯 Strategy</b>\n<pre><code>${strategy}</code></pre>\n` +
    `<b>📉 OOR</b>\n<pre><code>${oor}</code></pre>\n` +
    `<b>🩺 Management</b>\n<pre><code>${management}</code></pre>\n` +
    `<i>Catatan: outOfRangeWaitMinutes mengatur kapan posisi benar-benar ditutup, ` +
    `sedangkan oorDisplayWaitMinutes hanya mengatur seberapa sering status OOR muncul di log/Telegram. ` +
    `Jika <code>oorWatchDisplayEnabled=false</code>, notifikasi OOR Watch disembunyikan tanpa mengubah logic close.</i>\n` +
    `<i>Edit: /setconfig ? untuk lihat key yang bisa diubah</i>`,
    buildSetconfigSectionMenu().opts
  );
});

// /setconfig [key] [value] — ubah config finance, discovery, dan screening secara live
//
// Format yang didukung:
//   /setconfig deployAmountSol 1.5           (flat key)
//   /setconfig finance.deployAmountSol 1.5   (dot notation)
//   /setconfig discovery.timeframe 1h        (dot notation, string)
//   /setconfig autoScreeningEnabled false    (boolean)
//   /setconfig ?                             (tampilkan semua key)

bot.onText(/\/setconfig(?:\s+(\S+))?(?:\s+(.+))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const rawKey = match[1]?.trim();
  const rawVal = match[2]?.trim();

  // /setconfig ? — tampilkan help
  if (!rawKey || rawKey === '?') {
    const menu = buildSetconfigSectionMenu();
    await sendLong(chatId, menu.text, menu.opts);
    return;
  }

  if (!rawVal) {
    bot.sendMessage(chatId,
      `ℹ️ Gunakan: <code>/setconfig [key] [value]</code>\n` +
      `Lihat semua key: <code>/setconfig ?</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Resolve key (flat atau dot notation) — harus ada di SETCONFIG_WHITELIST
  const resolved = resolveNestedKey(rawKey);
  if (!resolved) {
    bot.sendMessage(chatId,
      `❌ Unsupported /setconfig key. Use /config or /setconfig to see supported keys.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { flatKey, meta } = resolved;

  // Parse value sesuai tipe yang diharapkan
  let parsed;
  if (meta.type === 'number') {
    parsed = parseFloat(rawVal);
    if (isNaN(parsed)) {
      bot.sendMessage(chatId,
        `❌ <code>${escapeHTML(flatKey)}</code> harus berupa angka, bukan <code>${escapeHTML(rawVal)}</code>.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  } else if (meta.type === 'boolean') {
    if      (rawVal === 'true'  || rawVal === 'on'  || rawVal === '1') parsed = true;
    else if (rawVal === 'false' || rawVal === 'off' || rawVal === '0') parsed = false;
    else {
      bot.sendMessage(chatId,
        `❌ <code>${escapeHTML(flatKey)}</code> harus <code>true</code>/<code>on</code> atau <code>false</code>/<code>off</code>.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  } else {
    parsed = rawVal; // string as-is
  }

  if (flatKey === 'dlmmLiquidityShape') {
    const normalized = String(parsed || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, '');
    if (normalized !== 'spot' && normalized !== 'bidask') {
      bot.sendMessage(chatId,
        `❌ <code>${escapeHTML(flatKey)}</code> harus <code>spot</code> atau <code>bidask</code>.\n` +
        `<i>Contoh: /setconfig strategy.liquidityShape bidask</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    parsed = normalized;
  }

  // Apply melalui updateConfig (bounds check otomatis)
  const before = getConfig()[flatKey];
  const result = updateConfig({ [flatKey]: parsed });
  const after  = result[flatKey];

  // Cek bounds rejection
  if (after === before && String(parsed) !== String(before)) {
    bot.sendMessage(chatId,
      `⚠️ <code>${escapeHTML(flatKey)}</code> ditolak — nilai <code>${escapeHTML(String(parsed))}</code> ` +
      `di luar batas yang diizinkan.\n` +
      `<i>${meta.desc}</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ── Efek samping khusus: autoScreeningEnabled ─────────────────────
  if (flatKey === 'autoScreeningEnabled') {
    setAutoScreeningRuntimeEnabled(parsed === true, 'TELEGRAM_SETCONFIG');
    if (parsed === true) {
      const wasPaused = isDiscoveryPaused();
      const loopWasRunning = Boolean(_screeningLoopTimer);
      if (wasPaused || !loopWasRunning) {
        await bot.sendMessage(chatId,
          `📡 <b>Auto-Screening: ON</b>\n` +
          `Loop akan diaktifkan ulang — interval <code>${result.screeningIntervalMin || 15} menit</code>.\n\n` +
          `<i>Memulai scan pertama sekarang...</i>`,
          { parse_mode: 'HTML' }
        );
        await resumeAutoScreeningRuntime(chatId, { snapshotTopPools: false, source: 'TELEGRAM_SETCONFIG_AUTO_SCREENING_ON' });
        try {
          await runImmediateAutoscreenScan({ source: 'setconfig', emitFinalReport: true });
        } catch (e) {
          console.error('[autoscreen] Scan pertama via setconfig gagal:', e.message);
          await notify(`❌ <b>Scan pertama gagal:</b>\n<code>${escapeHTML(e.message)}</code>\n<i>Loop tetap dilanjutkan...</i>`);
        }
        runScreeningLoop();
        return;
      }
      bot.sendMessage(chatId,
        `📡 <b>Auto-Screening: ON</b>\n` +
        `Loop sudah berjalan — interval <code>${result.screeningIntervalMin || 15} menit</code>.`,
        { parse_mode: 'HTML' }
      );
    } else {
      // Stop loop
      stopAutoScreeningRuntime();
      bot.sendMessage(chatId,
        `🔕 <b>Auto-Screening: OFF</b>\n` +
        `Loop dihentikan. Gunakan <code>/screening</code> untuk scan manual.`,
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // ── Efek samping khusus: screeningIntervalMin ─────────────────────
  if (flatKey === 'screeningIntervalMin' && result.autoScreeningEnabled) {
    // Restart loop dengan interval baru
    stopScreeningLoop();
    runScreeningLoop();
    bot.sendMessage(chatId,
      `✅ <b>Interval screening diupdate!</b>\n\n` +
      `Sebelum: <code>${before} menit</code>\n` +
      `Sesudah: <code>${after} menit</code>\n\n` +
      `<i>Loop auto-screening di-restart dengan interval baru.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ── Feedback default untuk semua key lainnya ──────────────────────
  bot.sendMessage(chatId,
    `✅ <b>Config diupdate &amp; disimpan!</b>\n\n` +
    `Kunci  : <code>${escapeHTML(flatKey)}</code>\n` +
    `Sebelum: <code>${escapeHTML(String(before))}</code>\n` +
    `Sesudah: <code>${escapeHTML(String(after))}</code>\n\n` +
    `<i>${meta.desc}</i>\n` +
    `<i>Tersimpan permanen ke <code>user-config.json</code> — efektif di siklus berikutnya.</i>`,
    { parse_mode: 'HTML' }
  );
});

// /dryrun on|off
bot.onText(/\/dryrun(?:\s+(on|off))?/, (msg, match) => {
  if (!guard(msg)) return;
  const chatId  = msg.chat.id;
  const toggle  = match[1]?.toLowerCase();
  if (!toggle) {
    bot.sendMessage(chatId,
      `🟡 dryRun: <code>${getConfig().dryRun ? 'ON' : 'OFF'}</code>\n\nGunakan <code>/dryrun on</code> atau <code>/dryrun off</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  const enable = toggle === 'on';
  updateConfig({ dryRun: enable });
  bot.sendMessage(chatId,
    `${enable ? '🟡' : '🔴'} <b>Dry Run: ${enable ? 'ON' : 'OFF'}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.on('callback_query', async (query) => {
  try {
    const chatId = query?.message?.chat?.id;
    const data = String(query?.data || '');
    if (!chatId || !data) return;

    if (data === 'setconfig_menu') {
      const menu = buildSetconfigSectionMenu();
      await sendLong(chatId, menu.text, menu.opts);
    } else if (isSetconfigSection(data)) {
      const section = data.split(':', 2)[1];
      const detail = buildSetconfigSectionDetail(section);
      await sendLong(chatId, detail.text, detail.opts);
    } else if (isCommandShortcut(data)) {
      const commandText = data.slice('cmd:'.length);
      await runCommandShortcut(chatId, commandText);
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch (e) {
    console.warn(`[telegram] callback_query error: ${e.message}`);
    if (query?.id) await bot.answerCallbackQuery(query.id).catch(() => {});
  }
});

// /autoscreen on|off — Shortcut toggle autoScreeningEnabled
bot.onText(/\/autoscreen(?:\s+(on|off))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();

  if (!toggle) {
    const current = getConfig().autoScreeningEnabled;
    bot.sendMessage(chatId,
      `📡 Auto-Screening: <code>${current ? 'ON' : 'OFF'}</code>\n\n` +
      `Gunakan <code>/autoscreen on</code> atau <code>/autoscreen off</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const enable = toggle === 'on';
  const result = updateConfig({ autoScreeningEnabled: enable });
  const after  = result.autoScreeningEnabled;
  setAutoScreeningRuntimeEnabled(enable, 'TELEGRAM_AUTOSCREEN');

  if (enable) {
    // ── Clear interval lama (anti double-execution) ───────────────────
    await bot.sendMessage(chatId,
      `📡 <b>Auto-Screening: ON</b>\n🔍 Eksekusi scan pertama dimulai sekarang...`,
      { parse_mode: 'HTML' }
    );

    // Wire Deploy Queue agar watcher bisa eksekusi
    await resumeAutoScreeningRuntime(chatId, { snapshotTopPools: false, source: 'TELEGRAM_AUTOSCREEN_ON' });

    // ── 1. INSTANT FIRST RUN (awaited, user-triggered) ───────────────
    // Manual /autoscreen on harus mengirim final report scan pertama.
    try {
      await runImmediateAutoscreenScan({ source: 'manual_command', emitFinalReport: true });
    } catch (e) {
      console.error('[autoscreen] Scan pertama gagal:', e.message);
      await notify(`❌ <b>Scan pertama gagal:</b>\n<code>${escapeHTML(e.message)}</code>\n<i>Loop tetap dilanjutkan...</i>`);
    }

    // ── 2. LOOP ATTACHMENT (setInterval) ─────────────────────────────
    // Pasang interval SETELAH first run selesai — tidak ada race condition.
    // scanAndDeploy() sama persis yang dipanggil setiap interval.
    const cfg = getConfig();
    const intervalMin = Number(cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15);
    const intervalMs  = intervalMin * 60 * 1000;

    runScreeningLoop();
    console.log(`[autoscreen] ✅ Scheduler aktif — siklus berikutnya dalam ${intervalMin} menit.`);

  } else {
    // ── Hentikan interval saat /autoscreen off ────────────────────────
    stopAutoScreeningRuntime();
    bot.sendMessage(chatId,
      `🔕 <b>Auto-Screening: OFF</b>\n` +
      `Loop dihentikan. Gunakan <code>/screening</code> untuk scan manual.`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── /briefing — laporan harian bot ───────────────────────────────
bot.onText(/\/briefing/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📋 <b>Generating briefing...</b>', { parse_mode: 'HTML' });
  try {
    const report = await generateBriefing(24);
    await sendLong(chatId, report, { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(chatId,
      `❌ <b>Briefing error:</b>\n<code>${escapeHTML(e.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── /blacklist — lihat dan kelola daftar token terblokir ─────────
// /blacklist          → tampilkan 10 entry terbaru
// /blacklist rm <mint> → hapus token dari blacklist

bot.onText(/\/blacklist(?:\s+(rm)\s+(\S+))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId  = msg.chat.id;
  const action  = match[1]?.toLowerCase();
  const target  = match[2]?.trim();

  if (action === 'rm' && target) {
    const ok = removeFromBlacklist(target);
    bot.sendMessage(chatId,
      ok
        ? `✅ <code>${escapeHTML(target.slice(0,8))}</code> dihapus dari blacklist.`
        : `⚠️ Mint <code>${escapeHTML(target.slice(0,8))}</code> tidak ditemukan.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Tampilkan list
  const list = readBlacklist();
  if (list.length === 0) {
    bot.sendMessage(chatId, '✅ Blacklist kosong.', { parse_mode: 'HTML' });
    return;
  }

  const lines = list.slice(0, 10).map((e, i) => {
    const exp = e.expires
      ? `exp ${new Date(e.expires).toLocaleDateString('id-ID')}`
      : 'permanent';
    return `${i + 1}. <b>${escapeHTML(e.token)}</b> <code>${e.mint?.slice(0,8) || '?'}</code>\n   ${e.reason} · ${exp}`;
  });

  await sendLong(chatId,
    `🚫 <b>Token Blacklist</b> (${list.length} total)\n\n` +
    lines.join('\n\n') +
    `\n\n<i>Hapus: /blacklist rm &lt;mint&gt;</i>`,
    { parse_mode: 'HTML' }
  );
});

// ── /evolve — analisis harvest.log + rekomendasi LLM ─────────────
// /evolve        → preview rekomendasi (tidak ubah config)
// /evolve apply  → preview + auto-apply perubahan ke user-config.json

bot.onText(/\/evolve(?:\s+(apply))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId    = msg.chat.id;
  const autoApply = match[1]?.toLowerCase() === 'apply';

  await bot.sendMessage(chatId,
    `🧠 <b>Evolve — Menganalisis config terbaru...</b>\n` +
    `<i>Mengirim snapshot config & performa ke ${getConfig().agentModel || 'Agent Model'}...</i>\n` +
    (autoApply ? `⚡ Mode: <b>AUTO-APPLY</b>` : `👁 Mode: <b>Preview</b> (gunakan /evolve apply untuk terapkan)`),
    { parse_mode: 'HTML' }
  );

  try {
    const result = await analyzePerformance({ maxEntries: 50, autoApply });
    const report = formatEvolutionReport(result);
    await sendLong(chatId, report, { parse_mode: 'HTML' });

    // Jika preview dan ada rekomendasi, tawari apply
    if (!autoApply && result.ok && result.recommendations.length > 0) {
      await bot.sendMessage(chatId,
        `💬 <i>Setuju dengan rekomendasi di atas?\nKetik <code>/evolve apply</code> untuk menerapkan perubahan ke config.</i>`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    bot.sendMessage(chatId,
      `❌ <b>Evolve error:</b>\n<code>${escapeHTML(e.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── /screening — scan manual top pool sekarang ────────────────────
bot.onText(/\/screening(?:\s+(on))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const resume = String(match?.[1] || '').toLowerCase() === 'on';
  if (isDiscoveryPaused() && !resume) {
    await bot.sendMessage(
      chatId,
      `⏸️ Screening is paused by <code>/stop</code>. Use <code>/screening on</code> to resume and scan.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (resume) {
    resumeDiscovery('TELEGRAM_SCREENING_ON');
    await startAutoScreeningRuntime(chatId, { snapshotTopPools: false });
  }

  try {
    await scanAndDeploy();
  } catch (e) {
    await bot.sendMessage(chatId, `❌ <b>Scan gagal:</b>\n<code>${escapeHTML(e.message)}</code>`, { parse_mode: 'HTML' });
  }
});

// /strategy_report — compatibility command for legacy telemetry tooling
bot.onText(/\/strategy_report/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const cfg = getConfig();
  const text =
    `📘 <b>AI-Agent-DLMM Strategy</b>\n\n` +
    `Strategy: <code>${cfg.activeStrategy || 'Evil Panda'}</code>\n` +
    `Deploy: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
    `${formatTakeProfitRiskLabel(cfg.takeProfitMinNetPnlPct, cfg.stopLossPct)}\n` +
    `Anchor: <code>DLMM active bin</code> | Source: <code>frozen/live fallback</code>\n` +
    `TA: <code>info only (RSI ref ${cfg.smartExitRsi || 90})</code>\n` +
    `Screening: <code>${cfg.autoScreeningEnabled ? 'ON' : 'OFF'}</code>`;
  await sendLong(chatId, text);
});

// /claim_fees — compatibility command (manual reminder)
bot.onText(/\/claim_fees(?:\s+(\S+))?/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    `ℹ️ Claim fees dijalankan saat exit posisi.\nGunakan <code>/exit</code> untuk force-close posisi aktif.`,
    { parse_mode: 'HTML' }
  );
});

// Research sessions state

let   _screeningLoopTimer = null;
let   _screeningScanInFlight = false;
let _lastDailyLossAlertAt = 0;

async function runScreeningLoop() {
  // Baca config FRESH saat start (bukan dari closure lama)
  const startCfg   = getConfig();
  if (!isAutoScreeningRuntimeEnabled()) {
    console.log('[screening-loop] autoScreeningEnabled=false — loop tidak dijalankan.');
    return;
  }

  // Konversi: config.screeningIntervalMin (angka menit) → milidetik
  // Fallback eksplisit: 15 menit (bukan 2 menit)
  const intervalMin = Number(startCfg.screeningIntervalMin) || 15;
  const intervalMs  = intervalMin * 60 * 1000;

  const tick = async () => {
    // Selalu baca config FRESH setiap tick agar perubahan /setconfig langsung efektif
    const cfg = getConfig();
    if (isDiscoveryPaused()) {
      stopScreeningLoop();
      return;
    }

    // Guard: hentikan diri sendiri jika dinonaktifkan via /setconfig
    if (!isAutoScreeningRuntimeEnabled()) {
      stopScreeningLoop();
      return;
    }

    try {
      const liveCfg = getConfig();
      const today = getTodayResults();
      const dailyPnl = Number(today.totalPnlUsd || 0);
      if (dailyPnl < -liveCfg.dailyLossLimitUsd) {
        console.warn('[screening-loop] Daily Circuit Breaker: Skip screening'); // Daily Circuit Breaker return guard
        if (Date.now() - _lastDailyLossAlertAt > 12 * 60 * 60 * 1000) {
          _lastDailyLossAlertAt = Date.now();
          await urgentNotify(`🛑 <b>DAILY CIRCUIT BREAKER</b>\nPnL harian: <code>${dailyPnl.toFixed(2)} USD</code>`);
        }
        return;
      }
    } catch (e) {
      console.warn('[screening-loop] error:', e.message);
    }

    if (_screeningScanInFlight) {
      console.log('[screening-loop] ⏭️ Skip tick: scan masih berjalan.');
      return;
    }

    _screeningScanInFlight = true;
    try {
      console.log('[screening-loop] ⏰ Tick autoscreen → scanAndDeploy()');
      await scanAndDeploy();
    } catch (e) {
      console.error('[screening-loop] scanAndDeploy error:', e.message);
    } finally {
      _screeningScanInFlight = false;
    }
  };

  // Hanya jalankan background interval (tanpa memanggil tick seketika)
  _screeningLoopTimer = setInterval(tick, intervalMs);
  console.log(`🔍 Screening loop aktif — interval ${intervalMin} menit (${intervalMs / 1000}s)`);
}

function stopScreeningLoop() {
  if (_screeningLoopTimer) {
    clearInterval(_screeningLoopTimer);
    _screeningLoopTimer = null;
  }
  _screeningScanInFlight = false;
}

async function restoreAutoScreeningOnStartup({
  chatId,
  autoScreeningEnabled = false,
  discoveryPaused = false,
  intervalMin = 15,
} = {}) {
  console.log(
    `[autoscreen][startup] AUTOSCREEN_STARTUP_DISABLED restoredFromConfig=${autoScreeningEnabled ? 'true' : 'false'} ` +
    `discoveryPaused=${discoveryPaused ? 'true' : 'false'} ` +
    `reason=manual_command_required nextIntervalMin=${intervalMin}`
  );
  clearAutoScreeningRuntimeEnabled();
  stopAutoScreeningRuntime();
  stopScreeningLoop();
}

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down...`);
  setShutdownInProgress(true);
  stopLoop();
  stopScreeningLoop();
  stopPendingTaRadarWatcher();
  stopTaWatchWatcher();
  stopDeployQueueWatcher();
  const active = Array.isArray(getActivePositions()) ? getActivePositions() : [];
  if (active.length > 0) {
    await notify(
      `⚠️ <b>AI-Agent-DLMM Shutdown</b>\n` +
      `Menutup <code>${active.length}</code> posisi aktif sebelum exit...`
    ).catch(() => {});
    const summary = await closeAllActivePositionsForShutdown(signal, 10_000);
    if (summary.failed.length > 0) {
      await notify(
        `⚠️ <b>Shutdown Partial</b>\n` +
        `Closed: <code>${summary.closed}/${summary.total}</code>\n` +
        `Retrying failed closes once...`
      ).catch(() => {});

      const retry = await retryFailedShutdownPositions(summary.failed, signal, 10_000);
      if (retry.stillFailed.length > 0) {
        const failedStr = retry.stillFailed.map((f) => `${f.pubkey.slice(0,8)}:${f.reason || 'FAILED'}`).join(', ');
        await notify(
          `⚠️ <b>Shutdown Final Partial</b>\n` +
          `Recovered on retry: <code>${retry.recovered}/${retry.retried}</code>\n` +
          `Still failed: <code>${failedStr}</code>\n` +
          `<i>Cek posisi on-chain untuk verifikasi final.</i>`
        ).catch(() => {});
      } else {
        await notify(
          `✅ <b>Shutdown Complete</b>\n` +
          `Recovered: <code>${retry.recovered}/${retry.retried}</code>\n` +
          `Semua posisi berhasil ditutup.`
        ).catch(() => {});
      }
    } else {
      await notify(`✅ <b>Shutdown Complete</b>\nClosed: <code>${summary.closed}/${summary.total}</code>`).catch(() => {});
    }
  } else {
    await notify(`🛑 <b>AI-Agent-DLMM Shutdown</b>\nTidak ada posisi aktif.`).catch(() => {});
  }

  bot.stopPolling();
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (e) => {
  console.error('❌ uncaughtException:', e.message);
  notify(`⚠️ <b>Uncaught error:</b>\n<code>${escapeHTML(e.message)}</code>`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('❌ unhandledRejection:', msg);
  notify(`⚠️ <b>Unhandled rejection:</b>\n<code>${escapeHTML(msg)}</code>`).catch(() => {});
});

// ── Polling error handler ─────────────────────────────────────────
bot.on('polling_error', (e) => {
  if (e.message?.includes('ETIMEDOUT') && !e.message?.includes('EFATAL')) return;
  console.error('Polling error:', e.message);
});

// ── Boot ──────────────────────────────────────────────────────────
setTimeout(async () => {
  try {
    const reconcile = await reconcileStartupPositions();
    const restoredMonitors = spawnMonitorForRestoredPositions();
    const manualCloseWatcherStarted = startManualCloseWatcher();
    const balance = await getWalletBalance();
    const cfg     = getConfig();
    const autoScr = cfg.autoScreeningEnabled;
    const discoveryPaused = isDiscoveryPaused();
    const intervalMin = Number(cfg.screeningIntervalMin) || 15;

    // Log startup Jupiter
    console.log(`✅ Jupiter V1 Direct — api.jup.ag/swap/v1 (fallback: lite-api.jup.ag)`);
    console.log(
      `[autoscreen][startup] config.autoScreeningEnabled=${autoScr ? 'true' : 'false'} ` +
      `paused=${discoveryPaused ? 'true' : 'false'} ` +
      `startupScan=false intervalMin=${intervalMin}`
    );
    await notify(
      `🟢 <b>AI-Agent-DLMM Activated</b>\n\n` +
      `Balance: <code>${balance} SOL</code>\n` +
      `Deploy Size: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
      `${formatTakeProfitRiskLabel(cfg.takeProfitMinNetPnlPct, cfg.stopLossPct)}\n` +
      `Reconcile: <code>${reconcile.restored}/${reconcile.scanned}</code>\n` +
    `Watch Layer: <code>${cfg.taWatchEnabled === false ? 'OFF' : 'ON'}</code> | ` +
    `Radar: <code>${cfg.pendingRetestEnabled === false ? 'OFF' : 'ON'}</code>\n` +
    `Auto Screen: <code>${discoveryPaused ? 'OFF by /stop' : autoScr ? `ON (${cfg.screeningIntervalMin}m)` : 'OFF'}</code>\n` +
    `Discovery Priority: <code>${
      String(cfg.discoveryCategory || '').toLowerCase() === 'trending'
        ? 'activity-first'
        : String(cfg.discoveryCategory || '').toLowerCase() === 'top performers'
          ? 'fee-first'
          : 'fee-first'
    }</code>`
      ,
      buildActivationLaunchPanel().opts
    );

    await restoreAutoScreeningOnStartup({
      chatId: CHAT_ID,
      autoScreeningEnabled: false,
      discoveryPaused,
      intervalMin,
    });

    console.log(`✅ AI-Agent-DLMM ready. Balance: ${balance} SOL`);
  } catch (e) {
    console.error('Boot error:', e.message);
  }
}, 2000);
