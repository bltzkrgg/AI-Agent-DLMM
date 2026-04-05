import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { initSolana, getWalletBalance } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates, getScreeningCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons, pinLesson, unpinLesson, formatLessonsList } from './learn/lessons.js';
import { getConfig, getThresholds, updateConfig } from './config.js';
import { handleConfirmationReply, getSafetyStatus } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/coinfilter.js';
import { getOpenPositions, getPositionStats, closePositionWithPnl } from './db/database.js';
import { getPositionInfo } from './solana/meteora.js';
import { padR, hr, kv, codeBlock, formatPnl, shortAddr, shortStrat } from './utils/table.js';
import { initMonitor } from './monitor/positionMonitor.js';
import { autoEvolveIfReady } from './learn/evolve.js';
import { getTodayResults, formatDailyReport, savePerformanceSnapshot, backupAllData } from './market/strategyPerformance.js';
import { runStartupModelCheck, formatModelStatus, testModel, testCurrentModel, fetchFreeModels } from './agent/modelCheck.js';
import { runOpportunityScanner } from './market/opportunityScanner.js';
import { addSmartWallet, removeSmartWallet, formatWalletList } from './market/smartWallets.js';
import { formatPoolMemoryReport } from './market/poolMemory.js';
import { recalibrateWeights, formatWeightsReport } from './market/signalWeights.js';

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
const required = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_ID', 'OPENROUTER_API_KEY', 'HELIUS_API_KEY', 'WALLET_PRIVATE_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in all values.');
  // Warn kalau SOLANA_RPC_URL juga tidak ada (double safety)
  if (!process.env.SOLANA_RPC_URL && !process.env.HELIUS_API_KEY) {
    console.error('❌ Butuh HELIUS_API_KEY atau SOLANA_RPC_URL untuk koneksi Solana.');
  }
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

const _dryRun = getConfig().dryRun;
console.log(`🦞 Meteora DLMM Bot started! Mode: ${_dryRun ? 'DRY RUN' : 'LIVE'}`);

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
let _screeningBusy = false;

// ─── Pending approval state (auto-screening) ─────────────────────
// Map: approvalKey → { candidates, chatId, expiresAt, messageId }
const pendingApprovals = new Map();

// ─── Setup state — dipakai oleh wizard /entry ────────────────────
const setupState = {
  phase: 'done', // bot langsung jalan; wizard hanya aktif saat /entry
  solPerPool: null,
  poolCount: null,
};

// triggerHunter — hanya dipanggil dari /entry, TIDAK dari cron atau post-close
async function triggerHunter(targetCount = null) {
  if (_hunterBusy) return;
  const liveCfg = getConfig();
  const openPos = getOpenPositions();
  // Cek kuota: jika targetCount diberikan, cek apakah masih ada slot
  // Jika tidak ada targetCount, gunakan maxPositions global
  const effectiveMax = targetCount != null
    ? openPos.length + targetCount   // buka targetCount posisi baru
    : liveCfg.maxPositions;
  if (openPos.length >= effectiveMax && targetCount == null) {
    notify(`⚠️ Posisi sudah penuh (${openPos.length}/${liveCfg.maxPositions}). Tutup posisi dulu sebelum entry baru.`).catch(() => {});
    return;
  }
  _hunterBusy = true;
  try { await runHunterAlpha(notify, bot, ALLOWED_ID, { targetCount }); }
  catch (e) { notify(`❌ Hunter error: ${e.message}`).catch(() => {}); }
  finally { _hunterBusy = false; }
}

// Healer — hanya manage posisi, tidak ada reopen prompt
async function runHealerWithReopenCheck() {
  await runHealerAlpha(notify);
}

// ─── Cron jobs ───────────────────────────────────────────────────
// Semua cron jalan setiap menit dan cek interval live dari config.
// Ini memungkinkan perubahan interval via /setconfig TANPA restart bot.

let _lastHealerRun    = Date.now(); // delay run pertama sampai interval berlalu
let _lastScreeningRun = Date.now();

cron.schedule('* * * * *', async () => {
  const liveCfg = getConfig();
  const now     = Date.now();
  if (now - _lastHealerRun < liveCfg.managementIntervalMin * 60 * 1000) return;
  _lastHealerRun = now;

  if (_healerBusy) { console.log('⏭ Healer skip — masih berjalan'); return; }
  _healerBusy = true;
  try {
    await runHealerWithReopenCheck();
    autoEvolveIfReady(notify).catch(e => console.error('Auto-evolve error:', e.message));
    try { recalibrateWeights(); } catch { /* data belum cukup, skip */ }
    savePerformanceSnapshot();
  }
  catch (e) { notify(`❌ Healer error: ${e.message}`).catch(() => {}); }
  finally { _healerBusy = false; }
});

// ─── Auto-screening Hunter — interval dibaca live dari config ────
// Aktif hanya jika autoScreeningEnabled = true di config.
// Screen pool terbaik, kirim ke Telegram untuk batch approval.
// Timeout configurable, kandidat dianggap stale setelahnya.

async function runAutoScreening() {
  if (_screeningBusy || _hunterBusy) return;
  const liveCfg = getConfig();
  if (!liveCfg.autoScreeningEnabled) return;

  const openPos = getOpenPositions();
  if (openPos.length >= liveCfg.maxPositions) return; // slot penuh

  const balance = await getWalletBalance().catch(() => '0');
  if (parseFloat(balance) < (liveCfg.deployAmountSol + (liveCfg.gasReserve ?? 0.02))) return;

  _screeningBusy = true;
  try {
    await notify(`🔍 *Auto-Screening* — mencari kandidat pool...`);
    const candidates = await getScreeningCandidates(5);
    if (!candidates || candidates.length === 0) {
      await notify('📭 Auto-screening: tidak ada kandidat yang lolos filter.');
      return;
    }

    const approvalKey = `as_${Date.now()}`;
    const timeoutMin  = liveCfg.approvalTimeoutMin ?? 15;
    const expiresAt   = Date.now() + timeoutMin * 60 * 1000;

    // Build inline keyboard — 1 button per candidate + Skip All
    const candidateButtons = candidates.map((c, i) => [{
      text: `✅ Deploy #${i + 1}: ${(c.name || c.address.slice(0, 8))} (score: ${c.darwinScore})`,
      callback_data: `${approvalKey}:deploy:${i}`,
    }]);
    candidateButtons.push([{
      text: '❌ Skip Semua',
      callback_data: `${approvalKey}:skip`,
    }]);

    // Compose summary text
    let text = `🦅 *Auto-Screening Selesai* — ${candidates.length} Kandidat\n\n`;
    candidates.forEach((c, i) => {
      const swHit  = c.smartWallet?.length > 0 ? ` 🎯` : '';
      const tfInfo = c.multiTFScore > 0 ? ` | TF: ${(c.multiTFScore * 100).toFixed(0)}%` : '';
      text += `*#${i + 1}* \`${c.address.slice(0, 8)}...\`${swHit}\n`;
      text += `  Fee: $${c.fees24h}/d | TVL: $${parseInt(c.tvl).toLocaleString()} | Bin: ${c.binStep}${tfInfo}\n`;
      text += `  Darwin: ${c.darwinScore}\n\n`;
    });
    text += `_Timeout: ${timeoutMin} menit — setelah itu kandidat dianggap stale._`;

    const sentMsg = await bot.sendMessage(ALLOWED_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: candidateButtons },
    });

    pendingApprovals.set(approvalKey, {
      candidates,
      chatId:    ALLOWED_ID,
      messageId: sentMsg.message_id,
      expiresAt,
    });

    // Auto-expire: hapus setelah timeout
    setTimeout(() => {
      if (pendingApprovals.has(approvalKey)) {
        pendingApprovals.delete(approvalKey);
        bot.editMessageText(`_Auto-screening expired — tidak ada respons dalam ${timeoutMin} menit._`, {
          chat_id: ALLOWED_ID, message_id: sentMsg.message_id,
          parse_mode: 'Markdown',
        }).catch(() => {});
      }
    }, timeoutMin * 60 * 1000 + 5000);

  } catch (e) {
    console.error('Auto-screening error:', e.message);
    notify(`❌ Auto-screening error: ${e.message}`).catch(() => {});
  } finally {
    _screeningBusy = false;
  }
}

cron.schedule('* * * * *', async () => {
  const liveCfg = getConfig();
  const now     = Date.now();
  if (now - _lastScreeningRun < liveCfg.screeningIntervalMin * 60 * 1000) return;
  _lastScreeningRun = now;
  try { await runAutoScreening(); }
  catch (e) { console.error('Auto-screening cron error:', e.message); }
});

// ─── Inline keyboard callback — approval handler ──────────────────
bot.on('callback_query', async (query) => {
  if (query.from.id !== ALLOWED_ID) return;
  const data    = query.data || '';
  const chatId  = query.message?.chat?.id;
  const msgId   = query.message?.message_id;

  // Acknowledge immediately
  bot.answerCallbackQuery(query.id).catch(() => {});

  // Parse format: "<approvalKey>:deploy:<index>" | "<approvalKey>:skip"
  const parts = data.split(':');
  if (parts.length < 2) return;

  const [approvalKey, action, idxStr] = parts;
  const approval = pendingApprovals.get(approvalKey);

  if (!approval) {
    bot.editMessageText('_Kandidat sudah expired atau tidak ditemukan._', {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
    }).catch(() => {});
    return;
  }

  // Check staleness
  const liveCfg   = getConfig();
  const timeoutMin = liveCfg.approvalTimeoutMin ?? 15;
  const staleMs   = timeoutMin * 60 * 1000;
  if (Date.now() > approval.expiresAt) {
    pendingApprovals.delete(approvalKey);
    bot.editMessageText(`_Kandidat sudah expired (>${timeoutMin} menit). Jalankan /entry untuk screening ulang._`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
    }).catch(() => {});
    return;
  }

  if (action === 'skip') {
    pendingApprovals.delete(approvalKey);
    bot.editMessageText('❌ *Semua kandidat di-skip.*', {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
    }).catch(() => {});
    return;
  }

  if (action === 'deploy') {
    const idx       = parseInt(idxStr);
    const candidate = approval.candidates[idx];
    if (!candidate) return;

    // Validate staleness of candidate data (>15 min since screened)
    if (Date.now() - candidate.scannedAt > staleMs) {
      bot.editMessageText(`_Kandidat #${idx + 1} sudah stale — data sudah lebih dari ${timeoutMin} menit. Re-validating..._`, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      }).catch(() => {});
      // Re-validate by fetching fresh data
      try {
        const freshCandidates = await getScreeningCandidates(5);
        const fresh = freshCandidates.find(c => c.address === candidate.address);
        if (!fresh) {
          bot.editMessageText(`❌ Pool \`${candidate.address.slice(0,8)}...\` tidak lagi di top candidates. Screening ulang disarankan.`, {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          }).catch(() => {});
          pendingApprovals.delete(approvalKey);
          return;
        }
        candidate.scannedAt = Date.now();
      } catch {
        bot.editMessageText(`❌ Re-validasi gagal. Gunakan /entry untuk deploy manual.`, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        }).catch(() => {});
        pendingApprovals.delete(approvalKey);
        return;
      }
    }

    // Remove approval (prevent double-deploy)
    pendingApprovals.delete(approvalKey);
    bot.editMessageText(
      `✅ *Deploying ke pool #${idx + 1}*\n\`${candidate.address.slice(0, 8)}...\`\n\n_Hunter Alpha sedang bekerja..._`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => {});

    // Trigger Hunter with forced pool
    if (_hunterBusy) {
      notify('⚠️ Hunter sedang sibuk. Coba lagi sebentar.').catch(() => {});
      return;
    }
    _hunterBusy = true;
    try {
      await runHunterAlpha(notify, bot, ALLOWED_ID, {
        targetCount: 1,
        forcedPool:  candidate.address,
      });
    } catch (e) {
      notify(`❌ Hunter error: ${e.message}`).catch(() => {});
    } finally {
      _hunterBusy = false;
    }
  }
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

// ─── Opportunity Scanner — setiap 15 menit ───────────────────────
// Scan top 25 pools untuk semua strategi: Evil Panda, Wave Enjoyer, NPC, Fee Sniper
// Alert dikirim regardless posisi terbuka / balance / status deploy

cron.schedule('*/15 * * * *', async () => {
  try {
    await runOpportunityScanner(notify);
  } catch (e) { console.error('Opportunity scanner error:', e.message); }
});

// ─── Daily Briefing jam 7 pagi ───────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    const balance  = await getWalletBalance();
    const openPos  = getOpenPositions();
    const stats    = getPositionStats();
    const memStats = getMemoryStats();
    const instincts = getInstinctsContext();

    const briefLines = [
      kv('Balance', `${parseFloat(balance).toFixed(4)} SOL`, 12),
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
    let text = `☀️ *Daily Briefing*\n\n${codeBlock(briefLines)}`;
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
    const lines = [
      kv('Balance', `${parseFloat(balance).toFixed(4)} SOL`, 10),
      kv('Posisi', `${openPos.length} / ${getConfig().maxPositions}`, 10),
      kv('Closed', `${stats.closedPositions}  Win: ${stats.winRate}`, 10),
      kv('PnL', `+$${stats.totalPnlUsd}  Fees: +$${stats.totalFeesUsd}`, 10),
      kv('Instincts', `${memStats.instinctCount}`, 10),
    ];
    await notify(`📊 *Hourly Health Check*\n\n${codeBlock(lines)}`);
  } catch (e) { console.error('Health check error:', e.message); }
});

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/testmodel/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Testing model connection...');
  try {
    // Test API + fetch free models (operasi lambat, tapi ini memang tujuannya)
    const [testResult, freeModels] = await Promise.all([
      testCurrentModel(),
      fetchFreeModels(),
    ]);
    let text = formatModelStatus();
    text += `\n\n*Test Result:* ${testResult.ok ? '✅ OK' : `❌ ${testResult.error}`}\n`;
    if (freeModels.length > 0) {
      text += `\n📋 *Free models tersedia (${freeModels.length}):*\n`;
      freeModels.slice(0, 10).forEach(m => { text += `• \`${m}\`\n`; });
    }
    await sendLong(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
});

bot.onText(/\/model(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId  = msg.chat.id;
  const modelId = match[1]?.trim();

  if (!modelId) {
    // Tampilkan status instan — TANPA API call (gunakan /testmodel untuk test)
    try {
      const text = formatModelStatus();
      await sendLong(chatId, text, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
    return;
  }

  // Reset ke default
  if (modelId === 'reset') {
    updateConfig({ activeModel: null });
    const fallback = process.env.AI_MODEL || getConfig().generalModel || 'openai/gpt-4o-mini';
    bot.sendMessage(chatId, `✅ *Model di-reset*\n\nKembali ke: \`${fallback}\``, { parse_mode: 'Markdown' });
    return;
  }

  bot.sendMessage(chatId, `🔄 Testing \`${modelId}\`...`, { parse_mode: 'Markdown' });
  const result = await testModel(modelId);

  if (!result.ok) {
    bot.sendMessage(
      chatId,
      `❌ *Model gagal*\n\nModel: \`${modelId}\`\nError: ${result.error}\n\n_Coba model lain: \`/model <model_id>\`_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Model valid — simpan ke config, berlaku segera tanpa restart
  updateConfig({ activeModel: modelId });
  bot.sendMessage(
    chatId,
    `✅ *Model berhasil diganti*\n\nModel: \`${modelId}\`\n\n_Berlaku segera — tidak perlu restart._\nReset ke default: \`/model reset\``,
    { parse_mode: 'Markdown' }
  );
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
    `🦅 Hunter — *manual /entry* ${getConfig().autoScreeningEnabled ? '| 🤖 *auto-screening ON*' : ''}\n` +
    `🩺 Healer — manage posisi tiap ${cfg.managementIntervalMin}min\n` +
    `📡 Scanner — alert peluang tiap 15min (multi-TF)\n\n` +
    `*Deploy:*\n` +
    `/entry — set SOL & jumlah pool, lalu deploy\n` +
    `/autoscreen on|off — aktifkan/matikan auto-screening\n\n` +
    `*Monitor:*\n` +
    `/status /heal /results /pools\n\n` +
    `*Tools:*\n` +
    `/check <mint> — screen token (RugCheck + mcap + ATH)\n` +
    `/testmodel /strategies /library /research\n` +
    `/learn [pool] /lessons /memory /evolve\n` +
    `/thresholds /safety\n\n` +
    `*Intelligence:*\n` +
    `/weights — lihat/recalibrate Darwinian signal weights\n` +
    `/poolmemory — riwayat & performa per pool\n` +
    `/pinlesson <n> — pin lesson ke tier 1 prompt\n\n` +
    `*Smart Wallets:*\n` +
    `/addwallet <addr> <label> | /removewallet | /listwallet\n\n` +
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
          const deployedSol   = pos.deployed_sol || 0;
          const currentValSol = match.currentValueSol ?? 0;
          const pnlSol = parseFloat((currentValSol - deployedSol).toFixed(4));
          const pnlPct = deployedSol > 0 && currentValSol > 0
            ? parseFloat(((currentValSol - deployedSol) / deployedSol * 100).toFixed(2))
            : 0;
          chainMap[pos.position_address] = {
            status:  match.inRange ? 'InRange' : 'OutRange',
            pnlSol,
            pnlPct,
            feeSol: match.feeCollectedSol ?? 0,
            manualClose: false,
          };
        } else {
          chainMap[pos.position_address] = { status: 'NoData' };
        }
      } catch {
        chainMap[pos.position_address] = { status: 'Err' };
      }
    }));

    // Auto-mark manually closed positions in DB
    for (const pos of openPos) {
      const c = chainMap[pos.position_address];
      if (c?.manualClose) {
        closePositionWithPnl(pos.position_address, { pnlUsd: 0, pnlPct: 0, feesUsd: 0, closeReason: 'MANUAL_CLOSE' });
        notify(
          `⚠️ *Posisi Ditutup Manual*\n\n` +
          `Pool     : \`${pos.pool_address}\`\n` +
          `Posisi   : \`${pos.position_address}\`\n` +
          `Strategi : ${pos.strategy_used || '-'}\n` +
          `Deploy   : ${(pos.deployed_sol || 0).toFixed(4)} SOL\n\n` +
          `_Posisi tidak ditemukan on-chain. Telah ditandai CLOSED di database._`
        ).catch(() => {});
      }
    }

    // Filter ulang posisi yang benar-benar masih open (belum di-mark manual)
    const activePos = openPos.filter(p => !chainMap[p.position_address]?.manualClose);

    // ── Header ───────────────────────────────────────────────────
    let text = `📊 *Status Bot* 🔴 LIVE\n\n`;

    const pnlSign  = (v) => parseFloat(v) >= 0 ? '+' : '';
    const headerLines = [
      kv('Balance',   `${parseFloat(balance).toFixed(4)} SOL`, 10),
      kv('Posisi',    `${activePos.length} / ${getConfig().maxPositions}`, 10),
      kv('Closed',    `${stats.closedPositions}  Win: ${stats.winRate}`, 10),
      kv('PnL',       `${pnlSign(stats.totalPnlUsd)}$${parseFloat(stats.totalPnlUsd || 0).toFixed(2)}  Fees: +$${parseFloat(stats.totalFeesUsd || 0).toFixed(2)}`, 10),
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
          return [`  ${openedAt}  ${shortAddr(pos.position_address)}${feeStr}`, '', '', ''];
        }),
      ];

      const tableLines = rows.map(cols =>
        cols.map((c, i) => i < W.length - 1 ? padR(c, W[i] + 2) : c).join('')
      );
      text += codeBlock(tableLines);
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
  sendLong(msg.chat.id, formatLessonsList(), { parse_mode: 'Markdown' }).catch(() => {});
});

// /pinlesson <index> — pin lesson ke tier 1 (selalu masuk prompt)
bot.onText(/\/pinlesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null; // 1-based dari user
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: `/pinlesson <nomor>` (lihat nomor di /lessons)', { parse_mode: 'Markdown' });
    return;
  }
  const result = pinLesson(idx);
  if (!result.ok) {
    bot.sendMessage(msg.chat.id, `❌ ${result.reason}`);
  } else {
    bot.sendMessage(msg.chat.id, `📌 *Lesson di-pin!*\n\n_"${result.lesson}"_\n\nLesson ini akan selalu masuk ke prompt agent.`, { parse_mode: 'Markdown' });
  }
});

// /unpinlesson <index>
bot.onText(/\/unpinlesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null;
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: `/unpinlesson <nomor>`', { parse_mode: 'Markdown' });
    return;
  }
  const result = unpinLesson(idx);
  bot.sendMessage(msg.chat.id, result.ok ? '✅ Lesson di-unpin.' : `❌ ${result.reason}`);
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

// ─── Smart Wallet commands ────────────────────────────────────────

// /addwallet <address> <label>
bot.onText(/\/addwallet(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const address = match[1]?.trim();
  const label   = match[2]?.trim() || 'unknown';
  if (!address) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: `/addwallet <address> <label>`\nContoh: `/addwallet 7xKd...1bAz alpha_lp_1`', { parse_mode: 'Markdown' });
    return;
  }
  const { ok, reason } = addSmartWallet(address, label);
  bot.sendMessage(msg.chat.id,
    ok ? `✅ *Smart wallet ditambahkan!*\n\`${address.slice(0, 12)}...\` — ${label}` : `❌ ${reason}`,
    { parse_mode: 'Markdown' }
  );
});

// /removewallet <address>
bot.onText(/\/removewallet(?:\s+(\S+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const address = match[1]?.trim();
  if (!address) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: `/removewallet <address>`', { parse_mode: 'Markdown' });
    return;
  }
  const { ok, reason } = removeSmartWallet(address);
  bot.sendMessage(msg.chat.id, ok ? '✅ Wallet dihapus dari list.' : `❌ ${reason}`);
});

// /listwallet
bot.onText(/\/listwallet/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  sendLong(msg.chat.id, formatWalletList(), { parse_mode: 'Markdown' }).catch(() => {});
});

// ─── Pool Memory command ──────────────────────────────────────────

// /poolmemory — tampilkan top/worst pools berdasarkan riwayat deploy
bot.onText(/\/poolmemory/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  sendLong(msg.chat.id, formatPoolMemoryReport(), { parse_mode: 'Markdown' }).catch(() => {});
});

// /dryrun on|off — toggle dry run mode
bot.onText(/\/dryrun(?:\s+(on|off))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();
  if (!toggle) {
    const current = getConfig().dryRun;
    bot.sendMessage(chatId,
      `🟡 *Dry Run Mode*: ${current ? 'ON' : 'OFF'}\n\nGunakan \`/dryrun on\` atau \`/dryrun off\`.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const enable = toggle === 'on';
  updateConfig({ dryRun: enable });
  bot.sendMessage(chatId,
    `${enable ? '🟡' : '🔴'} *Dry Run*: ${enable ? 'ON — TX tidak akan dieksekusi' : 'OFF — Mode LIVE aktif'}\n\n` +
    (enable ? '_Semua open/close/claim/swap akan disimulasikan saja._' : '_Trading berjalan normal._'),
    { parse_mode: 'Markdown' }
  );
});

// /autoscreen on|off — toggle auto-screening (alias: /autohunter)
bot.onText(/\/(?:autoscreen|autohunter)(?:\s+(on|off))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();
  if (!toggle) {
    const current = getConfig().autoScreeningEnabled;
    bot.sendMessage(chatId,
      `🤖 *Auto-Screening*: ${current ? '✅ ON' : '❌ OFF'}\n\n` +
      `Gunakan \`/autoscreen on\` atau \`/autoscreen off\` untuk toggle.\n` +
      `Interval: ${getConfig().screeningIntervalMin} menit | Timeout: ${getConfig().approvalTimeoutMin} menit`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const enable = toggle === 'on';
  updateConfig({ autoScreeningEnabled: enable });
  bot.sendMessage(chatId,
    `🤖 *Auto-Screening*: ${enable ? '✅ Diaktifkan' : '❌ Dimatikan'}\n\n` +
    (enable
      ? `Hunter akan auto-screen setiap ${getConfig().screeningIntervalMin} menit dan kirim kandidat untuk approval.`
      : `Hunter hanya jalan via /entry.`),
    { parse_mode: 'Markdown' }
  );
});

// ─── Signal Weights command ───────────────────────────────────────

// /weights — tampilkan/recalibrate bobot Darwinian
bot.onText(/\/weights/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  bot.sendMessage(msg.chat.id, '⚙️ Recalibrating signal weights...');
  const result = recalibrateWeights();
  sendLong(msg.chat.id, formatWeightsReport(result), { parse_mode: 'Markdown' }).catch(() => {});
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
      `✅ *${sol} SOL per pool*\n\n❓ *Berapa Pool yang Ingin Di-deploy Sekarang?*\n\n_Contoh: \`3\` untuk deploy ke 3 pool sekarang_`,
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
    updateConfig({ deployAmountSol: solPerPool });

    bot.sendMessage(msg.chat.id,
      `✅ *Setup Selesai!*\n\n` +
      `📊 Deploy per pool: *${solPerPool} SOL*\n` +
      `🏊 Deploy sekarang: *${pools} pool*\n` +
      `📋 Max posisi aktif: *${getConfig().maxPositions}*\n\n` +
      `🦅 Hunter Alpha sedang mencari pool terbaik...`,
      { parse_mode: 'Markdown' }
    );

    // Trigger hunter langsung tanpa tunggu cron, dengan jumlah pool target
    triggerHunter(pools).catch(e => console.error('Trigger hunter error:', e.message));
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
      `💰 Balance: ${balance} SOL | Mode: ${getConfig().dryRun ? '🟡 DRY RUN' : '🔴 LIVE'}\n` +
      `🦅 Hunter: *manual /entry*${getConfig().autoScreeningEnabled ? ' | 🤖 auto-screen ON' : ''} | 🩺 Healer: ${cfg.managementIntervalMin}min | 📡 Scanner: 15min\n\n` +
      `/entry untuk buka posisi | /start untuk semua commands`
    );
    await runStartupModelCheck(notify);
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
