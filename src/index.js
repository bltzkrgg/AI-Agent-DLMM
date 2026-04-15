import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { PublicKey } from '@solana/web3.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSolana, getConnection, getWallet, getWalletBalance, runMidnightSweeper } from './solana/wallet.js';
import { processMessage } from './agent/claude.js';
import { handleStrategyCommand, isInStrategySession } from './strategies/strategyHandler.js';
import { runHunterAlpha, getCandidates } from './agents/hunterAlpha.js';
import { runHealerAlpha, runPanicWatchdog, executeTool, runSelfHealingSync } from './agents/healerAlpha.js';
import { learnFromPool, learnFromMultiplePools, loadLessons, pinLesson, unpinLesson, deleteLesson, clearAllLessons, formatLessonsList, getBrainSummary } from './learn/lessons.js';
import { getConfig, getThresholds, updateConfig, isConfigKeySupported } from './config.js';
import { handleConfirmationReply, getSafetyStatus, setStartingBalanceUsd } from './safety/safetyManager.js';
import { evolveFromTrades, getMemoryStats, getInstinctsContext } from './market/memory.js';
import { extractStrategiesFromArticle, summarizeArticle } from './market/researcher.js';
import { getLibraryStats } from './market/strategyLibrary.js';
import { screenToken, formatScreenResult } from './market/coinfilter.js';
import { safeNum } from './utils/safeJson.js';
import { getOpenPositions, getPositionStats } from './db/database.js';
import { getPositionInfo, getPositionInfoLight, getSolPriceUsd } from './solana/meteora.js';
import { padR, hr, kv, codeBlock, formatPnl, shortAddr, shortStrat } from './utils/table.js';
import { initMonitor } from './monitor/positionMonitor.js';
import { autoEvolveIfReady, runEvolutionCycle } from './learn/evolve.js';
import { getTodayResults, formatDailyReport, savePerformanceSnapshot, backupAllData } from './market/strategyPerformance.js';
import { runStartupModelCheck, formatModelStatus, testModel, testCurrentModel, fetchFreeModels } from './agent/modelCheck.js';
import { discoverAllModels, formatModelList, listAvailableModels, getModelInfo, initializeModelDiscovery } from './agent/modelDiscovery.js';
import { runOpportunityScanner } from './market/opportunityScanner.js';
import { addSmartWallet, removeSmartWallet, formatWalletList } from './market/smartWallets.js';
import { formatPoolMemoryReport } from './market/poolMemory.js';
import { recalibrateWeights, formatWeightsReport } from './market/signalWeights.js';
import { validateRuntimeEnv } from './runtime/env.js';
import { resolvePositionSnapshot } from './app/positionSnapshot.js';
import { getWalletPositions, isLPAgentEnabled } from './market/lpAgent.js';
import { DbBackup } from './db/backup.js';
import { initializeRpcManager, getRpcMetrics } from './utils/helius.js';
import { CircuitBreaker } from './safety/circuitBreaker.js';
import { createMessageTransport } from './telegram/messageTransport.js';

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

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const cfg = getConfig();
initMonitor(bot, ALLOWED_ID);

// ─── Shared Utilities ───────────────────────────────────────────
const transport = createMessageTransport(bot, ALLOWED_ID);
const sendLong = transport.sendLong;

async function notify(text) {
  transport.notify(text).catch(e => console.error('Notify error:', e.message));
}

async function urgentNotify(text) {
  const urgentText = `🚨 *URGENT INTERVENTION REQUIRED*\n\n${text}\n\n⚠️ _Sistem menghentikan sementara operasional untuk posisi ini. Silakan cek manual._`;
  return transport.notify(urgentText).catch(e => console.error('Urgent notify error:', e.message));
}

// Initialize DB backup system
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BOT_DB_PATH || join(__dirname, '../data.db');
const dbBackup = new DbBackup(dbPath, './backups');

// Initialize Circuit Breaker untuk system safety
const circuitBreaker = new CircuitBreaker({
  errorThreshold: 3,
  errorWindow: 5 * 60 * 1000,
  latencyThreshold: 5000,
  latencyWindow: 5 * 60 * 1000,
  healthCheckInterval: 30000,
  recoverySuccessThreshold: 3,
  autoStart: true,
  onTrip: async (info) => {
    const msg = `🚨 *CIRCUIT BREAKER TRIPPED*\n\nReason: ${info.reason}\nTime: ${new Date(info.tripTime).toISOString()}\n\n⛔ Trading paused (Hunter/Healer offline)`;
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  },
  onRecover: async (info) => {
    const timeOpen = (info.timeOpenMs / 1000 / 60).toFixed(2);
    const msg = `✅ *CIRCUIT BREAKER RECOVERED*\n\nRecovery time: ${new Date(info.recoveryTime).toISOString()}\nDowntime: ${timeOpen} minutes\n\n🚀 Trading resumed (Hunter/Healer online)`;
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  },
  onHealthCheck: async (info) => {
    if (info.state !== 'CLOSED') {
      console.log(`CB health check (${info.state}):`, info.metrics);
    }
  },
});

// Initialize API fallback providers (dengan circuit breaker)
const rpcManager = initializeRpcManager(circuitBreaker);

let solanaReady = false;
try {
  initSolana();
  solanaReady = true;
} catch (e) {
  console.warn(`⚠️ Solana wallet init failed: ${e.message}`);
  console.warn('Bot will start but trading features will be disabled until wallet is fixed.');
}

const _dryRun = cfg.dryRun;
console.log(`🦞 Meteora DLMM Bot started! Mode: ${_dryRun ? 'DRY RUN' : 'LIVE'}`);

// Kirim sinyal standby pas bot nyala
const bootStatus = solanaReady ? '🚀 *Bot Started!*' : '⚠️ *Bot Started (DEGRADED)*';
const walletNote = solanaReady ? '' : '\n_Wallet/RPC gagal inisialisasi. Fitur trading dipause._';

const bootMsg = `${bootStatus} (Mode: Survivalist)\n\n` +
               `🛡️ Hunter: *${solanaReady ? 'ON' : 'OFF'}* (Standby ⏳)\n` +
               `🩺 Healer: *${solanaReady ? 'ON' : 'OFF'}* (Standby ⏳)\n${walletNote}\n\n` +
               `_Sesuai jadwal, bot akan mulai bekerja dalam ${cfg.managementIntervalMin} - ${cfg.screeningIntervalMin} menit._`;
bot.sendMessage(ALLOWED_ID, bootMsg, { parse_mode: 'Markdown' }).catch(() => {});

async function syncStartingBalanceBaseline() {
  if (!solanaReady) return;
  try {
    const [balance, solPriceUsd] = await Promise.all([
      getWalletBalance(),
      getSolPriceUsd().catch(() => 150),
    ]);
    const balanceUsd = safeNum(balance) * solPriceUsd;
    setStartingBalanceUsd(safeNum(balanceUsd.toFixed(2)));
  } catch (e) {
    console.warn(`⚠️ Failed to sync starting balance baseline: ${e.message}`);
  }
}

await syncStartingBalanceBaseline();

// ─── Health check: Detect manually-closed positions ────────────────
async function syncPositionStates() {
  if (!solanaReady) return;
  try {
    const connection = getConnection();
    const openPositions = getOpenPositions();

    if (!openPositions || openPositions.length === 0) {
      console.log('✅ No open positions to sync');
      return;
    }

    console.log(`🔍 Syncing on-chain state for ${openPositions.length} open positions...`);
    const { closePositionWithPnl } = await import('./db/database.js');

    let closedCount = 0;
    for (const pos of openPositions) {
      try {
        const positionPubKey = new PublicKey(pos.position_address);
        const accountInfo = await connection.getAccountInfo(positionPubKey);

        if (accountInfo === null) {
          // Position account tidak ada on-chain tapi masih di DB → closed manual
          console.log(`⚠️ Position ${pos.position_address} closed manually (account not found on-chain)`);
          await closePositionWithPnl(pos.position_address, {
            pnlUsd: 0,
            pnlPct: 0,
            feesUsd: 0,
            closeReason: 'manually_closed',
            lifecycleState: 'closed_manual',
          });
          closedCount++;
        }
      } catch (e) {
        console.warn(`⚠️ Could not check position ${pos.position_address}: ${e.message}`);
      }
    }

    if (closedCount > 0) {
      console.log(`✅ Synced: ${closedCount} manually-closed positions detected and updated`);
    }
  } catch (e) {
    console.warn(`⚠️ Position sync failed: ${e.message}`);
  }
}

await syncPositionStates();
await runSelfHealingSync(notify);

async function getLpPnlMap() {
  const pnlMap = new Map();
  if (!isLPAgentEnabled() || !solanaReady) return pnlMap;

  try {
    const owner = getWallet()?.publicKey?.toString?.();
    const positions = await getWalletPositions(owner);
    if (!Array.isArray(positions)) return pnlMap;
    for (const position of positions) {
      if (position?.address && Number.isFinite(position.pnlPct)) {
        pnlMap.set(position.address, position.pnlPct);
      }
    }
  } catch { /* best-effort */ }

  return pnlMap;
}


// ─── Busy flags — cegah 2 cycle jalan bersamaan ──────────────────
// Menggunakan timestamp (Date.now()) untuk mendukung lock expiration
let _hunterBusy = 0;
let _healerBusy = 0;
let _screeningBusy = 0;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 menit

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
  if (!circuitBreaker.isHealthy()) {
    notify(`⚠️ Circuit Breaker AKTIF (state: ${circuitBreaker.getState().state}). Trading sedang dipause karena sistem degraded.`).catch(() => {});
    return;
  }
  if (_hunterBusy && (Date.now() - _hunterBusy < LOCK_TIMEOUT_MS)) return;
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
  _hunterBusy = Date.now();
  try { 
    await runHunterAlpha(notify, bot, ALLOWED_ID, { targetCount }); 
  }
  catch (e) { 
    await urgentNotify(`❌ *Hunter Panic*\nReason: ${e.message}`);
    console.error(`Hunter Critical Failure:`, e); 
  }
  finally { _hunterBusy = 0; }
}

// Healer — hanya manage posisi, tidak ada reopen prompt
async function runHealerWithReopenCheck() {
  if (!solanaReady) return;
  if (!circuitBreaker.isHealthy()) {
    console.log(`⏭ Healer skip — Circuit Breaker ${circuitBreaker.getState().state}`);
    return;
  }
  await runHealerAlpha(notify);
}


// ─── High-Frequency Watchdog (Panic Exit) ───────────────────────
// Berjalan tiap 5 menit untuk nangkis dump cepat (Supertrend + OOR) tanpa LLM.
cron.schedule('*/5 * * * *', async () => {
  if (!solanaReady) return;
  
  // SHARED LOCK: Jangan jalan kalau Healer utama lagi kerja
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) {
    console.log('⏭ Watchdog skip — Healer loop sedang berjalan');
    return;
  }
  
  _healerBusy = Date.now(); // Kunci posisi biar nggak diganggu Healer
  try {
    await runPanicWatchdog(notify);
  } catch (e) {
    console.error('Watchdog error:', e.message);
  } finally {
    _healerBusy = 0; // Lepas kunci
  }
});

// ─── Hourly Position Recovery (Layer 7 Self-Healing) ────────────
cron.schedule('0 * * * *', async () => {
  if (!solanaReady) return;
  try {
    await runSelfHealingSync(notify);
  } catch (e) {
    console.error('Hourly self-healing error:', e.message);
  }
});

// ─── Cron jobs ───────────────────────────────────────────────────
// Semua cron jalan setiap menit dan cek interval live dari config.
// Ini memungkinkan perubahan interval via /setconfig TANPA restart bot.

let _lastHealerRun    = Date.now(); // delay run pertama sampai interval berlalu
let _lastScreeningRun = Date.now();
let _lastBalanceWarningAt = 0; // cooldown notif saldo low

cron.schedule('* * * * *', async () => {
  if (!solanaReady) return; // Prevent management spam if no wallet
  const liveCfg = getConfig();
  const now     = Date.now();
  if (now - _lastHealerRun < liveCfg.managementIntervalMin * 60 * 1000) return;
  // Update SETELAH cek busy — supaya timer tidak mundur saat healer masih jalan
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) { console.log('⏭ Healer skip — masih berjalan'); return; }
  _lastHealerRun = now;
  _healerBusy = Date.now();
  try {
    await runHealerWithReopenCheck();
    autoEvolveIfReady(notify).catch(e => console.error('Auto-evolve error:', e.message));
    try { recalibrateWeights(); } catch { /* data belum cukup, skip */ }
    savePerformanceSnapshot();
  }
  catch (e) { 
    await urgentNotify(`🩺 *Healer Panic*\nReason: ${e.message}\n_Check Solscan for hanging transactions._`);
    console.error(`Healer Critical Failure:`, e);
  }
  finally { _healerBusy = 0; }
});

// ─── Auto-screening Hunter — interval dibaca live dari config ────
// Aktif hanya jika autoScreeningEnabled = true di config.
// Screen pool terbaik, langsung deploy kandidat teratas (tanpa approval).

async function runAutoScreening() {
  if (!solanaReady) return;
  if (!circuitBreaker.isHealthy()) {
    console.log(`⏭ Auto-screening skip — Circuit Breaker ${circuitBreaker.getState().state}`);
    return;
  }
  const now = Date.now();
  const isHunterBusy = _hunterBusy && (now - _hunterBusy < LOCK_TIMEOUT_MS);
  const isScreeningBusy = _screeningBusy && (now - _screeningBusy < LOCK_TIMEOUT_MS);
  if (isScreeningBusy || isHunterBusy) return;

  const liveCfg = getConfig();
  if (!liveCfg.autoScreeningEnabled) return;

  // ─── Daily Circuit Breaker Check ─────────────────────────────
  // Jika PnL hari ini ditutup minus lebih dari dailyLossLimitUsd ($5), Hunter istirahat.
  const today = getTodayResults();
  const dailyPnl = today.totalPnlUsd + today.totalFeesUsd; // Net harian $
  if (dailyPnl < -liveCfg.dailyLossLimitUsd) {
    const isFirstAlert = Date.now() - _lastBalanceWarningAt > 12 * 60 * 60 * 1000;
    if (isFirstAlert) {
      _lastBalanceWarningAt = Date.now();
      urgentNotify(
        `🛡️ *DAILY CIRCUIT BREAKER ACTIVE*\n\n` +
        `Net PnL Hari Ini: \`$${dailyPnl.toFixed(2)}\`\n` +
        `Limit Kerugian: \`$${liveCfg.dailyLossLimitUsd.toFixed(2)}\`\n\n` +
        `_Batas kerugian harian tercapai. Hunter dipaksa istirahat demi keamanan modal lu, Bos!_`
      ).catch(() => {});
    }
    console.log(`[index] Daily Circuit Breaker: Skip screening (Daily PnL: $${dailyPnl.toFixed(2)})`);
    return;
  }

  const openPos = getOpenPositions();
  if (openPos.length >= liveCfg.maxPositions) {
    console.log(`⏭ Hunter skip — slot penuh (${openPos.length}/${liveCfg.maxPositions})`);
    return;
  }

  const balance = await getWalletBalance().catch(() => '0');
  const needed = liveCfg.deployAmountSol + (liveCfg.gasReserve ?? 0.02);
  
  if (safeNum(balance) < needed) {
    const balNum = safeNum(balance).toFixed(4);
    console.log(`⏭ Hunter skip — saldo low (${balNum} < ${needed.toFixed(2)})`);
    
    // Log internal & skip (notifikasi sudah ditangani oleh Global Low Gas Alert per jam)
    console.log(`⏭ Hunter skip — saldo low (${balNum} < ${needed.toFixed(2)})`);
    return;
  }

  // Reset warning kalau saldo sudah cukup lagi
  _lastBalanceWarningAt = 0;

  _screeningBusy = Date.now();
  _hunterBusy    = Date.now();
  try {
    await runHunterAlpha(notify, bot, ALLOWED_ID);
  } catch (e) {
    console.error('Auto-screening error:', e.message);
    notify(`❌ Auto-screening error: ${e.message}`).catch(() => {});
  } finally {
    _screeningBusy = 0;
    _hunterBusy    = 0;
  }
}

cron.schedule('* * * * *', async () => {
  if (!solanaReady) return; // Prevent screening spam if no wallet
  const liveCfg = getConfig();
  const now     = Date.now();
  if (now - _lastScreeningRun < liveCfg.screeningIntervalMin * 60 * 1000) return;
  _lastScreeningRun = now;
  try { await runAutoScreening(); }
  catch (e) { console.error('Auto-screening cron error:', e.message); }
});


// ─── Daily Backup jam 2 pagi ─────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  try {
    savePerformanceSnapshot();
    const count = backupAllData();
    console.log(`💾 Daily backup selesai: ${count} file disimpan ke backups/`);

    // Backup database
    const dbBackupPath = await dbBackup.createBackup();
    if (dbBackupPath) {
      console.log(`💾 Database backup created: ${dbBackupPath}`);
    }
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
// Scan top 25 pools untuk strategi: Evil Panda Master
// Alert dikirim regardless posisi terbuka / balance / status deploy
// KOMENTAR: Dimatikan atas permintaan user untuk mengurangi noise notifikasi.
// ─── Global Low Gas Alert — setiap jam ──────────────────────────
// Memastikan bot selalu punya SOL untuk gas (Healer/Rescue)
cron.schedule('0 * * * *', async () => {
  if (!solanaReady) return;
  try {
    const balance = await getWalletBalance();
    const balNum = safeNum(balance);
    if (balNum < 0.05) {
      const walletAddr = getWallet().publicKey.toString();
      await urgentNotify(
        `⛽ *URGENT: Saldo SOL Kritis!*\n\n` +
        `Sisa saldo: \`${balNum.toFixed(4)} SOL\`\n` +
        `Target wallet: \`${walletAddr}\`\n\n` +
        `_Segera isi bensin biar si Healer gak mogok pas mau nyelametin modal lu, Bos!_`
      );
    }
  } catch (e) { console.error('Low Gas Alert error:', e.message); }
});

// ─── Midnight Sweeper — setiap hari jam 1 pagi ──────────────────
cron.schedule('0 1 * * *', async () => {
  try {
    await runMidnightSweeper(notify);
  } catch (e) { console.error('Midnight sweeper error:', e.message); }
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
      kv('Balance', `${safeNum(balance).toFixed(4)} SOL`, 12),
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

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/testmodel/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Testing model connection...');
  try {
    // Test API + fetch available models (operasi lambat, tapi ini memang tujuannya)
    const [testResult, discoveredModels] = await Promise.all([
      testCurrentModel(),
      discoverAllModels(),
    ]);
    let text = formatModelStatus();
    text += `\n\n*Test Result:* ${testResult.ok ? '✅ OK' : `❌ ${testResult.error}`}\n`;
    if (discoveredModels.length > 0) {
      text += `\n📋 *All discovered models (${discoveredModels.length}):*\n`;
      // Show top models by quality
      const topModels = listAvailableModels({ sortBy: 'quality' }).slice(0, 10);
      topModels.forEach(m => {
        const free = m.isFree ? ' 🆓' : '';
        text += `• \`${m.id}\`${free}\n`;
      });
      if (discoveredModels.length > 10) {
        text += `... and ${discoveredModels.length - 10} more\n`;
      }
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

      // Also show available models discovered from configured providers
      const discoveredModels = listAvailableModels({ sortBy: 'quality' });
      if (discoveredModels.length > 0) {
        const modelList = formatModelList(discoveredModels);
        await sendLong(chatId, modelList, { parse_mode: 'Markdown' });
      }
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
    `🦞 *AI-Agent-DLMM* \`[LIVE]\`\n\n` +
    `🐼 *Hunter* — Adaptive Panda logic\n` +
    `🩺 *Healer* — Autonomous position management\n` +
    `🧠 *Brain* — Intelligence dashboard\n\n` +
    `*Monitoring:*\n` +
    `/status — On-chain position details\n` +
    `/pos — Fast REST summary\n` +
    `/results — Daily PnL report\n\n` +
    `*Control:*\n` +
    `/hunting — 🦅 Trigger Hunter Alpha (Sniper)\n` +
    `/heal — 🩺 Trigger Healer Alpha (Position Mgmt)\n` +
    `/zap <addr> — 🆘 Emergency Exit & Swap to SOL\n` +
    `/check <mint> — 🔍 Custom RugCheck\n` +
    `/autoscreen on|off — Toggle Autonomy\n` +
    `/dryrun on|off — Toggle Simulation Mode\n\n` +
    `*Brain & Evolution:*\n` +
    `/brain /lessons /evolve /poolmemory\n\n` +
    `*Admin:*\n` +
    `/setconfig /safety /providers /model /testmodel\n\n` +
    `_Atau chat bebas langsung untuk instruksi manual!_`,
    { parse_mode: 'Markdown' }
  );
});


bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const [balance, openPos, stats, lpPnlMap] = await Promise.all([
      getWalletBalance(),
      Promise.resolve(getOpenPositions()),
      Promise.resolve(getPositionStats()),
      getLpPnlMap(),
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
          const snapshot = resolvePositionSnapshot({
            dbPosition: pos,
            livePosition: match,
            providerPnlPct: lpPnlMap.get(pos.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
          });
          chainMap[pos.position_address] = {
            status:  snapshot.status,
            pnlSol: snapshot.pnlSol,
            pnlPct: snapshot.pnlPct,
            feeSol: snapshot.feeSol,
            pnlSource: snapshot.pnlSource,
            lifecycleState: snapshot.lifecycleState,
            manualClose: false,
          };
        } else {
          chainMap[pos.position_address] = { status: 'NoData' };
        }
      } catch {
        chainMap[pos.position_address] = { status: 'Err' };
      }
    }));

    // Detect suspected manual close, but never mutate DB from /status.
    // Reconciliation must happen in healer flow after stronger verification.
    for (const pos of openPos) {
      const c = chainMap[pos.position_address] || { status: 'Unknown' };
      if (c?.manualClose) {
        let accountExists = true;
        try {
          const info = await getConnection().getAccountInfo(new PublicKey(pos.position_address));
          accountExists = info !== null;
        } catch {
          accountExists = true;
        }

        if (!accountExists) {
          chainMap[pos.position_address] = {
            ...c,
            status: 'SuspectClosed',
            suspectedManualClose: true,
          };
          notify(
            `⚠️ *Suspected Manual Close*\n\n` +
            `Pool     : \`${pos.pool_address}\`\n` +
            `Posisi   : \`${pos.position_address}\`\n` +
            `Strategi : ${pos.strategy_used || '-'}\n\n` +
            `_Posisi tidak terlihat via SDK/API dan account on-chain tidak ditemukan._\n` +
            `_Status bersifat sementara; healer akan reconcile sebelum perubahan DB._`
          ).catch(() => {});
        } else {
          chainMap[pos.position_address] = {
            ...c,
            status: 'RPCInconsistent',
            manualClose: false,
            suspectedManualClose: false,
          };
        }
      }
    }

    // Keep all open positions visible in /status.
    const activePos = openPos;

    // ── Header ───────────────────────────────────────────────────
    let text = `📊 *Status Bot* — 🐼 *ADAPTIVE PANDA*\n\n`;

    const pnlSign  = (v) => safeNum(v) >= 0 ? '+' : '';
    const headerLines = [
      kv('Balance',   `${safeNum(balance).toFixed(4)} SOL`, 10),
      kv('Posisi',    `${activePos.length} / ${getConfig().maxPositions}`, 10),
      kv('Closed',    `${stats.closedPositions}  Win: ${stats.winRate}`, 10),
      kv('PnL',       `${pnlSign(stats.totalPnlUsd)}$${safeNum(stats.totalPnlUsd || 0).toFixed(2)}  Fees: +$${safeNum(stats.totalFeesUsd || 0).toFixed(2)}`, 10),
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
          const lifecycleStr = cd?.lifecycleState ? `  ${cd.lifecycleState}` : '';
          return [`  ${openedAt}  ${shortAddr(pos.position_address)}${feeStr}${lifecycleStr}`, '', '', ''];
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

bot.onText(/\/evolve/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🧬 Menjalankan Evolution Cycle...');
  try {
    const updates = await runEvolutionCycle();
    if (updates) {
      bot.sendMessage(chatId, `✅ *Evolusi Berhasil*\n\nThresholds diperbarui: \`${Object.keys(updates).join(', ')}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada update yang diperlukan. Thresholds saat ini masih optimal berdasarkan data trade terakhir.');
    }
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
});

bot.onText(/\/brain/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  try {
    const summary = getBrainSummary();
    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
  } catch (e) { bot.sendMessage(chatId, `❌ ${e.message}`); }
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
    const [results, lpPnlMap] = await Promise.all([
      Promise.allSettled(poolsToCheck.map(addr => getPositionInfoLight(addr))),
      getLpPnlMap(),
    ]);

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
      const deploySol = safeNum(pos.deployed_sol ?? 0);
      const snapshot = cd ? resolvePositionSnapshot({
        dbPosition: pos,
        livePosition: cd,
        providerPnlPct: lpPnlMap.get(pos.position_address),
        directPnlPct: Number.isFinite(cd?.pnlPct) ? cd.pnlPct : null,
      }) : null;
      const pnlPct    = snapshot ? snapshot.pnlPct.toFixed(2) : '?';
      const pnlSign   = safeNum(pnlPct) >= 0 ? '+' : '';
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
        (snapshot?.lifecycleState ? `  State: \`${snapshot.lifecycleState}\`\n` : '') +
        (priceDisp ? `  Harga: \`${priceDisp}\`\n` : '');
    }

    text += `\n_Data via Meteora API — gunakan /status untuk data on-chain penuh._`;
    await sendLong(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/zap(?:\s+(\S+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const target = match[1]?.trim();

  if (!target) {
    return bot.sendMessage(chatId, '🆘 *Emergency Zap Out*\n\nGunakan: `/zap <mint_atau_pool_address>`\n\n_Perintah ini akan menutup posisi dan swap SEMUA token ke SOL secara paksa via Jupiter (3x retry)._', { parse_mode: 'Markdown' });
  }

  const openPos = getOpenPositions();
  const matchPos = openPos.find(p => p.position_address === target || p.pool_address === target || p.token_x === target);

  if (!matchPos) {
    return bot.sendMessage(chatId, `❌ Posisi tidak ditemukan untuk: \`${target}\``, { parse_mode: 'Markdown' });
  }

  bot.sendMessage(chatId, `⚠️ *KONFIRMASI ZAP OUT*\n\nKamu akan menutup paksa posisi:\nToken: *${matchPos.token_x_symbol || 'unknown'}*\nPool: \`${shortAddr(matchPos.pool_address)}\`\n\nKetik \`GAS ZAP\` untuk mengeksekusi.`, { parse_mode: 'Markdown' });
  
  const confirmHandler = async (cMsg) => {
    if (cMsg.from.id === ALLOWED_ID && cMsg.text === 'GAS ZAP' && cMsg.chat.id === chatId) {
      bot.removeListener('message', confirmHandler);
      bot.sendMessage(chatId, '🚀 *ZAPPING OUT...* ⚡');
      try {
        await executeTool('zap_out', {
          pool_address: matchPos.pool_address,
          position_address: matchPos.position_address,
          reasoning: 'MANUAL_ZAP_EMERGENCY'
        }, notify);
      } catch (e) {
        bot.sendMessage(chatId, `❌ Zap failed: ${e.message}`);
      }
    } else if (cMsg.from.id === ALLOWED_ID && cMsg.chat.id === chatId && cMsg.text !== 'GAS ZAP' && !cMsg.text.startsWith('/')) {
       bot.removeListener('message', confirmHandler);
       bot.sendMessage(chatId, '❌ Zap dibatalkan.');
    }
  };
  bot.on('message', confirmHandler);
  setTimeout(() => bot.removeListener('message', confirmHandler), 30000);
});

bot.onText(/\/pools/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  await handleMessage(msg, 'Analisa dan tampilkan 5 pool DLMM terbaik berdasarkan fee APR saat ini');
});

bot.onText(/\/(hunt|hunting)/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const now = Date.now();
  const isHunterBusy = _hunterBusy && (now - _hunterBusy < LOCK_TIMEOUT_MS);
  const isScreeningBusy = _screeningBusy && (now - _screeningBusy < LOCK_TIMEOUT_MS);
  if (isHunterBusy || isScreeningBusy) {
    bot.sendMessage(msg.chat.id, '⏳ Hunter sedang berjalan (atau terkunci). Tunggu siklus saat ini selesai.');
    return;
  }
  bot.sendMessage(msg.chat.id, '🦅 Menjalankan Hunter Alpha...');
  try { await triggerHunter(); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

bot.onText(/\/heal/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  if (_healerBusy && (Date.now() - _healerBusy < LOCK_TIMEOUT_MS)) {
    bot.sendMessage(msg.chat.id, '⏳ Healer sedang berjalan. Tunggu siklus saat ini selesai.');
    return;
  }
  bot.sendMessage(msg.chat.id, '🩺 Menjalankan Healer Alpha...');
  _healerBusy = Date.now();
  try { await runHealerWithReopenCheck(); }
  catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  finally { _healerBusy = 0; }
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
  const ROOT = join(__dirname, '../data');
  const DATA_FILES = [
    join(ROOT, 'memory.json'),
    join(ROOT, 'lessons.json'),
    join(ROOT, 'strategyPerformance.json'),
    join(__dirname, 'strategy-library.json'),
  ];
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

bot.onText(/\/deletelesson(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const idx = match[1] ? parseInt(match[1]) - 1 : null;
  if (idx === null || isNaN(idx)) {
    bot.sendMessage(msg.chat.id, '❓ Gunakan: `/deletelesson <nomor>` (lihat nomor di /lessons)', { parse_mode: 'Markdown' });
    return;
  }
  const result = deleteLesson(idx);
  if (result.ok) {
    bot.sendMessage(msg.chat.id, `✅ Lesson dihapus: _${result.lesson}_`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ ${result.reason}`);
  }
});

bot.onText(/\/clearlessons/, (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const result = clearAllLessons();
  bot.sendMessage(msg.chat.id, result.ok ? '🗑️ Semua lessons telah dihapus.' : '❌ Gagal menghapus lessons.');
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

// /autoscreen on|off [interval] — toggle auto-screening (alias: /autohunter)
bot.onText(/\/(?:autoscreen|autohunter)(?:\s+(on|off))?(?:\s+(\d+))?/, async (msg, match) => {
  if (msg.from.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  const toggle = match[1]?.toLowerCase();
  const intervalArg = match[2];

  if (!toggle) {
    const current = getConfig().autoScreeningEnabled;
    bot.sendMessage(chatId,
      `🤖 *Auto-Screening*: ${current ? '✅ ON' : '❌ OFF'}\n\n` +
      `Gunakan \`/autoscreen on [interval]\` atau \`/autoscreen off\` untuk toggle.\n` +
      `Interval screening: ${getConfig().screeningIntervalMin} menit`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const enable = toggle === 'on';
  const updates = { autoScreeningEnabled: enable };
  
  if (enable && intervalArg) {
    const val = parseInt(intervalArg);
    if (val >= 5 && val <= 1440) {
      updates.screeningIntervalMin = val;
    }
  }

  updateConfig(updates);

  if (enable) {
    bot.sendMessage(chatId,
      `🤖 *Auto-Screening*: ✅ Diaktifkan\n` +
      `Interval: ${getConfig().screeningIntervalMin} menit\n\n` +
      `⏳ _Bot akan mengikuti jadwal interval yang sudah ditentukan._`,
      { parse_mode: 'Markdown' }
    );
  } else {
    bot.sendMessage(chatId, `🤖 *Auto-Screening*: ❌ Dimatikan. Hunter tidak akan auto-deploy.`, { parse_mode: 'Markdown' });
  }
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

// /providers — tampilkan status RPC, candle providers, dan circuit breaker
bot.onText(/\/providers/, async (msg) => {
  if (msg.from.id !== ALLOWED_ID) return;
  try {
    const rpcMetrics = getRpcMetrics();
    const candleMetrics = candleManager?.getMetrics() || { error: 'Candle manager not initialized' };
    const cbState = circuitBreaker.getState();

    let report = '📡 *API Provider & Safety Status*\n\n';

    // Circuit Breaker status
    const cbStatusIcon = cbState.state === 'CLOSED' ? '✅' : '⛔';
    const cbTimeOpen = cbState.timeOpenMs > 0 ? ` (open ${(cbState.timeOpenMs / 1000 / 60).toFixed(1)}m)` : '';
    report += `🔌 *Circuit Breaker*\n${cbStatusIcon} ${cbState.state}${cbTimeOpen}\n`;
    if (cbState.tripReason) {
      report += `Reason: ${cbState.tripReason}\n`;
    }
    report += `Errors: ${cbState.errorCount}, Latencies: ${cbState.latencyCount}\n\n`;

    if (rpcMetrics.providers) {
      report += '🔗 *RPC Providers*\n';
      rpcMetrics.providers.forEach(p => {
        const status = p.healthy ? '✅' : '❌';
        report += `${status} ${p.name}: errors=${p.errors}, last="${p.lastError || 'OK'}"\n`;
      });
      report += `Cache size: ${rpcMetrics.cacheSize} entries\n\n`;
    } else if (rpcMetrics.error) {
      report += `⚠️ RPC: ${rpcMetrics.error}\n\n`;
    }

    if (candleMetrics.providers) {
      report += '📊 *Candle Providers*\n';
      candleMetrics.providers.forEach(p => {
        const status = p.healthy ? '✅' : '❌';
        report += `${status} ${p.name}: errors=${p.errors}, last="${p.lastError || 'OK'}"\n`;
      });
    }

    sendLong(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(() => {});
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`).catch(() => {});
  }
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

let _pollingRestartCount = 0;
const MAX_POLLING_RESTARTS = 10;

bot.on('polling_error', (e) => {
  console.error('Polling error:', e.message);

  // EFATAL = polling has stopped — restart automatically
  // Ini terjadi saat koneksi Telegram putus akibat timeout/network glitch
  if (e.code === 'EFATAL' || e.message?.includes('EFATAL')) {
    if (_pollingRestartCount >= MAX_POLLING_RESTARTS) {
      console.error(`❌ Polling restart limit (${MAX_POLLING_RESTARTS}x) tercapai. Restart bot manual.`);
      return;
    }
    _pollingRestartCount++;
    const delay = Math.min(5000 * _pollingRestartCount, 60000); // exponential, max 60s
    console.warn(`⚠️ EFATAL terdeteksi — restart polling dalam ${delay / 1000}s... (${_pollingRestartCount}/${MAX_POLLING_RESTARTS})`);
    setTimeout(() => {
      bot.startPolling().then(() => {
        console.log('✅ Polling Telegram berhasil di-restart.');
        _pollingRestartCount = 0; // reset counter saat berhasil
      }).catch(err => console.error('❌ Polling restart gagal:', err.message));
    }, delay);
  }
});

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
    // Initialize model discovery to discover all available models from configured providers
    console.log('🔍 Initializing model discovery...');
    await initializeModelDiscovery();

    const balance = await getWalletBalance();
    const today = getTodayResults();
    const dailyPnl = today.totalPnlUsd + today.totalFeesUsd;
    const cbStatus = dailyPnl < -cfg.dailyLossLimitUsd ? '🛑 LOCKED (Loss Limit)' : '✅ READY';

    await notify(
      `🚀 *Bot Started!*\n\n` +
      `💰 Balance: ${balance} SOL | 📊 Daily PnL: \`$${dailyPnl.toFixed(2)}\`\n` +
      `🛡️ Circuit Breaker: *${cbStatus}*\n` +
      `🦅 Hunter: ${cfg.autoScreeningEnabled ? '🤖 auto-screen ON' : '⏸ auto-screen OFF'} | 🩺 Healer: ON\n\n` +
      `/status untuk cek posisi | /start untuk semua commands`
    );
    await runStartupModelCheck(notify);
  } catch (e) { console.error('Startup error:', e.message); }
}, 2000);
