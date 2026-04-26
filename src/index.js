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
import { runLinearLoop, stopLoop, setNotifyFn, isRunning, getCurrentPosition } from './agents/hunterAlpha.js';
import { exitPosition, getActivePositionCount, EP_CONFIG } from './sniper/evilPanda.js';
import { discoverHighFeePoolsMeridian, runMeridianVeto } from './market/meridianVeto.js';
import { analyzePerformance, formatEvolutionReport }     from './learn/statelessEvolve.js';
import { generateBriefing }                              from './telegram/briefing.js';
import { readBlacklist, removeFromBlacklist }            from './learn/tokenBlacklist.js';
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
    `/screening — Scan manual top pool sekarang\n` +
    `/evolve    — Analisis harvest.log + saran config\n` +
    `/stop      — Hentikan loop\n` +
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
    `minVolume24h          = ${cfg.minVolume24h}`,
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

  bot.sendMessage(msg.chat.id,
    `⚙️ <b>Config Aktif</b>\n\n` +
    `<b>💰 Finance</b>\n<pre><code>${finance}</code></pre>\n` +
    `<b>🔍 Discovery</b>\n<pre><code>${discovery}</code></pre>\n` +
    `<b>🎯 Strategy</b>\n<pre><code>${strategy}</code></pre>\n` +
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

bot.onText(/\/setconfig(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
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
      `<i>Contoh:\n` +
      `/setconfig deployAmountSol 1.5\n` +
      `/setconfig discovery.timeframe 1h\n` +
      `/setconfig autoScreeningEnabled false\n` +
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
        runScreeningLoop();
        bot.sendMessage(chatId,
          `📡 <b>Auto-Screening: ON</b>\n` +
          `Loop dimulai — interval <code>${result.screeningIntervalMin || 15} menit</code>.\n\n` +
          `<i>Screening pertama akan berjalan dalam 30 detik.</i>`,
          { parse_mode: 'HTML' }
        );
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
    `✅ <b>Config diupdate!</b>\n\n` +
    `Kunci  : <code>${escapeHTML(flatKey)}</code>\n` +
    `Sebelum: <code>${escapeHTML(String(before))}</code>\n` +
    `Sesudah: <code>${escapeHTML(String(after))}</code>\n\n` +
    `<i>${meta.desc}</i>\n` +
    `<i>Efektif di siklus loop berikutnya — tidak perlu restart.</i>`,
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
    `🧠 <b>Evolve — Menganalisis harvest.log...</b>\n` +
    `<i>Mengirim data ke ${getConfig().agentModel || 'Agent Model'}...</i>\n` +
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
bot.onText(/\/screening/, async (msg) => {
  if (!guard(msg)) return;
  const chatId = msg.chat.id;
  const cfg    = getConfig();

  bot.sendMessage(chatId,
    `🔍 <b>Scanning top pools...</b>\nLimit: <code>${cfg.meteoraDiscoveryLimit}</code> pool`,
    { parse_mode: 'HTML' }
  );

  try {
    const pools = await discoverHighFeePoolsMeridian({ limit: cfg.meteoraDiscoveryLimit });

    if (!pools || pools.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada pool ditemukan saat ini.', { parse_mode: 'HTML' });
      return;
    }

    // Urutkan fee_active_tvl_ratio tertinggi, ambil top 5
    const top5 = [...pools]
      .sort((a, b) => (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))
      .slice(0, 5);

    const lines = await Promise.all(top5.map(async (pool, i) => {
      const symbol  = pool.name || pool.tokenXMint?.slice(0, 8) || 'UNKNOWN';
      const ratio   = ((pool.feeActiveTvlRatio || 0) * 100).toFixed(2);
      const tvl     = safeNum(pool.tvl || pool.liquidity, 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const binStep = pool.binStep || '?';

      // Cek Meridian Supertrend — fail-open jika error
      let stIcon = '⚪';
      try {
        const veto = await runMeridianVeto(pool.tokenXMint || pool.address, pool);
        if (veto.pass) stIcon = '🟢';
        else           stIcon = `🔴 ${veto.reason || ''}`.trim();
      } catch {
        stIcon = '⚪ (API skip)';
      }

      return (
        `<b>${i + 1}. ${escapeHTML(symbol)}</b> [${binStep}]\n` +
        `   Fee/TVL: <code>${ratio}%</code> | TVL: <code>$${tvl}</code>\n` +
        `   Meridian: ${stIcon}`
      );
    }));

    await sendLong(chatId,
      `📊 <b>Top 5 High-Fee Pools</b>\n` +
      `<i>Sorted by Fee/Active-TVL Ratio</i>\n\n` +
      lines.join('\n\n'),
      { parse_mode: 'HTML' }
    );

  } catch (e) {
    bot.sendMessage(chatId,
      `❌ <b>Screening error:</b>\n<code>${escapeHTML(e.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── Screening Loop ─────────────────────────────────────────────────
// Berjalan independen dari runLinearLoop.
// Kirim "Hot Prospect Alert" jika ada pool dengan feeActiveTvlRatio tinggi.

const HOT_FEE_RATIO_THRESHOLD = 0.05; // 5% fee/TVL/hari = sangat aktif
let   _screeningLoopTimer = null;

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
      const limit = Number(cfg.meteoraDiscoveryLimit) || 180;
      const pools = await discoverHighFeePoolsMeridian({ limit });
      if (!pools?.length) return;

      // Filter hanya pool yang benar-benar hot
      const hotPools = pools
        .filter(p => (p.feeActiveTvlRatio || 0) >= HOT_FEE_RATIO_THRESHOLD)
        .sort((a, b) => (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))
        .slice(0, 3);

      if (hotPools.length === 0) return;

      const lines = hotPools.map((p, i) => {
        const sym   = p.name || p.tokenXMint?.slice(0, 8) || 'UNKNOWN';
        const ratio = ((p.feeActiveTvlRatio || 0) * 100).toFixed(2);
        const tvl   = safeNum(p.tvl || p.liquidity, 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
        return `${i + 1}. <b>${escapeHTML(sym)}</b> — <code>${ratio}%</code> fee/TVL | TVL: <code>$${tvl}</code>`;
      });

      await notify(
        `🔥 <b>Hot Prospect Alert!</b>\n` +
        `<i>${hotPools.length} pool di atas threshold ${(HOT_FEE_RATIO_THRESHOLD * 100).toFixed(0)}% fee/TVL</i>\n\n` +
        lines.join('\n') +
        `\n\n<i>Ketik /hunt untuk mulai loop atau /screening untuk detail.</i>`
      );
    } catch (e) {
      console.warn('[screening-loop] error:', e.message);
    }
  };

  // Jalankan pertama kali setelah 30 detik, lalu per interval dari config
  setTimeout(tick, 30_000);
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
  stopLoop();
  stopScreeningLoop();
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
    const autoScr = cfg.autoScreeningEnabled;

    // Log startup Jupiter
    console.log(`✅ Jupiter V1 Direct — api.jup.ag/swap/v1 (fallback: lite-api.jup.ag)`);

    await notify(
      `🚀 <b>Linear Sniper Bot dimulai!</b>\n\n` +
      `💰 Balance: <code>${balance} SOL</code>\n` +
      `📐 Deploy: <code>${cfg.deployAmountSol || 0.1} SOL</code>\n` +
      `🎯 TP: <code>+${EP_CONFIG.TAKE_PROFIT_PCT}%</code> | SL: <code>-${EP_CONFIG.STOP_LOSS_PCT}%</code>\n` +
      `🔍 DryRun: <code>${cfg.dryRun ? 'ON' : 'OFF'}</code>\n` +
      `📡 Auto Screening: <code>${autoScr ? `ON (${cfg.screeningIntervalMin}m)` : 'OFF'}</code>\n` +
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
