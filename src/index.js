import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { initSolana, getWalletBalance } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons, pinLesson, unpinLesson, formatLessonsList } from './learn/lessons.js';
import { getConfig, getThresholds, updateConfig, isConfigKeySupported } from './config.js';
import { handleConfirmationReply, getSafetyStatus, setStartingBalanceUsd } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/coinfilter.js';
import { getOpenPositions, getPositionStats, closePositionWithPnl } from './db/database.js';
import { getPositionInfo, getPositionInfoLight, getSolPriceUsd } from './solana/meteora.js';
import { padR, hr, kv, codeBlock, formatPnl, shortAddr, shortStrat } from './utils/table.js';
import { initMonitor } from './monitor/positionMonitor.js';
import { autoEvolveIfReady } from './learn/evolve.js';
import { getTodayResults, formatDailyReport, savePerformanceSnapshot, backupAllData } from './market/strategyPerformance.js';
import { runStartupModelCheck, formatModelStatus, testModel, testCurrentModel, fetchFreeModels } from './agent/modelCheck.js';
import { runOpportunityScanner } from './market/opportunityScanner.js';
import { addSmartWallet, removeSmartWallet, formatWalletList } from './market/smartWallets.js';
import { formatPoolMemoryReport } from './market/poolMemory.js';
import { recalibrateWeights, formatWeightsReport } from './market/signalWeights.js';
import { validateRuntimeEnv } from './runtime/env.js';

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
const { missing } = validateRuntimeEnv({ requireTrading: true });
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

const _dryRun = getConfig().dryRun;
console.log(`🦞 Meteora DLMM Bot started! Mode: ${_dryRun ? 'DRY RUN' : 'LIVE'}`);

async function syncStartingBalanceBaseline() {
  if (!solanaReady) return;
  try {
    const [balance, solPriceUsd] = await Promise.all([
      getWalletBalance(),
      getSolPriceUsd().catch(() => 150),
    ]);
    const balanceUsd = parseFloat(balance) * solPriceUsd;
    setStartingBalanceUsd(parseFloat(balanceUsd.toFixed(2)));
  } catch (e) {
    console.warn(`⚠️ Failed to sync starting balance baseline: ${e.message}`);
  }
}

await syncStartingBalanceBaseline();

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
  if (!solanaReady) {
    notify('⚠️ Wallet/RPC belum siap. Perbaiki koneksi Solana sebelum menjalankan Hunter.').catch(() => {});
    return;
  }
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
  if (!solanaReady) return;
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
  // Update SETELAH cek busy — supaya timer tidak mundur saat healer masih jalan
  if (_healerBusy) { console.log('⏭ Healer skip — masih berjalan'); return; }
  _lastHealerRun = now;
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
// Screen pool terbaik, langsung deploy kandidat teratas (tanpa approval).

async function runAutoScreening() {
  if (!solanaReady) return;
  if (_screeningBusy || _hunterBusy) return;
  const liveCfg = getConfig();
  if (!liveCfg.autoScreeningEnabled) return;

  const openPos = getOpenPositions();
  if (openPos.length >= liveCfg.maxPositions) return; // slot penuh

  const balance = await getWalletBalance().catch(() => '0');
  if (parseFloat(balance) < (liveCfg.deployAmountSol + (liveCfg.gasReserve ?? 0.02))) return;

  _screeningBusy = true;
  _hunterBusy    = true;
  try {
    await runHunterAlpha(notify, bot, ALLOWED_ID);
  } catch (e) {
    console.error('Auto-screening error:', e.message);
    notify(`❌ Auto-screening error: ${e.message}`).catch(() => {});
  } finally {
    _screeningBusy = false;
    _hunterBusy    = false;
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
    await syncStartingBalanceBaseline();
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
    await syncStartingBalanceBaseline();
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
    const envNote  = process.env.AI_MODEL
      ? `\n\n⚠️ \`AI_MODEL\` env aktif: \`${process.env.AI_MODEL}\`\n_/model command tidak bisa override env. Hapus \`AI_MODEL\` dari .env untuk pakai /model._`
      : '';
    bot.sendMessage(chatId, `✅ *Model di-reset*\n\nKembali ke: \`${fallback}\`${envNote}`, { parse_mode: 'Markdown' });
    return;
  }

  // Warn jika AI_MODEL env aktif — /model command tidak akan efektif
  if (process.env.AI_MODEL) {
    bot.sendMessage(
      chatId,
      `⚠️ *AI\\_MODEL env aktif*\n\nEnv: \`${process.env.AI_MODEL}\`\n\n` +
      `\`/model\` command tidak bisa override env var.\n` +
      `Hapus atau ubah \`AI_MODEL\` di file \`.env\` lalu restart bot untuk ganti model.`,
      { parse_mode: 'Markdown' }
    );
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
    `🦅 Hunter — ${getConfig().autoScreeningEnabled ? '🤖 *auto-screening ON*' : '⏸ auto-screening OFF'}\n` +
    `🩺 Healer — manage posisi tiap ${cfg.managementIntervalMin}min\n` +
    `📡 Scanner — alert peluang tiap 15min (multi-TF)\n\n` +
    `*Deploy:*\n` +
    `/autoscreen on|off — aktifkan/matikan auto-deploy\n\n` +
    `*Monitor:*\n` +
    `/pos — snapshot posisi cepat (REST API, instan)\n` +
    `/status — posisi lengkap + balance + stats (on-chain)\n` +
    `/heal /results /pools\n\n` +
    `*Config:*\n` +
    `/setconfig — lihat semua config\n` +
    `/setconfig key value — ubah config tanpa restart\n` +
    `/dryrun on|off — toggle dry run mode\n\n` +
    `*Tools:*\n` +
    `/check <mint> — screen token (RugCheck + mcap)\n` +
    `/testmodel /model /strategies /library /research\n` +
    `/learn [pool] /lessons /memory /evolve\n` +
    `/thresholds /safety /weights /poolmemory\n\n` +
    `*Smart Wallets:*\n` +
    `/addwallet <addr> <label> | /removewallet | /listwallet\n\n` +
    `Atau chat bebas langsung!`,
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

// /pos — snapshot posisi cepat via REST API (tanpa LLM, tanpa on-chain RPC)
bot.onText(/\/pos$/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const openPos = getOpenPositions();
    if (!openPos.length) {
      return bot.sendMessage(chatId, '_Tidak ada posisi terbuka._', { parse_mode: 'Markdown' });
    }

    const poolsToCheck = [...new Set(openPos.map(p => p.pool_address))];
    const results = await Promise.allSettled(
      poolsToCheck.map(addr => getPositionInfoLight(addr))
    );

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
    let text = `📊 *Posisi Terbuka — ${time} WIB*\n\n`;

    for (const pos of openPos) {
      const cd        = chainMap[pos.position_address];
      const deploySol = parseFloat(pos.deployed_sol ?? 0);
      const pnlPct    = cd && deploySol > 0
        ? ((cd.currentValueSol - deploySol) / deploySol * 100).toFixed(2)
        : '?';
      const pnlSign   = parseFloat(pnlPct) >= 0 ? '+' : '';
      const rangeIcon = cd ? (cd.inRange ? '🟢' : '🔴') : '⚪';
      const oorLabel  = cd && !cd.inRange ? ' OOR' : '';
      const feesStr   = cd ? `${(cd.feeCollectedSol || 0).toFixed(4)} SOL` : '?';
      const strat     = pos.strategy_used ? ` · ${pos.strategy_used}` : '';
      const symbol    = pos.token_x_symbol || pos.token_x?.slice(0, 6) || '?';

      // Invert harga kalau SOL pair dan data dari REST API (tidak ada displayCurrentPrice)
      const WSOL_M = 'So11111111111111111111111111111111111111112';
      const isSOLP = pos.token_y === WSOL_M;
      const rawPrice = cd?.currentPrice;
      const priceDisp = cd?.displayCurrentPrice != null
        ? `${cd.displayCurrentPrice} ${cd.priceUnit || ''}`
        : rawPrice > 0
          ? `${isSOLP ? (1/rawPrice).toFixed(4) : rawPrice.toFixed(8)} ${isSOLP ? `${symbol}/SOL` : ''}`
          : '';

      text +=
        `${rangeIcon} \`${pos.pool_address.slice(0, 8)}...\` *${symbol}/SOL*${strat}${oorLabel}\n` +
        `  PnL: \`${pnlSign}${pnlPct}%\`  Fees: \`${feesStr}\`  Deploy: \`${deploySol.toFixed(4)} SOL\`\n` +
        (priceDisp ? `  Harga: \`${priceDisp}\`\n` : '');
    }

    text += `\n_Data via Meteora API — gunakan /status untuk data on-chain penuh._`;
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
      `Interval screening: ${getConfig().screeningIntervalMin} menit`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const enable = toggle === 'on';
  updateConfig({ autoScreeningEnabled: enable });
  bot.sendMessage(chatId,
    `🤖 *Auto-Screening*: ${enable ? '✅ Diaktifkan' : '❌ Dimatikan'}\n\n` +
    (enable
      ? `Hunter akan auto-screen setiap ${getConfig().screeningIntervalMin} menit dan deploy kandidat terbaik otomatis.`
      : `Hunter tidak akan auto-deploy. Gunakan /autoscreen on untuk mengaktifkan kembali.`),
    { parse_mode: 'Markdown' }
  );
});

// ─── Signal Weights command ───────────────────────────────────────

// /setconfig [key] [value] — baca atau ubah config tanpa restart
bot.onText(/\/setconfig(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const key    = match[1]?.trim();
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
      `minTvl                   = ${cfg.minTvl}`,
      `maxTvl                   = ${cfg.maxTvl}`,
      `dryRun                   = ${cfg.dryRun}`,
    ];
    return bot.sendMessage(chatId,
      `⚙️ *Config Saat Ini*\n\n\`\`\`\n${lines.join('\n')}\`\`\`\n\n_Ubah: \`/setconfig key value\`_`,
      { parse_mode: 'Markdown' }
    );
  }

  // Parse nilai
  if (!isConfigKeySupported(key)) {
    return bot.sendMessage(chatId,
      `❌ Key \`${key}\` tidak dikenal atau tidak bisa diubah.`,
      { parse_mode: 'Markdown' }
    );
  }

  let parsed;
  if (rawVal === 'true')        parsed = true;
  else if (rawVal === 'false')  parsed = false;
  else if (!isNaN(rawVal))      parsed = parseFloat(rawVal);
  else                          parsed = rawVal;

  const result = updateConfig({ [key]: parsed });

  // Cek apakah key di-reject (tidak ada di result atau value tidak berubah)
  const saved = result[key];
  if (saved === undefined) {
    return bot.sendMessage(chatId,
      `❌ Key \`${key}\` tidak dikenal atau di luar batas yang diizinkan.`,
      { parse_mode: 'Markdown' }
    );
  }

  bot.sendMessage(chatId,
    `✅ *Config diperbarui*\n\n\`${key}\` → \`${saved}\`\n\n_Berlaku segera, tidak perlu restart._`,
    { parse_mode: 'Markdown' }
  );
});

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
      `🦅 Hunter: ${getConfig().autoScreeningEnabled ? '🤖 auto-screen ON' : '⏸ auto-screen OFF'} | 🩺 Healer: ${cfg.managementIntervalMin}min | 📡 Scanner: 15min\n\n` +
      `/autoscreen on untuk mulai auto-deploy | /start untuk semua commands`
    );
    await runStartupModelCheck(notify);
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
