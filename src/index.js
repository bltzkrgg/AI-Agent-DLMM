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
import { getConfig, updateConfig, isConfigKeySupported } from './config.js';
import { runLinearLoop, stopLoop, setNotifyFn, isRunning, getCurrentPosition } from './agents/hunterAlpha.js';
import { exitPosition, getActivePositionCount, EP_CONFIG } from './sniper/evilPanda.js';
import { validateRuntimeEnv }             from './runtime/env.js';
import { safeNum, escapeHTML }            from './utils/safeJson.js';
import { initializeRpcManager }           from './utils/helius.js';
import { createMessageTransport }         from './telegram/messageTransport.js';

// ── PID Lock — cegah multiple instance ───────────────────────────
const PID_FILE = new URL('../../bot.pid', import.meta.url).pathname;
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
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, opts).catch(() => {});
  }
  for (let i = 0; i < text.length; i += MAX) {
    await bot.sendMessage(chatId, text.slice(i, i + MAX), opts).catch(() => {});
  }
}

// ── Notify helper ─────────────────────────────────────────────────
const CHAT_ID = ALLOWED_ID; // bot hanya punya satu user

async function notify(msg, opts = {}) {
  try {
    await sendLong(CHAT_ID, msg, { parse_mode: 'HTML', ...opts });
  } catch {}
}

// Register notify ke hunterAlpha
setNotifyFn(notify);

// ── Commands ──────────────────────────────────────────────────────

function guard(msg) {
  return msg.from?.id === ALLOWED_ID;
}

// /start — daftar command
bot.onText(/\/start/, (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id,
    `🤖 <b>Linear Sniper Bot</b>\n\n` +
    `<b>Commands:</b>\n` +
    `/status    — Status posisi aktif\n` +
    `/hunt      — Mulai loop sniper\n` +
    `/stop      — Hentikan loop + exit posisi\n` +
    `/exit      — Force exit posisi aktif\n` +
    `/balance   — Saldo wallet\n` +
    `/config    — Tampilkan config saat ini\n` +
    `/setconfig — Ubah config (key value)\n` +
    `/dryrun    — Toggle dry run mode`,
    { parse_mode: 'HTML' }
  );
});

// /status — status posisi saat ini
bot.onText(/\/status/, async (msg) => {
  if (!guard(msg)) return;
  const chatId   = msg.chat.id;
  const running  = isRunning();
  const posKey   = getCurrentPosition();
  const balance  = await getWalletBalance();
  const cfg      = getConfig();

  let posLine = 'Tidak ada posisi aktif.';
  if (posKey) {
    posLine = `Posisi: <code>${posKey.slice(0,16)}...</code>`;
  }

  bot.sendMessage(chatId,
    `📊 <b>Linear Sniper Status</b>\n\n` +
    `Loop: <code>${running ? '▶ RUNNING' : '⏹ STOPPED'}</code>\n` +
    `${posLine}\n` +
    `Balance: <code>${balance} SOL</code>\n` +
    `Deploy Amount: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
    `TP: <code>+${EP_CONFIG.TAKE_PROFIT_PCT}%</code> | SL: <code>-${EP_CONFIG.STOP_LOSS_PCT}%</code>`,
    { parse_mode: 'HTML' }
  );
});

// /hunt — mulai loop
bot.onText(/\/hunt/, async (msg) => {
  if (!guard(msg)) return;
  if (isRunning()) {
    bot.sendMessage(msg.chat.id, '⚠️ Loop sudah berjalan.', { parse_mode: 'HTML' });
    return;
  }
  bot.sendMessage(msg.chat.id, '▶️ <b>Memulai Linear Sniper Loop...</b>', { parse_mode: 'HTML' });
  runLinearLoop().catch(e => {
    notify(`❌ <b>Loop crash:</b>\n<code>${escapeHTML(e.message)}</code>`);
  });
});

// /stop — hentikan loop (tidak force exit posisi)
bot.onText(/\/stop$/, async (msg) => {
  if (!guard(msg)) return;
  stopLoop();
  bot.sendMessage(msg.chat.id,
    `⏹ <b>Stop signal dikirim.</b>\n\n` +
    `Loop akan berhenti setelah siklus saat ini selesai.\n` +
    `Gunakan <code>/exit</code> untuk force-close posisi aktif.`,
    { parse_mode: 'HTML' }
  );
});

// /exit — force exit posisi aktif sekarang
bot.onText(/\/exit/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const posKey = getCurrentPosition();

  if (!posKey) {
    bot.sendMessage(chatId, 'ℹ️ Tidak ada posisi aktif untuk di-exit.', { parse_mode: 'HTML' });
    return;
  }

  bot.sendMessage(chatId, `⏳ <b>Force exit posisi</b> <code>${posKey.slice(0,8)}</code>...`, { parse_mode: 'HTML' });

  try {
    stopLoop();
    const { solRecovered } = await exitPosition(posKey, 'MANUAL_COMMAND');
    const balance = await getWalletBalance();
    bot.sendMessage(chatId,
      `✅ <b>Posisi di-exit.</b>\n` +
      `Position: <code>${posKey.slice(0,8)}</code>\n` +
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

// /config — tampilkan config flat saat ini
bot.onText(/\/config/, (msg) => {
  if (!guard(msg)) return;
  const cfg = getConfig();
  const lines = [
    `deployAmountSol       = ${cfg.deployAmountSol}`,
    `allowedBinSteps       = ${JSON.stringify(cfg.allowedBinSteps || [100,125])}`,
    `minVolume24h          = ${cfg.minVolume24h}`,
    `minMcap               = ${cfg.minMcap}`,
    `maxPoolAgeHours       = ${cfg.maxPoolAgeHours}`,
    `meteoraDiscoveryLimit = ${cfg.meteoraDiscoveryLimit}`,
    `gmgnMinTotalFeesSol   = ${cfg.gmgnMinTotalFeesSol}`,
    `dryRun                = ${cfg.dryRun}`,
    `autonomyMode          = ${cfg.autonomyMode}`,
  ];
  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Config (Flat)</b>\n\n<pre><code>${lines.join('\n')}</code></pre>`,
    { parse_mode: 'HTML' }
  );
});

// /setconfig key value — ubah config
bot.onText(/\/setconfig(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const key    = match[1]?.trim();
  const rawVal = match[2]?.trim();

  if (!key || !rawVal) {
    bot.sendMessage(chatId, `ℹ️ Gunakan: <code>/setconfig key value</code>`, { parse_mode: 'HTML' });
    return;
  }
  if (!isConfigKeySupported(key)) {
    bot.sendMessage(chatId, `❌ Key <code>${escapeHTML(key)}</code> tidak dikenal.`, { parse_mode: 'HTML' });
    return;
  }

  let parsed;
  if (rawVal === 'true')  parsed = true;
  else if (rawVal === 'false') parsed = false;
  else if (!isNaN(rawVal))     parsed = parseFloat(rawVal);
  else                         parsed = rawVal;

  const result = updateConfig({ [key]: parsed });
  bot.sendMessage(chatId,
    `✅ <code>${escapeHTML(key)}</code> → <code>${result[key]}</code>`,
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

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down...`);
  stopLoop();
  const posKey = getCurrentPosition();
  if (posKey) {
    await notify(`⚠️ <b>Bot shutdown (${signal})</b>\n\nPosisi aktif: <code>${posKey.slice(0,8)}</code>\n<i>Posisi TIDAK ditutup otomatis — cek on-chain!</i>`).catch(() => {});
  } else {
    await notify(`🛑 <b>Bot shutdown (${signal})</b>\nTidak ada posisi aktif.`).catch(() => {});
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
    const balance = await getWalletBalance();
    const cfg     = getConfig();

    await notify(
      `🚀 <b>Linear Sniper Bot dimulai!</b>\n\n` +
      `💰 Balance: <code>${balance} SOL</code>\n` +
      `📐 Deploy: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
      `🎯 TP: <code>+${EP_CONFIG.TAKE_PROFIT_PCT}%</code> | SL: <code>-${EP_CONFIG.STOP_LOSS_PCT}%</code>\n` +
      `🔍 DryRun: <code>${cfg.dryRun ? 'ON' : 'OFF'}</code>\n\n` +
      `Ketik /hunt untuk memulai loop, /start untuk daftar command.`
    );

    console.log(`✅ Linear Sniper Bot ready. Balance: ${balance} SOL`);
  } catch (e) {
    console.error('Boot error:', e.message);
  }
}, 2000);
