import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { initSolana, getWalletBalance } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons } from './learn/lessons.js';
import { getConfig, getThresholds, updateConfig } from './config.js';
import { handleConfirmationReply, getSafetyStatus } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/coinfilter.js';
import { getOpenPositions, getPositionStats } from './db/database.js';
import { getPositionInfo } from './solana/meteora.js';
import { initMonitor } from './monitor/positionMonitor.js';
import { autoEvolveIfReady } from './learn/evolve.js';
import { getTodayResults, formatDailyReport, savePerformanceSnapshot, backupAllData } from './market/strategyPerformance.js';
import { runStartupModelCheck, formatModelStatus } from './agent/modelCheck.js';

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
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });

// ─── Validate env ────────────────────────────────────────────────
const required = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_ID', 'OPENROUTER_API_KEY', 'SOLANA_RPC_URL', 'WALLET_PRIVATE_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in all values.');
  process.exit(1);
}

const ALLOWED_ID = parseInt(process.env.ALLOWED_TELEGRAM_ID);
if (isNaN(ALLOWED_ID)) {
  console.error('❌ ALLOWED_TELEGRAM_ID must be a numeric Telegram user ID');
  process.exit(1);
}

let solanaReady = false;
try {
  initSolana();
  solanaReady = true;
} catch (e) {
  console.warn(`⚠️ Solana wallet init failed: ${e.message}`);
  console.warn('Bot will start but trading features will be disabled until wallet is fixed.');
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const cfg = getConfig();
initMonitor(bot, ALLOWED_ID);

console.log(`🦞 Meteora DLMM Bot started! Mode: LIVE`);

const TG_MAX = 4000; // Telegram limit 4096, sisakan buffer untuk formatting

// Potong teks panjang menjadi chunks di batas baris
function splitText(text) {
  if (text.length <= TG_MAX) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX) { chunks.push(remaining); break; }
    let cutAt = remaining.lastIndexOf('\n', TG_MAX);
    if (cutAt < TG_MAX * 0.5) cutAt = TG_MAX;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

// Kirim dengan Markdown, fallback ke plain text kalau Telegram reject
async function sendLong(chatId, text, opts = {}) {
  const chunks = splitText(String(text));
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, opts);
    } catch (e) {
      // Kalau Markdown error, kirim ulang tanpa formatting
      if (e.message?.includes('parse') || e.message?.includes('Bad Request')) {
        try {
          const plainOpts = { ...opts };
          delete plainOpts.parse_mode;
          await bot.sendMessage(chatId, chunk, plainOpts);
        } catch (e2) {
          console.error('sendLong fallback error:', e2.message);
        }
      } else {
        console.error('sendLong error:', e.message);
      }
    }
  }
}

// Fire-and-forget notify — tidak pernah throw, tidak pernah crash agent
async function notify(text) {
  sendLong(ALLOWED_ID, String(text), { parse_mode: 'Markdown', disable_web_page_preview: true })
    .catch(e => console.error('Notify error:', e.message));
}

// ─── Busy flags — cegah 2 cycle jalan bersamaan ──────────────────
let _hunterBusy = false;
let _healerBusy = false;

// ─── Post-close reopen confirmation ──────────────────────────────
// Setelah Healer menutup posisi, Hunter diblokir sampai user konfirmasi
let _waitingReopenConfirmation = false;
let _reopenConfirmTimeout = null;

function clearReopenConfirmation() {
  _waitingReopenConfirmation = false;
  if (_reopenConfirmTimeout) {
    clearTimeout(_reopenConfirmTimeout);
    _reopenConfirmTimeout = null;
  }
}

// ─── Setup state — dipakai oleh wizard /entry ────────────────────
const setupState = {
  phase: 'done', // bot langsung jalan; wizard hanya aktif saat /entry
  solPerPool: null,
  poolCount: null,
};

async function triggerHunter() {
  if (_hunterBusy) return;
  if (_waitingReopenConfirmation) {
    console.log('⏭ Hunter skip — menunggu konfirmasi reopen dari user');
    return;
  }
  const liveCfg = getConfig();
  const openPos = getOpenPositions();
  if (openPos.length >= liveCfg.maxPositions) {
    console.log(`⏭ Hunter skip — posisi penuh (${openPos.length}/${liveCfg.maxPositions})`);
    return;
  }
  _hunterBusy = true;
  try { await runHunterAlpha(notify, bot, ALLOWED_ID); }
  catch (e) { notify(`❌ Hunter error: ${e.message}`).catch(() => {}); }
  finally { _hunterBusy = false; }
}

// Jalankan Healer — jika ada posisi ditutup, minta konfirmasi reopen
async function runHealerWithReopenCheck() {
  const beforeCount = getOpenPositions().length;
  await runHealerAlpha(notify);
  const afterCount = getOpenPositions().length;

  if (afterCount < beforeCount) {
    // Satu atau lebih posisi ditutup — minta konfirmasi sebelum buka baru
    _waitingReopenConfirmation = true;

    // Auto-expire setelah 30 menit — bot kembali normal tanpa deploy
    _reopenConfirmTimeout = setTimeout(() => {
      if (_waitingReopenConfirmation) {
        _waitingReopenConfirmation = false;
        notify('⏱️ Konfirmasi reopen expired. Bot menunggu /hunt manual untuk buka posisi baru.').catch(() => {});
      }
    }, 30 * 60 * 1000);

    const closedCount = beforeCount - afterCount;
    await bot.sendMessage(ALLOWED_ID,
      `✅ *${closedCount} posisi berhasil ditutup*\n\n` +
      `💰 Sisa posisi terbuka: ${afterCount}\n\n` +
      `🤔 *Apakah Anda ingin buka posisi baru?*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Ya, Buka Posisi Baru', callback_data: 'reopen_yes' },
            { text: '❌ Tidak, Tahan Dulu',    callback_data: 'reopen_no'  },
          ]],
        },
      }
    ).catch(() => {});
  }
}

// ─── Cron jobs ───────────────────────────────────────────────────

cron.schedule(`*/${cfg.screeningIntervalMin} * * * *`, async () => {
  if (setupState.phase !== 'done') { console.log('⏭ Hunter skip — menunggu setup awal'); return; }
  await triggerHunter();
});

cron.schedule(`*/${cfg.managementIntervalMin} * * * *`, async () => {
  if (_healerBusy) { console.log('⏭ Healer skip — masih berjalan'); return; }

  _healerBusy = true;
  try {
    await runHealerWithReopenCheck();
    // Auto-evolve threshold tiap 5 posisi closed — tanpa perlu manual
    autoEvolveIfReady(notify).catch(e => console.error('Auto-evolve error:', e.message));
    // Auto-save strategy performance snapshot ke file lokal
    savePerformanceSnapshot();
  }
  catch (e) { notify(`❌ Healer error: ${e.message}`).catch(() => {}); }
  finally { _healerBusy = false; }
});

// ─── Daily Backup jam 2 pagi ─────────────────────────────────────
cron.schedule('0 2 * * *', () => {
  try {
    savePerformanceSnapshot();
    const count = backupAllData();
    console.log(`💾 Daily backup selesai: ${count} file disimpan ke backups/`);
  } catch (e) { console.error('Daily backup error:', e.message); }
});

// ─── Daily Results Report jam 9 malam ────────────────────────────
cron.schedule('0 21 * * *', async () => {
  try {
    const results = getTodayResults();
    await notify(formatDailyReport(results));
  } catch (e) { console.error('Daily results error:', e.message); }
});

// ─── Daily Briefing jam 7 pagi ───────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    const balance  = await getWalletBalance();
    const openPos  = getOpenPositions();
    const stats    = getPositionStats();
    const memStats = getMemoryStats();
    const instincts = getInstinctsContext();

    let text = `☀️ *Daily Briefing*\n\n`;
    text += `💰 Balance: ${balance} SOL\n`;
    text += `📍 Posisi: ${openPos.length}/${getConfig().maxPositions}\n`;
    text += `📈 Closed total: ${stats.closedPositions} | Win rate: ${stats.winRate}\n`;
    text += `💵 Total PnL: $${stats.totalPnlUsd} | Fees: $${stats.totalFeesUsd}\n`;
    text += `🎯 Avg range efficiency: ${memStats.avgRangeEfficiency}\n`;
    text += `🧠 Instincts: ${memStats.instinctCount} | Evolusi: ${memStats.evolutionCount}x\n`;
    text += `🔄 Auto-evolusi terakhir: ${memStats.lastAutoEvolution ? new Date(memStats.lastAutoEvolution).toLocaleString('id-ID') : 'Belum pernah'}\n`;
    text += `🔴 Mode: LIVE`;
    if (instincts) text += `\n${instincts}`;

    await notify(text);
  } catch (e) { console.error('Daily briefing error:', e.message); }
});

cron.schedule('0 * * * *', async () => {
  try {
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const stats = getPositionStats();
    const memStats = getMemoryStats();
    await notify(
      `📊 *Hourly Health Check*\n\n` +
      `💰 Balance: ${balance} SOL\n` +
      `📍 Posisi: ${openPos.length}/${getConfig().maxPositions}\n` +
      `📈 Closed: ${stats.closedPositions} | Win rate: ${stats.winRate}\n` +
      `🧠 Instincts: ${memStats.instinctCount}`
    );
  } catch (e) { console.error('Health check error:', e.message); }
});

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/testmodel/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '🔍 Testing model...');
  try {
    const text = await formatModelStatus();
    await sendLong(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

bot.onText(/\/results/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  try {
    const results = getTodayResults();
    await sendLong(msg.chat.id, formatDailyReport(results), { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id,
    `🦞 *Meteora DLMM Bot* \`[LIVE]\`\n\n` +
    `🦅 Hunter — screening tiap ${cfg.screeningIntervalMin}min\n` +
    `🩺 Healer — manage posisi tiap ${cfg.managementIntervalMin}min\n\n` +
    `*Commands:*\n` +
    `/entry — set SOL & jumlah pool, lalu deploy\n` +
    `/status /pools /hunt /heal\n` +
    `/testmodel — cek & ganti model AI\n` +
    `/results — hasil hari ini per strategi\n` +
    `/check <mint> — screen token scam\n` +
    `/strategies /addstrategy <pw>\n` +
    `/library /research\n` +
    `/learn [pool] /lessons\n` +
    `/memory /evolve\n` +
    `/thresholds /safety\n\n` +
    `Atau chat bebas langsung!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/entry/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  setupState.phase = 'waiting_sol';
  setupState.solPerPool = null;
  setupState.poolCount = null;
  bot.sendMessage(msg.chat.id,
    `❓ *Berapa SOL Per Pool?*\n\n_Jumlah SOL yang di-deploy ke SETIAP pool.\nContoh: \`0.1\` = 0.1 SOL per posisi_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const [balance, openPos, stats] = await Promise.all([
      getWalletBalance(),
      Promise.resolve(getOpenPositions()),
      Promise.resolve(getPositionStats()),
    ]);

    let text = `📊 *Status Bot*\n\n`;
    text += `💰 Balance: *${balance} SOL* | Mode: 🔴 LIVE\n`;
    text += `📍 Posisi terbuka: *${openPos.length}/${getConfig().maxPositions}*\n`;
    text += `📈 Closed: ${stats.closedPositions} | Win: ${stats.winRate} | Avg PnL: ${stats.avgPnl}\n\n`;

    if (openPos.length === 0) {
      text += `_Tidak ada posisi terbuka._`;
    } else {
      for (const pos of openPos) {
        // Coba ambil status on-chain (best-effort)
        let rangeStatus = '⏳ loading...';
        try {
          const onChain = await getPositionInfo(pos.pool_address);
          const match = onChain?.find(p => p.address === pos.position_address);
          if (match) {
            rangeStatus = match.inRange ? '✅ In Range' : '⚠️ Out of Range';
          } else {
            rangeStatus = '❓ Tidak ditemukan on-chain';
          }
        } catch { rangeStatus = '⚠️ Gagal cek on-chain'; }

        const openedAt = new Date(pos.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        text += `*Posisi \`${pos.position_address.slice(0, 8)}...\`*\n`;
        text += `  🏊 Pool: \`${pos.pool_address.slice(0, 8)}...${pos.pool_address.slice(-4)}\`\n`;
        text += `  📊 Strategi: ${pos.strategy_used || 'default'}\n`;
        text += `  💰 Deploy: ${pos.deployed_sol > 0 ? pos.deployed_sol + ' SOL' : '$' + (pos.deployed_usd || 0)}\n`;
        text += `  📡 Status: ${rangeStatus}\n`;
        text += `  🕐 Dibuka: ${openedAt}\n\n`;
      }
    }

    await sendLong(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/pools/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Analisa dan tampilkan 5 pool DLMM terbaik berdasarkan fee APR saat ini');
});

bot.onText(/\/hunt/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '🦅 Menjalankan Hunter Alpha...');
  try { await runHunterAlpha(notify, bot, ALLOWED_ID); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

bot.onText(/\/heal/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '🩺 Menjalankan Healer Alpha...');
  try { await runHealerWithReopenCheck(); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

// ─── Inline keyboard callbacks ────────────────────────────────────

bot.on('callback_query', async (query) => {
  if (query.from.id !== ALLOWED_ID) return;

  if (query.data === 'reopen_yes') {
    clearReopenConfirmation();
    await bot.answerCallbackQuery(query.id, { text: 'Memulai pencarian pool baru...' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});
    await notify('🦅 Memulai Hunter Alpha — mencari pool terbaik...');
    triggerHunter().catch(e => notify(`❌ Hunter error: ${e.message}`));

  } else if (query.data === 'reopen_no') {
    clearReopenConfirmation();
    await bot.answerCallbackQuery(query.id, { text: 'Bot menunggu instruksi.' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});
    await notify('⏸️ Deploy ditahan. Ketik /hunt saat siap buka posisi baru.');
  }
});

bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const tokenMint = match[1]?.trim();
  if (!tokenMint) {
    bot.sendMessage(chatId, '⚠️ Format: `/check <token_mint>`', { parse_mode: 'Markdown' });
    return;
  }
  bot.sendMessage(chatId, `🔍 Screening \`${tokenMint.slice(0, 16)}...\``, { parse_mode: 'Markdown' });
  try {
    const result = await screenToken(tokenMint);
    bot.sendMessage(chatId, formatScreenResult(result), { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
});

bot.onText(/\/library/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const stats = getLibraryStats();
  const esc = (s) => String(s).replace(/[_*`[]/g, '\\$&');
  let text = `📚 *Strategy Library*\n\n`;
  text += `Total: ${stats.totalStrategies} | Built-in: ${stats.builtinCount} | Research: ${stats.researchedCount}\n`;
  text += `Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Belum ada'}\n\n`;
  text += `*Top Strategi:*\n`;
  stats.topStrategies.forEach((s, i) => {
    text += `${i + 1}. ${esc(s.name)} (${esc(s.type)}) — ${(s.confidence * 100).toFixed(0)}%\n`;
  });
  text += `\n_/research untuk tambah strategi dari artikel_`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
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
    `🔬 *Research Mode Aktif*\n\nPaste artikel strategi DLMM sekarang.\n_/cancel untuk batal._`,
    { parse_mode: 'Markdown' }
  );
});

async function processResearchArticle(chatId, articleText) {
  bot.sendMessage(chatId, '🔬 Menganalisa artikel...');
  const esc = (s) => String(s || '').replace(/[_*`[]/g, '\\$&');
  try {
    const summary = await summarizeArticle(articleText);
    const result = await extractStrategiesFromArticle(articleText);
    let text = `📰 *Ringkasan:*\n${esc(summary)}\n\n`;
    if (result.extracted.length === 0) {
      text += `⚠️ ${esc(result.message)}`;
    } else {
      text += `✅ *${result.extracted.length} Strategi Ditemukan:*\n\n`;
      result.extracted.forEach((s, i) => {
        text += `*${i + 1}. ${esc(s.name)}* (${esc(s.type)})\n`;
        text += `📊 Market: ${esc(s.marketConditions?.trend?.join(', '))}\n`;
        text += `🎯 Entry: ${esc(s.entryConditions)}\n`;
        text += `🚪 Exit: ${esc(s.exitConditions)}\n\n`;
      });
      text += `_Strategi aktif di Library dan akan dipakai Hunter Alpha._`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
}

bot.onText(/\/memory/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const stats = getMemoryStats();
  const instincts = getInstinctsContext();
  let text = `🧠 *Memory Stats*\n\n`;
  text += `Trades: ${stats.totalTrades} | Win rate: ${stats.winRate}\n`;
  text += `Instincts: ${stats.instinctCount} | Evolution: ${stats.evolutionCount}x\n`;
  text += `Last evolve: ${stats.lastEvolution ? new Date(stats.lastEvolution).toLocaleString() : 'Belum pernah'}\n`;
  if (instincts) text += `\n${instincts}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/evolve/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Evolving dari trading history...');
  try {
    const result = await evolveFromTrades();
    let text = `🧬 *Evolution Round ${getMemoryStats().evolutionCount}*\n\n`;
    text += `${result.summary}\n\n`;
    text += `Win rate: ${result.stats.winRate}% | Avg PnL: $${result.stats.avgPnl}\n\n`;
    if (result.appliedWeights) {
      const w = result.appliedWeights;
      text += `⚖️ *Darwin Weights Diperbarui:*\n`;
      text += `  mcap: ${w.mcap} | fee/TVL: ${w.feeActiveTvlRatio} | volume: ${w.volume} | holders: ${w.holderCount}\n\n`;
    }
    text += `*${result.newInstincts.length} Instincts Baru:*\n`;
    result.newInstincts.forEach((inst, i) => {
      text += `${i + 1}. [${(inst.confidence * 100).toFixed(0)}%] ${inst.pattern}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
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
        `✅ *${lessons.length} lessons baru:*\n\n` + lessons.map((l, i) => `${i + 1}. ${l.lesson}`).join('\n\n'),
        { parse_mode: 'Markdown' }
      );
    } else {
      const candidates = getCandidates();
      if (!candidates.length) { bot.sendMessage(chatId, '⚠️ Jalankan /hunt dulu.'); return; }
      const { lessons, errors } = await learnFromMultiplePools(candidates.slice(0, 3).map(c => c.address));
      let text = `✅ *${lessons.length} lessons dari ${Math.min(3, candidates.length)} pool:*\n\n`;
      text += lessons.slice(0, 6).map((l, i) => `${i + 1}. ${l.lesson}`).join('\n\n');
      if (errors.length) text += `\n\n⚠️ ${errors.length} pool gagal`;
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
});

bot.onText(/\/lessons/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const lessons = loadLessons();
  if (!lessons.length) { bot.sendMessage(msg.chat.id, '📭 Belum ada lessons. Jalankan /learn dulu.'); return; }
  let text = `📚 *${lessons.length} Lessons (8 terbaru):*\n\n`;
  lessons.slice(-8).forEach((l, i) => { text += `${l.crossPool ? '🌐' : '📍'} ${i + 1}. ${l.lesson}\n\n`; });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/thresholds/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const t = getThresholds();
  const stats = getPositionStats();
  let text = `⚙️ *Thresholds:*\n\n`;
  Object.entries(t).forEach(([k, v]) => { text += `• \`${k}\`: ${v}\n`; });
  text += `\n📈 Closed: ${stats.closedPositions} | Win: ${stats.winRate} | Avg PnL: ${stats.avgPnl}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/safety/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const s = getSafetyStatus();
  let text = `🛡️ *Safety Status*\n\n`;
  text += `${s.frozen ? '⛔ FROZEN' : '✅ Active'}\n`;
  text += `Daily PnL: $${s.dailyPnlUsd} | Drawdown: ${s.drawdownPct}%\n`;
  text += `Stop-loss: ${s.stopLossPct}% | Max drawdown: ${s.maxDailyDrawdownPct}%\n`;
  text += `Confirm before deploy: ${s.requireConfirmation ? 'Ya' : 'Tidak'}\n`;
  text += `Pending confirmations: ${s.pendingConfirmations}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});


bot.onText(/\/(strategies|addstrategy|deletestrategy)(.*)/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  handleStrategyCommand(bot, msg, ALLOWED_ID);
});

// ─── Message handler ─────────────────────────────────────────────

let _chatBusy = false;

bot.on('message', async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;

  // ── Setup wizard — intercept sampai konfigurasi awal selesai ────
  if (setupState.phase === 'waiting_sol') {
    const sol = parseFloat(msg.text.replace(',', '.'));
    if (isNaN(sol) || sol < 0.01 || sol > 50) {
      bot.sendMessage(msg.chat.id, '⚠️ SOL harus antara *0.01 – 50*. Contoh: `0.1`', { parse_mode: 'Markdown' });
      return;
    }
    setupState.solPerPool = sol;
    setupState.phase = 'waiting_pools';
    bot.sendMessage(msg.chat.id,
      `✅ *${sol} SOL per pool*\n\n❓ *Berapa Pool Maksimal yang Boleh Dibuka?*\n\n_Minimal 1. Contoh: \`3\` untuk max 3 posisi aktif_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (setupState.phase === 'waiting_pools') {
    const pools = parseInt(msg.text);
    if (isNaN(pools) || pools < 1) {
      bot.sendMessage(msg.chat.id, '⚠️ Masukkan angka pool minimal 1. Contoh: `3`', { parse_mode: 'Markdown' });
      return;
    }
    if (!setupState.solPerPool) {
      // State hilang (bot restart mid-wizard) — mulai ulang
      setupState.phase = 'waiting_sol';
      bot.sendMessage(msg.chat.id, '⚠️ Session expired. Ketik /entry untuk mulai ulang.', { parse_mode: 'Markdown' });
      return;
    }
    setupState.poolCount = pools;
    setupState.phase = 'done';

    const solPerPool = setupState.solPerPool;
    updateConfig({ deployAmountSol: solPerPool, maxPositions: pools });

    bot.sendMessage(msg.chat.id,
      `✅ *Setup Selesai!*\n\n` +
      `📊 Deploy per pool: *${solPerPool} SOL*\n` +
      `🏊 Max posisi aktif: *${pools}*\n\n` +
      `🦅 Hunter Alpha sedang mencari pool terbaik...`,
      { parse_mode: 'Markdown' }
    );

    // Trigger hunter langsung tanpa tunggu cron
    triggerHunter().catch(e => console.error('Trigger hunter error:', e.message));
    return;
  }
  // ── End setup wizard ─────────────────────────────────────────────

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
    bot.sendMessage(msg.chat.id, '⏳ Masih memproses pesan sebelumnya...').catch(() => {});
    return;
  }

  await handleMessage(msg, msg.text);
});

async function handleMessage(msg, text) {
  _chatBusy = true;
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
  try {
    const response = await processMessage(text);
    await sendLong(msg.chat.id, response, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`).catch(() => {});
  } finally {
    _chatBusy = false;
  }
}

bot.on('polling_error', (e) => console.error('Polling error:', e.message));

// ─── Graceful shutdown ───────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down...`);
  try {
    const openPos = getOpenPositions();
    console.log(`📍 Open positions at shutdown: ${openPos.length}`);
    bot.stopPolling();
  } catch {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tangkap uncaught exceptions supaya bot tidak mati tiba-tiba
process.on('uncaughtException', (e) => {
  console.error('❌ Uncaught Exception:', e.message, e.stack);
  notify(`⚠️ Uncaught error (bot tetap jalan): ${e.message}`).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('❌ Unhandled Rejection:', msg);
  notify(`⚠️ Unhandled promise rejection: ${msg}`).catch(() => {});
});

// ─── Startup ─────────────────────────────────────────────────────

setTimeout(async () => {
  try {
    const balance = await getWalletBalance();
    await notify(
      `🚀 *Bot Started!*\n\n` +
      `💰 Balance: ${balance} SOL | Mode: 🔴 LIVE\n` +
      `🦅 Hunter: ${cfg.screeningIntervalMin}min | 🩺 Healer: ${cfg.managementIntervalMin}min\n\n` +
      `/start untuk semua commands`
    );
    await runStartupModelCheck(notify);
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
