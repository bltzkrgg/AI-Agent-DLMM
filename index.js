import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { initSolana, getWalletBalance } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons } from './learn/lessons.js';
import { evolveThresholds } from './learn/evolve.js';
import { getConfig, isDryRun, getThresholds, updateConfig } from './config.js';
import { handleConfirmationReply, getSafetyStatus } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats, matchStrategyToMarket } from './market/strategyLibrary.js';
import { getMarketSnapshot } from './market/oracle.js';
import { getOpenPositions, getPositionStats } from './db/database.js';

// Validate required env vars
const required = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_ID', 'ANTHROPIC_API_KEY', 'SOLANA_RPC_URL', 'WALLET_PRIVATE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

const ALLOWED_ID = parseInt(process.env.ALLOWED_TELEGRAM_ID);

// Init Solana
try {
  initSolana();
} catch (e) {
  console.error('❌ Failed to init Solana wallet:', e.message);
  process.exit(1);
}

// Init Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const cfg = getConfig();

console.log(`🦞 Meteora DLMM Bot started!`);
console.log(`🧪 Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}`);
console.log(`⏱  Hunter: every ${cfg.screeningIntervalMin}min | Healer: every ${cfg.managementIntervalMin}min`);

// Helper: send message to owner
async function notify(text) {
  try {
    await bot.sendMessage(ALLOWED_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    console.error('Notify error:', e.message);
  }
}

// ─── CRON: Hunter Alpha ──────────────────────────────────────────
cron.schedule(`*/${cfg.screeningIntervalMin} * * * *`, async () => {
  console.log('🦅 Hunter Alpha running...');
  try {
    await runHunterAlpha(notify, bot, ALLOWED_ID);
  } catch (e) {
    console.error('Hunter Alpha error:', e.message);
    await notify(`❌ Hunter Alpha error: ${e.message}`);
  }
});

// ─── CRON: Healer Alpha ──────────────────────────────────────────
cron.schedule(`*/${cfg.managementIntervalMin} * * * *`, async () => {
  console.log('🩺 Healer Alpha running...');
  try {
    await runHealerAlpha(notify);
  } catch (e) {
    console.error('Healer Alpha error:', e.message);
    await notify(`❌ Healer Alpha error: ${e.message}`);
  }
});

// ─── CRON: Hourly health check ───────────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const stats = getPositionStats();
    const lessons = loadLessons();
    await notify(
      `📊 *Hourly Health Check*\n\n` +
      `💰 Balance: ${balance} SOL\n` +
      `📍 Posisi terbuka: ${openPos.length}/${cfg.maxPositions}\n` +
      `📈 Total closed: ${stats.closedPositions}\n` +
      `🎯 Win rate: ${stats.winRate}\n` +
      `📚 Lessons: ${lessons.length}\n` +
      `🧪 Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}`
    );
  } catch (e) {
    console.error('Health check error:', e.message);
  }
});

// ─── TELEGRAM COMMANDS ──────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const dryTag = isDryRun() ? ' `[DRY RUN]`' : ' `[LIVE]`';
  bot.sendMessage(msg.chat.id,
    `🦞 *Meteora DLMM Bot*${dryTag}\n\n` +
    `*Autonomous Agents:*\n` +
    `🦅 Hunter Alpha — screening tiap ${cfg.screeningIntervalMin}min\n` +
    `🩺 Healer Alpha — manage posisi tiap ${cfg.managementIntervalMin}min\n\n` +
    `*Commands:*\n` +
    `/status — balance & posisi terbuka\n` +
    `/pools — screen kandidat pool sekarang\n` +
    `/hunt — jalankan Hunter Alpha manual\n` +
    `/heal — jalankan Healer Alpha manual\n` +
    `/strategies — lihat strategi tersedia\n` +
    `/addstrategy <password> — tambah strategi\n` +
    `/learn [pool] — belajar dari top LPers\n` +
    `/lessons — lihat lessons tersimpan\n` +
    `/evolve — evolve screening thresholds\n` +
    `/thresholds — lihat & kelola thresholds\n` +
    `/dryrun <on|off> <password> — toggle mode\n` +
    `/safety — safety status & drawdown\n` +
    `/memory — lihat instincts & trading memory\n` +
    `/evolve — evolve instincts dari trading history\n` +
    `/library — lihat strategy library\n` +
    `/research — tambah strategi dari artikel\n\n` +
    `Atau langsung chat untuk instruksi bebas!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Tampilkan semua posisi terbuka, balance wallet, dan statistik performa saya sekarang');
});

bot.onText(/\/pools/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Analisa dan tampilkan 5 pool DLMM terbaik berdasarkan fee APR saat ini');
});

bot.onText(/\/hunt/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '🦅 Menjalankan Hunter Alpha...', { parse_mode: 'Markdown' });
  try {
    await runHunterAlpha(notify, bot, ALLOWED_ID);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Hunter Alpha error: ${e.message}`);
  }
});

bot.onText(/\/safety/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const s = getSafetyStatus();
  let text = `🛡️ *Safety Status*\n\n`;
  text += `${s.frozen ? '⛔ FROZEN' : '✅ Active'}\n\n`;
  text += `📉 Daily PnL: $${s.dailyPnlUsd}\n`;
  text += `📊 Drawdown hari ini: ${s.drawdownPct}% (max: ${s.maxDailyDrawdownPct}%)\n`;
  text += `🛑 Stop-loss threshold: ${s.stopLossPct}%\n`;
  text += `🔔 Require confirmation: ${s.requireConfirmation ? 'Ya' : 'Tidak'}\n`;
  text += `⏳ Pending confirmations: ${s.pendingConfirmations}\n\n`;
  text += `_Edit \`user-config.json\` untuk ubah threshold_`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/heal/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '🩺 Menjalankan Healer Alpha...', { parse_mode: 'Markdown' });
  try {
    await runHealerAlpha(notify);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Healer Alpha error: ${e.message}`);
  }
});

bot.onText(/\/learn(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const poolArg = match[1]?.trim();

  bot.sendMessage(chatId, '📚 Mempelajari top LPers...');

  try {
    let text;
    if (poolArg) {
      const lessons = await learnFromPool(poolArg);
      text = `✅ *${lessons.length} lessons baru dari pool:*\n\n` +
        lessons.map((l, i) => `${i + 1}. ${l.lesson}`).join('\n\n');
    } else {
      const candidates = getCandidates();
      if (candidates.length === 0) {
        bot.sendMessage(chatId, '⚠️ Belum ada kandidat. Jalankan /hunt dulu.');
        return;
      }
      const addrs = candidates.slice(0, 3).map(c => c.address);
      const { lessons, errors } = await learnFromMultiplePools(addrs);
      text = `✅ *${lessons.length} lessons baru dari ${addrs.length} pool:*\n\n` +
        lessons.slice(0, 6).map((l, i) => `${i + 1}. ${l.lesson}`).join('\n\n');
      if (errors.length) text += `\n\n⚠️ ${errors.length} pool gagal diakses`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal learn: ${e.message}`);
  }
});

bot.onText(/\/lessons/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const lessons = loadLessons();
  if (lessons.length === 0) {
    bot.sendMessage(msg.chat.id, '📭 Belum ada lessons. Jalankan `/learn` dulu.', { parse_mode: 'Markdown' });
    return;
  }
  const recent = lessons.slice(-8);
  let text = `📚 *${lessons.length} Lessons (8 terbaru):*\n\n`;
  recent.forEach((l, i) => {
    const tag = l.crossPool ? '🌐' : '📍';
    text += `${tag} ${i + 1}. ${l.lesson}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/library/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const stats = getLibraryStats();
  let text = `📚 *Strategy Library*\n\n`;
  text += `📊 Total strategi: ${stats.totalStrategies}\n`;
  text += `🔧 Built-in: ${stats.builtinCount}\n`;
  text += `🔬 Dari research: ${stats.researchedCount}\n`;
  text += `⏰ Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Belum ada update'}\n\n`;
  text += `*Top Strategi:*\n`;
  stats.topStrategies.forEach((s, i) => {
    text += `${i + 1}. ${s.name} (${s.type}) — ${(s.confidence * 100).toFixed(0)}% confidence\n`;
  });
  text += `\n_Gunakan /research untuk tambah strategi baru dari artikel_`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /research — user paste artikel, agent extract strategi
// State machine untuk handle multi-message paste
const researchSessions = new Map();

bot.onText(/\/research/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const text = msg.text.replace('/research', '').trim();

  // Kalau ada teks langsung setelah /research
  if (text.length > 100) {
    await processResearchArticle(chatId, text);
    return;
  }

  // Kalau tidak ada teks, minta user paste artikel
  researchSessions.set(msg.from.id, true);
  bot.sendMessage(chatId,
    `🔬 *Research Mode Aktif*\n\n` +
    `Paste artikel tentang strategi DLMM yang mau kamu tambahkan ke Strategy Library.\n\n` +
    `_Bisa dari X/Twitter, Medium, blog DeFi, atau sumber lain._\n\n` +
    `Ketik /cancel untuk batal.`,
    { parse_mode: 'Markdown' }
  );
});

async function processResearchArticle(chatId, articleText) {
  bot.sendMessage(chatId, '🔬 Menganalisa artikel dan mengextract strategi...');
  try {
    const summary = await summarizeArticle(articleText);
    const result = await extractStrategiesFromArticle(articleText);

    let text = `📰 *Ringkasan Artikel:*\n${summary}\n\n`;

    if (result.extracted.length === 0) {
      text += `⚠️ ${result.message}`;
    } else {
      text += `✅ *${result.extracted.length} Strategi Ditemukan:*\n\n`;
      result.extracted.forEach((s, i) => {
        text += `*${i + 1}. ${s.name}* (${s.type})\n`;
        text += `📝 ${s.description}\n`;
        text += `📊 Cocok untuk: ${s.marketConditions?.trend?.join(', ')} market\n`;
        text += `🎯 Entry: ${s.entryConditions}\n`;
        text += `🚪 Exit: ${s.exitConditions}\n`;
        if (s.sourceQuote) text += `💬 _"${s.sourceQuote.slice(0, 80)}..."_\n`;
        text += '\n';
      });
      text += `_Strategi ini sekarang aktif di Strategy Library dan akan dipakai Hunter Alpha._`;
    }

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal extract strategi: ${e.message}`);
  }
}
  if (msg.from.id !== ALLOWED_ID) return;
  const stats = getMemoryStats();
  const instincts = getInstinctsContext();
  let text = `🧠 *Memory Stats*\n\n`;
  text += `📊 Total trades recorded: ${stats.totalTrades}\n`;
  text += `🎯 Win rate: ${stats.winRate}\n`;
  text += `💡 Instincts: ${stats.instinctCount}\n`;
  text += `🧬 Evolution rounds: ${stats.evolutionCount}\n`;
  text += `⏰ Last evolution: ${stats.lastEvolution ? new Date(stats.lastEvolution).toLocaleString() : 'Belum pernah'}\n`;
  if (instincts) text += `\n${instincts}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/evolve/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Menganalisa performa dan evolve instincts dari trading history...');
  try {
    const result = await evolveFromTrades();
    let text = `🧬 *Evolution Complete! (Round ${getMemoryStats().evolutionCount})*\n\n`;
    text += `📊 ${result.summary}\n\n`;
    text += `📈 Stats: ${result.stats.winRate}% win rate | Avg PnL $${result.stats.avgPnl} | ${result.stats.totalTrades} trades\n\n`;
    text += `*${result.newInstincts.length} Instincts Baru:*\n`;
    result.newInstincts.forEach((inst, i) => {
      text += `\n${i + 1}. [${(inst.confidence * 100).toFixed(0)}%] ${inst.pattern}`;
    });
    if (result.analystAdjustments) {
      text += `\n\n💡 *Saran untuk Market Analyst:*\n${result.analystAdjustments}`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/thresholds/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const t = getThresholds();
  const stats = getPositionStats();
  let text = `⚙️ *Screening Thresholds:*\n\n`;
  Object.entries(t).forEach(([k, v]) => text += `• \`${k}\`: ${v}\n`);
  text += `\n📈 *Performance:*\n`;
  text += `• Closed: ${stats.closedPositions} | Win rate: ${stats.winRate} | Avg PnL: ${stats.avgPnl}\n\n`;
  text += `_Gunakan /evolve untuk auto-adjust_`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/dryrun\s+(on|off)\s+(\S+)/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const toggle = match[1];
  const password = match[2];
  if (password !== process.env.ADMIN_PASSWORD) {
    bot.sendMessage(msg.chat.id, '❌ Password salah.');
    return;
  }
  const dryRun = toggle === 'on';
  updateConfig({ dryRun });
  bot.sendMessage(msg.chat.id,
    `${dryRun ? '🧪' : '🔴'} *Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}*\n\n` +
    `${dryRun ? 'Semua transaksi disimulasikan.' : '⚠️ Transaksi nyata aktif!'}`,
    { parse_mode: 'Markdown' }
  );
});

// Strategy commands
bot.onText(/\/(strategies|addstrategy|deletestrategy)(.*)/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  handleStrategyCommand(bot, msg, ALLOWED_ID);
});

// Free-form chat
bot.on('message', async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;

  // Handle confirmation replies (ya 1 / tidak 1)
  if (handleConfirmationReply(msg.text)) return;

  // Handle research article paste
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
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  try {
    const response = await processMessage(text);
    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    console.error('Error:', e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
}

bot.on('polling_error', (e) => console.error('Polling error:', e.message));

process.on('SIGINT', () => {
  console.log('\n👋 Bot stopped');
  bot.stopPolling();
  process.exit(0);
});

// Startup notification
setTimeout(async () => {
  try {
    const balance = await getWalletBalance();
    await notify(
      `🚀 *Bot Started!*\n\n` +
      `💰 Balance: ${balance} SOL\n` +
      `🧪 Mode: ${isDryRun() ? 'DRY RUN' : 'LIVE'}\n` +
      `🦅 Hunter: tiap ${cfg.screeningIntervalMin} menit\n` +
      `🩺 Healer: tiap ${cfg.managementIntervalMin} menit\n\n` +
      `Ketik /start untuk semua commands.`
    );
  } catch (e) {
    console.error('Startup notify error:', e.message);
  }
}, 2000);
