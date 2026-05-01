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
import { runLinearLoop, stopLoop, setNotifyFn, isRunning, getCurrentPosition, getActivePositions, setShutdownInProgress, closeAllActivePositionsByUser, closeAllActivePositionsForShutdown, retryFailedShutdownPositions, runAutoscreening, spawnMonitorForRestoredPositions, startManualCloseWatcher } from './agents/hunterAlpha.js';
import { getActivePositionCount, reconcileStartupPositions, EP_CONFIG } from './sniper/evilPanda.js';
import { analyzePerformance, formatEvolutionReport }     from './learn/statelessEvolve.js';
import { generateBriefing, formatActivePositionsTelegram } from './telegram/briefing.js';
import { readBlacklist, removeFromBlacklist }            from './learn/tokenBlacklist.js';
import { validateRuntimeEnv }             from './runtime/env.js';
import { safeNum, escapeHTML }            from './utils/safeJson.js';
import { initializeRpcManager }           from './utils/helius.js';
import { createMessageTransport }         from './telegram/messageTransport.js';
import { getTodayResults }                from './db/database.js';

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

async function urgentNotify(msg) {
  await notify(msg);
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
    `/screening   — Scan manual top pool sekarang\n` +
    `/autoscreen  — Toggle auto-screening (on/off)\n` +
    `/evole       — Analisis harvest.log + saran config terbaru\n` +
    `/stop        — Hentikan loop\n` +
    `/exit        — Force exit posisi aktif\n` +
    `/balance     — Saldo wallet\n` +
    `/config      — Tampilkan config saat ini\n` +
    `/setconfig   — Ubah config (key value)\n` +
    `/dryrun      — Toggle dry run mode`,
    { parse_mode: 'HTML' }
  );
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
    `TP: <code>RSI(2) ≥ ${cfg.smartExitRsi || 90}</code> | SL: <code>-${cfg.stopLossPct || 10}%</code>`,
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
    const summary = await closeAllActivePositionsByUser('MANUAL_COMMAND', 180_000);
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
    `discoveryTimeframe    = ${cfg.discoveryTimeframe}`,
    `discoveryCategory     = ${cfg.discoveryCategory}`,
    `minTvl                = ${cfg.minTvl}`,
    `maxTvl                = ${cfg.maxTvl}`,
    `minVolume          = ${cfg.minVolume}`,
    `minHolders            = ${cfg.minHolders}`,
    `minOrganic            = ${cfg.minOrganic}`,
    `maxPoolAgeDays        = ${cfg.maxPoolAgeDays}`,
  ].join('\n');
  const strategy = [
    `stopLossPct           = ${cfg.stopLossPct}`,
    `trailingStopPct       = ${cfg.trailingStopPct}`,
    `atrGuardEnabled       = ${cfg.atrGuardEnabled}`,
    `atrMultiplier         = ${cfg.atrMultiplier}`,
    `dryRun                = ${cfg.dryRun}`,
    `autoScreeningEnabled  = ${cfg.autoScreeningEnabled}`,
    `screeningIntervalMin  = ${cfg.screeningIntervalMin}`,
  ].join('\n');
  const management = [
    `managementIntervalMin = ${cfg.managementIntervalMin}`,
    `positionUpdateMin     = ${cfg.positionUpdateIntervalMin}`,
    `realtimePnlSec        = ${cfg.realtimePnlIntervalSec}`,
  ].join('\n');

  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Config Aktif</b>\n\n` +
    `<b>💰 Finance</b>\n<pre><code>${finance}</code></pre>\n` +
    `<b>🔍 Discovery</b>\n<pre><code>${discovery}</code></pre>\n` +
    `<b>🎯 Strategy</b>\n<pre><code>${strategy}</code></pre>\n` +
    `<b>🩺 Management</b>\n<pre><code>${management}</code></pre>\n` +
    `<i>Edit: /setconfig ? untuk lihat key yang bisa diubah</i>`,
    { parse_mode: 'HTML' }
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
    const bySection = (section) => Object.entries(SETCONFIG_WHITELIST)
      .filter(([, m]) => m.section === section)
      .map(([k, m]) => `  <code>${k}</code> — ${m.desc}`)
      .join('\n');

    bot.sendMessage(chatId,
      `⚙️ <b>/setconfig — Kunci yang Bisa Diubah</b>\n\n` +
      `Format: <code>/setconfig [key] [value]</code>\n` +
      `atau:   <code>/setconfig [section].[key] [value]</code>\n\n` +
      `<b>💰 Finance:</b>\n${bySection('finance')}\n\n` +
      `<b>🔍 Discovery:</b>\n${bySection('discovery')}\n\n` +
      `<b>📡 Screening:</b>\n${bySection('screening')}\n\n` +
      `<b>🩺 Management:</b>\n${bySection('management')}\n\n` +
      `<i>Contoh:\n` +
      `/setconfig deployAmountSol 1.5\n` +
      `/setconfig discovery.timeframe 1h\n` +
      `/setconfig autoScreeningEnabled false\n` +
      `/setconfig realtimePnlIntervalSec 15\n` +
      `/setconfig screeningIntervalMin 30</i>`,
      { parse_mode: 'HTML' }
    );
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
      `❌ Key <code>${escapeHTML(rawKey)}</code> tidak dikenali atau tidak diizinkan.\n` +
      `Lihat daftar key: <code>/setconfig ?</code>`,
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
    if (after === true) {
      // Start loop jika belum berjalan
      if (!_screeningLoopTimer) {
        await bot.sendMessage(chatId,
          `📡 <b>Auto-Screening: ON</b>\n` +
          `Loop dimulai — interval <code>${result.screeningIntervalMin || 15} menit</code>.\n\n` +
          `<i>Memulai scan pertama sekarang...</i>`,
          { parse_mode: 'HTML' }
        );
        await runAutoscreening(bot, chatId);
        runScreeningLoop();
      } else {
        bot.sendMessage(chatId,
          `📡 <b>Auto-Screening: ON</b>\n` +
          `Loop sudah berjalan — interval <code>${result.screeningIntervalMin || 15} menit</code>.`,
          { parse_mode: 'HTML' }
        );
      }
    } else {
      // Stop loop
      stopScreeningLoop();
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

  if (after === true) {
    await bot.sendMessage(chatId,
      `📡 <b>Auto-Screening: ON</b>\n🔍 Memulai inisialisasi scan real-time sekarang...`,
      { parse_mode: 'HTML' }
    );
    // EKSEKUSI LANGSUNG (Fire & Forget, langsung scan saat itu juga)
    runAutoscreening(bot, chatId);
    if (!isRunning()) {
      runLinearLoop().catch((e) => {
        notify(`❌ <b>Loop crash:</b>\n<code>${escapeHTML(e.message)}</code>`);
      });
    }
  } else {
    // config autoScreeningEnabled=false akan menghentikan rekursif loop secara otomatis.
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

// ── /evole — analisis harvest.log + rekomendasi LLM ─────────────
// /evole        → preview rekomendasi (tidak ubah config)
// /evole apply  → preview + auto-apply perubahan ke user-config.json
// Alias lama /evolve tetap didukung untuk kompatibilitas.

bot.onText(/\/(?:evole|evolve)(?:\s+(apply))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const chatId    = msg.chat.id;
  const autoApply = match[1]?.toLowerCase() === 'apply';

  await bot.sendMessage(chatId,
    `🧠 <b>Evole — Menganalisis config terbaru...</b>\n` +
    `<i>Mengirim snapshot config & performa ke ${getConfig().agentModel || 'Agent Model'}...</i>\n` +
    (autoApply ? `⚡ Mode: <b>AUTO-APPLY</b>` : `👁 Mode: <b>Preview</b> (gunakan /evole apply untuk terapkan)`),
    { parse_mode: 'HTML' }
  );

  try {
    const result = await analyzePerformance({ maxEntries: 50, autoApply });
    const report = formatEvolutionReport(result);
    await sendLong(chatId, report, { parse_mode: 'HTML' });

    // Jika preview dan ada rekomendasi, tawari apply
    if (!autoApply && result.ok && result.recommendations.length > 0) {
      await bot.sendMessage(chatId,
        `💬 <i>Setuju dengan rekomendasi di atas?\nKetik <code>/evole apply</code> untuk menerapkan perubahan ke config.</i>`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    bot.sendMessage(chatId,
      `❌ <b>Evole error:</b>\n<code>${escapeHTML(e.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── /screening — scan manual top pool sekarang ────────────────────
bot.onText(/\/screening/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  await runAutoscreening(bot, chatId);
});

// /strategy_report — compatibility command for legacy telemetry tooling
bot.onText(/\/strategy_report/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const cfg = getConfig();
  const text =
    `📘 <b>Strategy Report</b>\n\n` +
    `Strategy: <code>${cfg.activeStrategy || 'Evil Panda'}</code>\n` +
    `Deploy: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
    `TP: <code>RSI(2) ≥ ${cfg.smartExitRsi || 90}</code> | SL: <code>${cfg.stopLossPct || 10}%</code>\n` +
    `Trailing: <code>${cfg.trailingStopPct || 5}%</code>\n` +
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
let _lastDailyLossAlertAt = 0;

async function runScreeningLoop() {
  // Baca config FRESH saat start (bukan dari closure lama)
  const startCfg   = getConfig();
  if (!startCfg.autoScreeningEnabled) {
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

    // Guard: hentikan diri sendiri jika dinonaktifkan via /setconfig
    if (!cfg.autoScreeningEnabled) {
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
}

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down...`);
  setShutdownInProgress(true);
  stopLoop();
  stopScreeningLoop();
  const active = Array.isArray(getActivePositions()) ? getActivePositions() : [];
  if (active.length > 0) {
    await notify(
      `⚠️ <b>Bot shutdown (${signal})</b>\n` +
      `Menutup <code>${active.length}</code> posisi aktif sebelum exit...`
    ).catch(() => {});
    const summary = await closeAllActivePositionsForShutdown(signal, 10_000);
    if (summary.failed.length > 0) {
      await notify(
        `⚠️ <b>Shutdown close partial</b>\n` +
        `Closed: <code>${summary.closed}/${summary.total}</code>\n` +
        `Retrying failed closes once...`
      ).catch(() => {});

      const retry = await retryFailedShutdownPositions(summary.failed, signal, 10_000);
      if (retry.stillFailed.length > 0) {
        const failedStr = retry.stillFailed.map((f) => `${f.pubkey.slice(0,8)}:${f.reason || 'FAILED'}`).join(', ');
        await notify(
          `⚠️ <b>Shutdown close final partial</b>\n` +
          `Recovered on retry: <code>${retry.recovered}/${retry.retried}</code>\n` +
          `Still failed: <code>${failedStr}</code>\n` +
          `<i>Cek posisi on-chain untuk verifikasi final.</i>`
        ).catch(() => {});
      } else {
        await notify(
          `✅ <b>Shutdown retry success</b>\n` +
          `Recovered: <code>${retry.recovered}/${retry.retried}</code>\n` +
          `Semua posisi berhasil ditutup.`
        ).catch(() => {});
      }
    } else {
      await notify(`✅ <b>Shutdown close complete</b>\nClosed: <code>${summary.closed}/${summary.total}</code>`).catch(() => {});
    }
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
    const reconcile = await reconcileStartupPositions();
    const restoredMonitors = spawnMonitorForRestoredPositions();
    const manualCloseWatcherStarted = startManualCloseWatcher();
    const balance = await getWalletBalance();
    const cfg     = getConfig();
    const autoScr = cfg.autoScreeningEnabled;

    // Log startup Jupiter
    console.log(`✅ Jupiter V1 Direct — api.jup.ag/swap/v1 (fallback: lite-api.jup.ag)`);

    await notify(
      `🚀 <b>Linear Sniper Bot dimulai!</b>\n\n` +
      `♻️ Reconcile: <code>${reconcile.restored}/${reconcile.scanned}</code> posisi dipulihkan\n` +
      `🩺 Restored Monitor: <code>${restoredMonitors}</code> loop aktif\n` +
      `👁️ Manual Close Watcher: <code>${manualCloseWatcherStarted ? 'ON' : 'ALREADY_ON'}</code>\n` +
      `💰 Balance: <code>${balance} SOL</code>\n` +
      `📐 Deploy: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
      `🎯 TP: <code>RSI(2) ≥ ${cfg.smartExitRsi || 90}</code> | SL: <code>-${cfg.stopLossPct || 10}%</code>\n` +
      `🔍 DryRun: <code>${cfg.dryRun ? 'ON' : 'OFF'}</code>\n` +
      `📡 Auto Screening: <code>${autoScr ? `ON (${cfg.screeningIntervalMin}m)` : 'OFF'}</code>\n` +
      `📊 Realtime PnL: <code>${cfg.realtimePnlIntervalSec || 15}s</code>\n` +
      `⚡ API Engine: <code>Jupiter V1 Direct (api.jup.ag/swap/v1)</code>\n\n` +
      `Ketik /hunt untuk mulai loop, /screening untuk scan manual.`
    );

    // Auto-start screening loop jika diaktifkan
    if (autoScr) runScreeningLoop();

    console.log(`✅ Linear Sniper Bot ready. Balance: ${balance} SOL`);
  } catch (e) {
    console.error('Boot error:', e.message);
  }
}, 2000);
