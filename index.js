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
    await runHunterAlpha(notify);
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
    `/dryrun <on|off> <password> — toggle mode\n\n` +
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
    await runHunterAlpha(notify);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Hunter Alpha error: ${e.message}`);
  }
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

bot.onText(/\/evolve/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Menganalisa performa dan evolve thresholds...');
  try {
    const result = await evolveThresholds();
    let text = `🧬 *Threshold Evolution Complete*\n\n📊 ${result.summary}\n\n*Perubahan:*\n`;
    Object.entries(result.changes).forEach(([k, v]) => {
      const before = result.before[k];
      const emoji = v > before ? '⬆️' : '⬇️';
      text += `${emoji} \`${k}\`: ${before} → ${v}\n`;
      if (result.rationale[k]) text += `   _${result.rationale[k]}_\n`;
    });
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
