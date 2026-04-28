/**
 * src/agents/hunterAlpha.js — Linear Sniper Loop (RPC-First)
 *
 * ARSITEKTUR LINEAR (satu thread, berurutan):
 *
 *   SCAN → FILTER → DEPLOY → MONITOR (lock) → EXIT → kembali ke SCAN
 *
 * Tidak ada paralel. Tidak ada queue. Tidak ada DB.
 * Satu posisi aktif pada satu waktu.
 */

'use strict';

import { getConfig }              from '../config.js';
import { screenToken }            from '../market/coinfilter.js';
import { runMeridianVeto, discoverHighFeePoolsMeridian } from '../market/meridianVeto.js';
import { deployPosition, monitorPnL, exitPosition, EP_CONFIG } from '../sniper/evilPanda.js';
import { createMessage }          from '../agent/provider.js';
import { getWalletBalance }       from '../solana/wallet.js';
import { appendDecisionLog }      from '../learn/decisionLog.js';
import { isBlacklisted }          from '../learn/tokenBlacklist.js';

// ── Pool selector: pilih pool terbaik per-token berdasarkan binStep priority ─────────────
//
// Input : array pool untuk satu token yang sama (tokenXMint identik)
// Output: satu pool terpilih
//
// Urutan prioritas: [200, 125, 100] (fee tertinggi dulu).
// Jika tidak ada yang cocok, ambil pool dengan binStep tertinggi yang tersedia.
// Di antara pool dengan binStep sama, pilih yang feeActiveTvlRatio tertinggi.

function selectBestPoolByBinStep(pools, binStepPriority = [200, 125, 100]) {
  if (!pools || pools.length === 0) return null;
  if (pools.length === 1) return pools[0];

  // Coba satu per satu priority
  for (const targetStep of binStepPriority) {
    const candidates = pools.filter(p => p.binStep === targetStep);
    if (candidates.length > 0) {
      // Pilih fee/tvl ratio tertinggi di antara kandidat binStep ini
      return candidates.sort((a, b) => (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))[0];
    }
  }

  // Fallback: tidak ada yang cocok dengan priority list → ambil binStep tertinggi tersedia
  return pools.sort((a, b) => b.binStep - a.binStep || (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0))[0];
}

// ── Group pools by token, kemudian select best per token ─────────────────────────────

function deduplicatePoolsByToken(pools, binStepPriority) {
  // Group by tokenXMint
  const byMint = new Map();
  for (const pool of pools) {
    const mint = pool.tokenXMint || '';
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint).push(pool);
  }

  // Untuk setiap token, pilih pool terbaik
  const result = [];
  for (const [, tokenPools] of byMint) {
    const best = selectBestPoolByBinStep(tokenPools, binStepPriority);
    if (best) result.push(best);
  }

  return result;
}

// ── Notify helper (diset dari index.js) ──────────────────────────
let _notifyFn = null;
export function setNotifyFn(fn) { _notifyFn = fn; }
async function notify(msg) {
  try { await _notifyFn?.(msg); } catch { /* non-fatal */ }
}

// ── State ─────────────────────────────────────────────────────────
let _running   = false;
const _activePositions = []; // [{ pubkey, symbol, poolAddress, mint }]

export function isRunning()            { return _running; }
export function getCurrentPosition()   { return _activePositions.length > 0 ? _activePositions[0].pubkey : null; }
export function getActivePositions()   { return _activePositions; }

// ── Delay helper ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main Linear Loop ─────────────────────────────────────────────

/**
 * Jalankan loop Linear Sniper.
 * Dipanggil sekali dari index.js — berjalan terus sampai di-stop.
 */
export async function runLinearLoop() {
  try {
    if (_running) {
      console.warn('[hunter] Loop sudah berjalan, skip.');
      return;
    }
    _running = true;
    console.log('[hunter] ▶ Linear Sniper Loop dimulai');

    const startCfg = getConfig();
    if (!startCfg.autoScreeningEnabled) {
      await notify('🚀 <b>Linear Sniper aktif.</b>\n⚠️ <i>Auto-Screening OFF. Ketik <code>/autoscreen on</code> untuk mulai.</i>');
    } else {
      await notify('🚀 <b>Linear Sniper aktif.</b> 🔍 Memulai scan real-time (No Cache)...');
    }

    while (_running) {
      try {
        await scanAndDeploy();
      } catch (e) {
        console.error("⚠️ Loop Error:", e.message);
        await sleep(15_000);
      }
    }

    console.log('[hunter] ⏹ Loop dihentikan.');
  } catch (error) {
    console.error("⚠️ Loop Error:", error.message);
    _running = false;
    setTimeout(runLinearLoop, 15000);
  }
}

export function stopLoop() {
  _running = false;
  console.log('[hunter] Stop signal diterima.');
}

// ── Phase 1: SCAN ─────────────────────────────────────────────────

async function scanAndDeploy() {
  const cfg = getConfig();

  // — Gembok: jika auto-screening dimatikan, pause senyap tanpa log
  if (!cfg.autoScreeningEnabled) {
    await sleep(10_000);
    return;
  }

  const limit = cfg.meteoraDiscoveryLimit || 50;

  console.log(`[hunter] 🔍 SCAN — High-Fee Hunter (binStep priority: ${(cfg.binStepPriority || [200,125,100]).join('>')} )...`);
  await notify('🔍 <b>Memulai scan real-time (No Cache)...</b>\nMengambil data, mohon tunggu.');

  let pools;
  try {
    // Ambil semua pool dari Meridian/Meteora (sorted by binStep priority + fee ratio)
    const rawPools = await discoverHighFeePoolsMeridian({ limit });

    // Deduplikasi: satu token mungkin punya beberapa pool.
    // Pilih pool terbaik per-token berdasarkan binStep priority [200,125,100].
    const cfg2          = getConfig();
    const binPriority   = Array.isArray(cfg2.binStepPriority) ? cfg2.binStepPriority.map(Number) : [200, 125, 100];
    pools               = deduplicatePoolsByToken(rawPools, binPriority);

    console.log(`[hunter] ${rawPools.length} pool raw → ${pools.length} token unik setelah seleksi binStep`);
  } catch (e) {
    console.warn(`[hunter] discoverHighFeePoolsMeridian gagal: ${e.message}`);
    await sleep(60_000);
    return;
  }

  if (!pools || pools.length === 0) {
    console.log('[hunter] Tidak ada pool ditemukan. Tunggu 60 detik...');
    await sleep(60_000);
    return;
  }

  console.log(`[hunter] ${pools.length} pool ditemukan. Mulai screening...`);

  // ── Phase 2: FILTER — Strict Serial Screening ────────────
  const scoutCandidates = pools.slice(0, 15);
  console.log(`[hunter] 🔬 Memulai Strict Serial Screening untuk ${scoutCandidates.length} pool...`);

  let winners = [];
  for (const pool of scoutCandidates) {
    if (!_running) return;
    if (winners.length >= 5) break;

    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    const binStep     = pool.binStep || 0;
    const feeRatio    = pool.feeActiveTvlRatio || 0;
    const vol         = pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.volume || 0;

    if (!tokenMint) continue;

    console.log(`[hunter] 📦 Mengevaluasi ${tokenSymbol}...`);

    let isEligible = true;

    // ── Blacklist check ────────────────
    if (isBlacklisted(tokenMint)) {
      appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
        gate: 'BLACKLIST', reason: 'Token ada di daftar blacklist lokal',
        pool: pool.address || '', feeRatio });
      isEligible = false;
    }

    // ── GMGN / Coinfilter screening ─────────────────────────────
    if (isEligible) {
      try {
        const screenResult = await screenToken(tokenMint, tokenSymbol, tokenSymbol);
        if (!screenResult?.eligible) {
          appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'SCREEN_FAIL',
            gate: 'GMGN', reason: screenResult?.verdict || 'FAIL', pool: pool.address || '', feeRatio });
          isEligible = false;
        }
      } catch (e) {
        isEligible = false;
      }
    }

    // ── Meridian VETO (Supertrend 15m + ATH + PVP + Dominance) ────
    if (isEligible) {
      const vetoResult = await runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol, pool });
      if (vetoResult.veto) {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
          gate: vetoResult.gate, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
        isEligible = false;
      } else {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'PASS',
          gate: null, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
      }
    }

    // ── Pure Flat Config gate ─────────────────────────────────────
    if (isEligible) {
      const passesConfig = checkFlatConfig(pool, cfg);
      if (!passesConfig.ok) isEligible = false;
    }

    // ── ScoutAgent (Nvidia) ───────────────────────────────────────
    if (isEligible) {
      try {
        const prompt = `Analisa singkat pool ini:\nToken: ${tokenSymbol}\nBin Step: ${binStep}\nFee/TVL: ${(feeRatio*100).toFixed(2)}%\nVolume: $${Math.round(vol)}\nBalas HANYA dengan 'PASS' jika layak lanjut, atau 'REJECT' jika meragukan.`;
        const res = await createMessage({
          model: cfg.screeningModel,
          maxTokens: 10,
          messages: [{ role: 'user', content: prompt }]
        });
        const ans = res.content.find(c => c.type === 'text')?.text.trim().toUpperCase();
        if (ans && ans.includes('PASS')) {
          console.log(`[hunter] 🤖 ScoutAgent (Nvidia) APPROVED: ${tokenSymbol}`);
          winners.push(pool);
        } else {
          console.log(`[hunter] 🤖 ScoutAgent (Nvidia) REJECTED: ${tokenSymbol}`);
        }
      } catch (e) {
        console.warn(`[hunter] ScoutAgent error pada ${tokenSymbol}: ${e.message}`);
      }
    }

    // Jeda sekuensial untuk memberikan napas pada API
    await sleep(2000);
  }

  if (winners.length === 0) {
    const retryCfg = getConfig();
    const retryMin = Number(retryCfg.screeningIntervalMin) || 15;
    console.log(`[hunter] Tidak ada kandidat lolos Scout. Scan ulang dalam ${retryMin} menit...`);
    await notify(`🔍 <i>Tidak ada kandidat lolos screening. Scan ulang dalam ${retryMin} menit.</i>`);
    await sleep(retryMin * 60 * 1000);
    return;
  }

  // ── GeneralAgent (DeepSeek) Sequential Audit ───────────────────
  console.log(`[hunter] 🧠 GeneralAgent (DeepSeek) memulai final audit sekuensial untuk ${winners.length} kandidat...`);
  let finalWinner = null;

  for (const w of winners) {
    const sym = w.tokenXSymbol || w.name?.split('-')[0];
    const mcap = Math.round(w.mcap || 0).toLocaleString('en-US');
    const vol = Math.round(w.volume24h || w.volume_24h || w.trade_volume_24h || w.tradeVolume24h || w.volume || w.v24h || 0).toLocaleString('en-US');
    
    try {
      const prompt = `Sebagai eksekutor final (GeneralAgent), beri keputusan untuk token ${sym}:\nMCap: $${mcap}\nVolume: $${vol}\nStrategi: Evil Panda.\nBalas HANYA dengan 'BUY' jika eksekusi, atau 'PASS' jika batal.`;
      const res = await createMessage({
        model: cfg.generalModel,
        maxTokens: 10,
        messages: [{ role: 'user', content: prompt }]
      });
      const ans = res.content.find(c => c.type === 'text')?.text.trim().toUpperCase();
      
      if (ans && ans.includes('BUY')) {
        console.log(`[hunter] 🎯 GeneralAgent MEMUTUSKAN BUY: ${sym}`);
        finalWinner = w;
        break; // Segera eksekusi, stop audit sisanya
      } else {
        console.log(`[hunter] ✋ GeneralAgent PASS: ${sym}`);
      }
    } catch (e) {
      console.warn(`[hunter] GeneralAgent error pada ${sym}: ${e.message}`);
    }
  }

  if (!finalWinner) {
    const retryCfg = getConfig();
    const retryMin = Number(retryCfg.screeningIntervalMin) || 15;
    console.log(`[hunter] GeneralAgent membatalkan semua kandidat. Scan ulang dalam ${retryMin} menit...`);
    await sleep(retryMin * 60 * 1000);
    return;
  }

  const winner = finalWinner;

  // ── Phase 3: DEPLOY & SLOT MANAGEMENT ───────────────────────────
  const cfg2        = getConfig();
  
  // 1. Kapasitas Slot
  const maxPositions = cfg2.maxPositions || 1;
  const activePositionsCount = _activePositions.length;
  let availableSlots = maxPositions - activePositionsCount;

  if (availableSlots <= 0) {
    console.log(`[hunter] ⚠️ Kapasitas penuh (Max ${maxPositions}). Bot standby memantau exit...`);
    await sleep(15_000);
    return;
  }

  // 2. Filter Deduplikasi (Anti Double-Entry)
  const activeMints = _activePositions.map(p => p.mint);
  const eligibleWinners = winners.filter(w => {
    const mint = w.tokenXMint || w.tokenX || w.mint || w.address;
    return !activeMints.includes(mint);
  });

  if (eligibleWinners.length === 0) {
    console.log('[hunter] Semua kandidat Top 5 sudah ada di posisi aktif. Standby...');
    await sleep(15_000);
    return;
  }

  const candidateListStr = eligibleWinners.map((p, i) => {
    const sym   = p.name || p.tokenXMint?.slice(0, 8) || 'UNKNOWN';
    const ratio = ((p.feeActiveTvlRatio || 0) * 100).toFixed(2);
    const tvlRaw= Number(p.totalTvl || p.activeTvl || 0);
    const volRaw= Number(p.volume24h || p.volume_24h || p.trade_volume_24h || p.tradeVolume24h || p.volume || p.v24h || 0);
    const mcap  = Math.round(p.mcap || 0).toLocaleString('en-US');
    const effValue = volRaw / (tvlRaw || 1);
    const eff   = effValue > 1000 ? '>1000' : effValue.toFixed(2);
    const mark  = i === 0 ? '🏆' : '✅';
    return `${i+1}. ${mark} <b>${sym}</b> [${p.binStep || '?'}] — Eff: <code>${eff}x</code>\n   Fee/TVL: <code>${ratio}%</code> | MCap: <code>$${mcap}</code>`;
  }).join('\n\n');

  await notify(
    `🎯 <b>Top ${eligibleWinners.length} Kandidat Tersedia (Deduplicated)</b>\n\n` +
    `${candidateListStr}\n\n` +
    `Mengeksekusi kandidat yang tersedia...`
  );

  // 3. Iterative Deployment
  for (const winner of eligibleWinners) {
    if (availableSlots <= 0) break;

    const poolAddress = winner.address || winner.pool_address || winner.pool;
    const tokenMint   = winner.tokenXMint || winner.tokenX || winner.mint || poolAddress;
    const symbol      = winner.tokenXSymbol || winner.name?.split('-')[0] || poolAddress.slice(0,8);

    await notify(
      `Mengeksekusi <b>${symbol}</b>...\n` +
      `Deploy: <code>${cfg2.deployAmountSol || 0.1} SOL</code>\n` +
      `⏳ <i>Membuka posisi pada pool <code>${poolAddress.slice(0,8)}</code>...</i>`
    );

    let positionPubkey;
    try {
      positionPubkey = await deployPosition(poolAddress);
      _activePositions.push({ pubkey: positionPubkey, symbol, poolAddress, mint: tokenMint });
    } catch (e) {
      console.error(`[hunter] deployPosition gagal: ${e.message}`);
      await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Lanjut ke kandidat berikutnya...</i>`);
      continue;
    }

    await notify(
      `✅ <b>Posisi terbuka!</b>\n` +
      `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
      `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
      `TP: +${EP_CONFIG.TAKE_PROFIT_PCT}% | SL: -${EP_CONFIG.STOP_LOSS_PCT}%\n\n` +
      `🔒 <i>Masuk mode monitor (Background)...</i>`
    );

    // 4. MONITOR Loop (Asynchronous, tidak ngeblok iterasi)
    monitorLoop(positionPubkey, symbol, poolAddress).catch(err => {
      console.error(`[hunter] Monitor loop crash untuk ${symbol}:`, err);
    });

    availableSlots--;

    // 5. Jeda antar eksekusi untuk cegah RPC rate-limit
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Phase 4: MONITOR loop (while position active) ────────────────

async function monitorLoop(positionPubkey, symbol, poolAddress) {
  console.log(`[hunter] 🔒 MONITOR lock: ${positionPubkey.slice(0,8)}`);
  let consecutiveErrors = 0;

  while (_running) {
    await sleep(EP_CONFIG.MONITOR_INTERVAL_MS);

    let status;
    try {
      status = await monitorPnL(positionPubkey);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.warn(`[hunter] monitorPnL error (${consecutiveErrors}): ${e.message}`);
      if (consecutiveErrors >= 5) {
        await notify(`⚠️ <b>Monitor error 5x berturut.</b> Force exit...\n<code>${e.message}</code>`);
        await safeExit(positionPubkey, 'MONITOR_ERROR');
        return;
      }
      continue;
    }

    const { action, currentValueSol, pnlPct, inRange } = status;

    if (action === 'ERROR') {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        await notify(`⚠️ <b>Status error 5x berturut.</b> Force exit...`);
        await safeExit(positionPubkey, 'STATUS_ERROR');
        return;
      }
      continue;
    }

    // Log ringkas tiap poll
    const rangeIcon = inRange ? '🟢' : '🟡';
    console.log(`[hunter] ${rangeIcon} ${symbol} pnl=${pnlPct.toFixed(2)}% val=${currentValueSol.toFixed(4)}SOL action=${action}`);

    // Exit trigger
    if (action === 'TAKE_PROFIT') {
      await notify(
        `🎉 <b>TAKE PROFIT!</b>\n` +
        `Token: <b>${symbol}</b>\n` +
        `PnL: <code>+${pnlPct.toFixed(2)}%</code>\n` +
        `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
        (status.exitScenario ? `📊 Skenario <b>${status.exitScenario}</b>: <code>${status.exitReason || ''}</code>\n` : '') +
        `\n⏳ <i>Menutup posisi...</i>`
      );
      await safeExit(positionPubkey, `TAKE_PROFIT_${status.exitScenario || 'TA'}`);
      return;
    }

    if (action === 'STOP_LOSS') {
      await notify(
        `🛑 <b>STOP LOSS!</b>\n` +
        `Token: <b>${symbol}</b>\n` +
        `PnL: <code>${pnlPct.toFixed(2)}%</code>\n` +
        `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n\n` +
        `⏳ <i>Menutup posisi...</i>`
      );
      await safeExit(positionPubkey, 'STOP_LOSS');
      return;
    }
  }

  // Loop dihentikan dari luar — exit posisi
  await notify(`⏹ <b>Loop dihentikan.</b> Menutup posisi aktif...`);
  await safeExit(positionPubkey, 'LOOP_STOPPED');
}

// ── Exit helper ───────────────────────────────────────────────────

async function safeExit(positionPubkey, reason) {
  try {
    const { solRecovered } = await exitPosition(positionPubkey, reason);
    const balance = await getWalletBalance();
    await notify(
      `✅ <b>Posisi ditutup (${reason})</b>\n` +
      `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
      `Balance: <code>${balance} SOL</code>`
    );
  } catch (e) {
    console.error(`[hunter] exitPosition error: ${e.message}`);
    await notify(`⚠️ <b>Exit gagal:</b>\n<code>${e.message}</code>\n\n<i>Posisi mungkin masih terbuka on-chain!</i>`);
  } finally {
    // 6. Bebaskan Slot (Hapus dari _activePositions)
    const idx = _activePositions.findIndex(p => p.pubkey === positionPubkey);
    if (idx > -1) {
      _activePositions.splice(idx, 1);
      console.log(`[hunter] Slot dibebaskan. Posisi aktif tersisa: ${_activePositions.length}`);
    }
  }
}

// ── Pure Flat Config Gate ─────────────────────────────────────────

function checkFlatConfig(pool, cfg) {
  const vol24h   = safeNum(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.tradeVolume24h || pool.volume24hRaw || pool.volume || pool.v24h || 0);
  const minVol   = Number(cfg.minVolume) || 0;
  const maxVol   = Number(cfg.maxVolume) || 0;
  const binStep  = pool.binStep || 0;
  const feeRatio = pool.feeActiveTvlRatio || 0;
  const minFee   = cfg.minFeeActiveTvlRatio || 0;

  const binStepPriority = Array.isArray(cfg.binStepPriority) && cfg.binStepPriority.length > 0
    ? cfg.binStepPriority.map(Number)
    : [200, 125, 100];

  if (!binStepPriority.includes(binStep)) {
    return { ok: false, reason: `binStep ${binStep} not in priority list [${binStepPriority}]` };
  }
  if (minVol > 0 && vol24h < minVol) {
    return { ok: false, reason: `vol24h $${vol24h.toLocaleString()} < min $${minVol.toLocaleString()}` };
  }
  if (maxVol > 0 && vol24h > maxVol) {
    return { ok: false, reason: `vol24h $${vol24h.toLocaleString()} > max $${maxVol.toLocaleString()}` };
  }
  if (minFee > 0 && feeRatio < minFee) {
    return { ok: false, reason: `fee/tvl ${(feeRatio*100).toFixed(4)}% < min ${(minFee*100).toFixed(4)}%` };
  }
  return { ok: true };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Auto-Screening Manual Runner ───────────────────────────────────
// Dipanggil oleh /screening dan awal /autoscreen on

let _autoScreenTimer = null;

export async function runAutoscreening(bot, chatId) {
  const cfg = getConfig();
  
  // Guard rekursif: Hentikan loop jika Autoscreen dimatikan dari config
  if (!cfg.autoScreeningEnabled) {
    if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
    return;
  }

  await bot.sendMessage(chatId, `🔍 <b>Memulai scan real-time (No Cache)...</b>\nMencari kandidat terbaik.`, { parse_mode: 'HTML' });

  try {
    const limit = Number(cfg.meteoraDiscoveryLimit) || 180;
    const pools = await discoverHighFeePoolsMeridian({ limit });
    
    if (!pools || pools.length === 0) {
      await bot.sendMessage(chatId, '⚠️ Belum ada kandidat Top 5 yang lolos filter efisiensi saat ini. Menunggu scan berikutnya...', { parse_mode: 'HTML' });
    } else {
      // Urutkan berdasarkan Efficiency Score (Volume / TVL), ambil top 5
      const top5 = [...pools]
        .sort((a, b) => {
          const aTvl = Number(a.activeTvl || a.totalTvl || 0) || 1;
          const bTvl = Number(b.activeTvl || b.totalTvl || 0) || 1;
          const aVol = Number(a.volume24h || a.volume_24h || a.trade_volume_24h || a.tradeVolume24h || a.volume || a.v24h || 0);
          const bVol = Number(b.volume24h || b.volume_24h || b.trade_volume_24h || b.tradeVolume24h || b.volume || b.v24h || 0);
          return (bVol / bTvl) - (aVol / aTvl);
        })
        .slice(0, 5);

      if (top5.length === 0) {
         await bot.sendMessage(chatId, '⚠️ Belum ada kandidat Top 5 yang lolos filter efisiensi saat ini. Menunggu scan berikutnya...', { parse_mode: 'HTML' });
      } else {
        const lines = await Promise.all(top5.map(async (pool, i) => {
          const symbol  = pool.name || pool.tokenXMint?.slice(0, 8) || 'UNKNOWN';
          const ratio   = ((pool.feeActiveTvlRatio || 0) * 100).toFixed(2);
          const tvlRaw  = Number(pool.totalTvl || pool.activeTvl || 0);
          const tvl     = safeNum(tvlRaw, 0).toLocaleString('en-US');
          const mcap    = safeNum(pool.mcap, 0).toLocaleString('en-US');
          const volRaw  = Number(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.tradeVolume24h || pool.volume || pool.v24h || 0);
          const vol     = safeNum(volRaw, 0).toLocaleString('en-US');
          const effValue= volRaw / (tvlRaw || 1);
          const eff     = effValue > 1000 ? '>1000' : effValue.toFixed(2);
          const binStep = pool.binStep || '?';

          let stIcon = '⚪';
          try {
            const veto = await runMeridianVeto({ mint: pool.tokenXMint || pool.address || '', symbol, pool });
            if (!veto.veto) {
              stIcon = `🟢 ${veto.reason || 'PASS'}`;
            } else {
              stIcon = `🔴 ${veto.reason || 'VETO'}`;
            }
          } catch (e) {
            stIcon = `⚪ (API skip: ${e.message})`;
          }

          return (
            `<b>${i + 1}. ${symbol}</b> [${binStep}]\n` +
            `   Eff: <code>${eff}x</code> | Fee/TVL: <code>${ratio}%</code>\n` +
            `   TVL: <code>$${tvl}</code> | Vol: <code>$${vol}</code> | MCap: <code>$${mcap}</code>\n` +
            `   Status: ${stIcon}`
          );
        }));

        const report = `📊 <b>Top 5 Pool Efisien (Real-time)</b>\n\n` + lines.join('\n\n');
        await bot.sendMessage(chatId, report, { parse_mode: 'HTML', disable_web_page_preview: true });
      }
    }
  } catch (error) {
    console.error("⚠️ Loop Error:", error.message);
    bot.sendMessage(chatId, `❌ Error scanning: ${error.message}. Retrying in 15s...`);
    // Retry instan dengan jeda singkat sebelum mati/zombie
    if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
    _autoScreenTimer = setTimeout(() => runAutoscreening(bot, chatId), 15000);
    return; // Cegah tertimpa set interval default di bawah
  }

  // Rekursif Loop: Eksekusi berulang HANYA setelah proses fetch sebelumnya sepenuhnya selesai
  const intervalMin = Number(cfg.screeningIntervalMin) || 15;
  const intervalMs  = intervalMin * 60 * 1000;
  if (_autoScreenTimer) clearTimeout(_autoScreenTimer); // Bersihkan sisa timer lama
  _autoScreenTimer = setTimeout(() => runAutoscreening(bot, chatId), intervalMs);
}
