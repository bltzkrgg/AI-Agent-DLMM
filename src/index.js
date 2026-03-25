import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { initSolana, getWalletBalance } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons } from './learn/lessons.js';
import { getConfig, isDryRun, getThresholds, updateConfig } from './config.js';
import { handleConfirmationReply, getSafetyStatus } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/scamScreener.js';
import { getOpenPositions, getPositionStats } from './db/database.js';

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

console.log(`🦞 Meteora DLMM Bot started! Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}`);

async function notify(text) {
  try { await bot.sendMessage(ALLOWED_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (e) { console.error('Notify error:', e.message); }
}

// ─── Cron jobs ───────────────────────────────────────────────────

cron.schedule(`*/${cfg.screeningIntervalMin} * * * *`, async () => {
  try { await runHunterAlpha(notify, bot, ALLOWED_ID); }
  catch (e) { await notify(`❌ Hunter error: ${e.message}`); }
});

cron.schedule(`*/${cfg.managementIntervalMin} * * * *`, async () => {
  try { await runHealerAlpha(notify); }
  catch (e) { await notify(`❌ Healer error: ${e.message}`); }
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
      `📍 Posisi: ${openPos.length}/${cfg.maxPositions}\n` +
      `📈 Closed: ${stats.closedPositions} | Win rate: ${stats.winRate}\n` +
      `🧠 Instincts: ${memStats.instinctCount}\n` +
      `🧪 Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}`
    );
  } catch (e) { console.error('Health check error:', e.message); }
});

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id,
    `🦞 *Meteora DLMM Bot* ${isDryRun() ? '`[DRY RUN]`' : '`[LIVE]`'}\n\n` +
    `🦅 Hunter — screening tiap ${cfg.screeningIntervalMin}min\n` +
    `🩺 Healer — manage posisi tiap ${cfg.managementIntervalMin}min\n\n` +
    `*Commands:*\n` +
    `/status /pools /hunt /heal\n` +
    `/check <mint> — screen token scam\n` +
    `/strategies /addstrategy <pw>\n` +
    `/library /research\n` +
    `/learn [pool] /lessons\n` +
    `/memory /evolve\n` +
    `/thresholds /safety\n` +
    `/dryrun <on|off> <pw>\n\n` +
    `Atau chat bebas langsung!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Tampilkan semua posisi terbuka, balance wallet, dan statistik performa sekarang');
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
  try { await runHealerAlpha(notify); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
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
  let text = `📚 *Strategy Library*\n\n`;
  text += `Total: ${stats.totalStrategies} | Built-in: ${stats.builtinCount} | Research: ${stats.researchedCount}\n`;
  text += `Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Belum ada'}\n\n`;
  text += `*Top Strategi:*\n`;
  stats.topStrategies.forEach((s, i) => {
    text += `${i + 1}. ${s.name} (${s.type}) — ${(s.confidence * 100).toFixed(0)}%\n`;
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
  try {
    const summary = await summarizeArticle(articleText);
    const result = await extractStrategiesFromArticle(articleText);
    let text = `📰 *Ringkasan:*\n${summary}\n\n`;
    if (result.extracted.length === 0) {
      text += `⚠️ ${result.message}`;
    } else {
      text += `✅ *${result.extracted.length} Strategi Ditemukan:*\n\n`;
      result.extracted.forEach((s, i) => {
        text += `*${i + 1}. ${s.name}* (${s.type})\n`;
        text += `📊 Market: ${s.marketConditions?.trend?.join(', ')}\n`;
        text += `🎯 Entry: ${s.entryConditions}\n`;
        text += `🚪 Exit: ${s.exitConditions}\n\n`;
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

bot.onText(/\/dryrun\s+(on|off)\s+(\S+)/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (match[2] !== process.env.ADMIN_PASSWORD) { bot.sendMessage(msg.chat.id, '❌ Password salah.'); return; }
  const dryRun = match[1] === 'on';
  updateConfig({ dryRun });
  bot.sendMessage(msg.chat.id,
    `${dryRun ? '🧪 DRY RUN aktif' : '🔴 LIVE aktif'}\n${dryRun ? 'Transaksi disimulasikan.' : '⚠️ Transaksi nyata!'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/(strategies|addstrategy|deletestrategy)(.*)/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  handleStrategyCommand(bot, msg, ALLOWED_ID);
});

// ─── Message handler ─────────────────────────────────────────────

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

  await handleMessage(msg, msg.text);
});

async function handleMessage(msg, text) {
  bot.sendChatAction(msg.chat.id, 'typing');
  try {
    const response = await processMessage(text);
    await bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
}

bot.on('polling_error', (e) => console.error('Polling error:', e.message));
process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });

// ─── Startup ─────────────────────────────────────────────────────

setTimeout(async () => {
  try {
    const balance = await getWalletBalance();
    await notify(
      `🚀 *Bot Started!*\n\n` +
      `💰 ${balance} SOL | Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}\n` +
      `🦅 Hunter: ${cfg.screeningIntervalMin}min | 🩺 Healer: ${cfg.managementIntervalMin}min\n\n` +
      `/start untuk semua commands`
    );
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
