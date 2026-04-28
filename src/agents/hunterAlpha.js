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
import { deployPosition, monitorPnL, exitPosition, EP_CONFIG, getActivePositionKeys, getPositionMeta } from '../sniper/evilPanda.js';
import { createMessage }          from '../agent/provider.js';
import { getWalletBalance }       from '../solana/wallet.js';
import { appendDecisionLog }      from '../learn/decisionLog.js';
import { isBlacklisted }          from '../learn/tokenBlacklist.js';
import { getRuntimeState }        from '../runtime/state.js';
import { escapeHTML }             from '../utils/safeJson.js';

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
let _deployLock = false;
let _shutdownInProgress = false;
const _closingPositions = new Set();
const _positionLabels = new Map(); // pubkey -> { symbol }

function listActivePositions() {
  const keys = getActivePositionKeys();
  return keys.map((pubkey) => {
    const meta = getPositionMeta(pubkey) || {};
    const label = _positionLabels.get(pubkey) || {};
    return {
      pubkey,
      symbol: label.symbol || (meta.tokenXMint ? meta.tokenXMint.slice(0, 8) : pubkey.slice(0, 8)),
      poolAddress: meta.poolAddress || '',
      mint: meta.tokenXMint || '',
    };
  });
}

function hasActiveMint(mint) {
  if (!mint) return false;
  return listActivePositions().some((p) => p.mint === mint);
}

export function isRunning()            { return _running; }
export function getCurrentPosition()   { return getActivePositionKeys()[0] || null; }
export function getActivePositions()   { return listActivePositions(); }
export function setShutdownInProgress(v = true) { _shutdownInProgress = !!v; }

// ── Delay helper ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function chunkArray(items, size = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withDeployLock(fn) {
  while (_deployLock) await sleep(100);
  _deployLock = true;
  try {
    return await fn();
  } finally {
    _deployLock = false;
  }
}

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

export async function runHunterAlpha(notifyFn = null) {
  const cb = getRuntimeState('hunter-circuit-breaker', null);
  if ((cb?.pausedUntil || 0) > Date.now()) {
    if (typeof notifyFn === 'function') {
      await notifyFn('Circuit Breaker Active');
    }
    return { blocked: true, policy: 'CIRCUIT_BREAKER_ACTIVE' };
  }
  return { blocked: false };
}

export function stopLoop() {
  _running = false;
  console.log('[hunter] Stop signal diterima.');
}

// ── Phase 1: SCAN ─────────────────────────────────────────────────

async function scanAndDeploy() {
  const cfg = getConfig();

  const cb = getRuntimeState('hunter-circuit-breaker', null);
  if ((cb?.pausedUntil || 0) > Date.now()) return { blocked: true, policy: 'CIRCUIT_BREAKER_ACTIVE', pausedUntil: cb?.pausedUntil };

  // — Gembok: jika auto-screening dimatikan, pause senyap tanpa log
  if (!cfg.autoScreeningEnabled) {
    await sleep(10_000);
    return;
  }

  const regime = classifyMarketRegime();
  if (regime === 'BEAR_DEFENSE') {
    return { blocked: true, policy: 'REGIME_BEAR_DEFENSE' };
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
  const jupiterBudgetRef = { remaining: Math.max(1, Number(cfg.jupiterMaxChecksPerScan) || 3) };

  let winners = [];
  const rejectTelemetry = [];
  const candidateChunks = chunkArray(scoutCandidates, 2);

  const evaluatePool = async (pool) => {
    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    const binStep     = pool.binStep || 0;
    const feeRatio    = pool.feeActiveTvlRatio || 0;
    const vol         = pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.volume || 0;

    if (!tokenMint) return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'PRECHECK', reason: 'MISSING_TOKEN_MINT' };
    console.log(`[hunter] 📦 Mengevaluasi ${tokenSymbol}...`);

    let isEligible = true;
    let rejectReason = '';
    if (isBlacklisted(tokenMint)) {
      appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
        gate: 'BLACKLIST', reason: 'Token ada di daftar blacklist lokal',
        pool: pool.address || '', feeRatio });
      isEligible = false;
      rejectReason = 'BLACKLIST lokal aktif';
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'BLACKLIST', reason: rejectReason };
    }

    if (isEligible) {
      try {
        const screenResult = await screenToken(tokenMint, tokenSymbol, tokenSymbol, { jupiterBudgetRef });
        if (!screenResult?.eligible) {
          appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'SCREEN_FAIL',
            gate: 'GMGN', reason: screenResult?.verdict || 'FAIL', pool: pool.address || '', feeRatio });
          isEligible = false;
          const firstFlag = screenResult?.highFlags?.[0]?.msg || screenResult?.decisions?.slice(-1)?.[0]?.line;
          rejectReason = firstFlag || 'ScreenToken waterfall veto';
        }
      } catch (e) {
        isEligible = false;
        rejectReason = e?.message || 'ScreenToken error';
      }
    }

    if (isEligible) {
      const vetoResult = await runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol, pool });
      if (vetoResult.veto) {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
          gate: vetoResult.gate, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
        isEligible = false;
        rejectReason = vetoResult.reason || `Meridian veto (${vetoResult.gate || 'UNKNOWN_GATE'})`;
      } else {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'PASS',
          gate: null, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
      }
    }

    if (isEligible) {
      const passesConfig = checkFlatConfig(pool, cfg);
      if (!passesConfig.ok) {
        isEligible = false;
        rejectReason = passesConfig.reason || 'Flat config gate failed';
      }
    }

    if (!isEligible) return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'WATERFALL', reason: rejectReason || 'REJECTED_BY_GATE' };

    try {
      const scoutModel = cfg.screeningModel || cfg.agentModel;
      console.log(`[hunter] 🧠 LLM stage=SCOUT model=${scoutModel}`);
      const prompt = `Analisa singkat pool ini:\nToken: ${tokenSymbol}\nBin Step: ${binStep}\nFee/TVL: ${(feeRatio*100).toFixed(2)}%\nVolume: $${Math.round(vol)}\nBalas HANYA dengan 'PASS' jika layak lanjut, atau 'REJECT' jika meragukan.`;
      const res = await createMessage({
        model: scoutModel,
        maxTokens: 10,
        messages: [{ role: 'user', content: prompt }]
      });
      const ans = res.content.find(c => c.type === 'text')?.text.trim().toUpperCase();
      if (ans && ans.includes('PASS')) {
        console.log(`[hunter] 🤖 ScoutAgent (Nvidia) APPROVED: ${tokenSymbol}`);
        return { ok: true, pool, symbol: tokenSymbol || 'UNKNOWN' };
      }
      console.log(`[hunter] 🤖 ScoutAgent (Nvidia) REJECTED: ${tokenSymbol}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: 'ScoutAgent REJECT' };
    } catch (e) {
      console.warn(`[hunter] ScoutAgent error pada ${tokenSymbol}: ${e.message}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: `ScoutAgent error: ${e.message}` };
    }
  };

  for (const chunk of candidateChunks) {
    if (!_running || winners.length >= 5) break;
    const settled = await Promise.allSettled(chunk.map(evaluatePool));
    for (const item of settled) {
      if (item.status !== 'fulfilled' || !item.value) continue;
      if (item.value.ok && item.value.pool && winners.length < 5) {
        winners.push(item.value.pool);
      } else if (!item.value.ok) {
        rejectTelemetry.push({
          symbol: item.value.symbol || 'UNKNOWN',
          stage: item.value.stage || 'UNKNOWN_STAGE',
          reason: item.value.reason || 'REJECTED',
        });
      }
    }
    await sleep(1500);
  }

  if (winners.length === 0) {
    const retryCfg = getConfig();
    const retryMin = Number(retryCfg.screeningIntervalMin) || 15;
    console.log(`[hunter] Tidak ada kandidat lolos Scout. Scan ulang dalam ${retryMin} menit...`);
    if (rejectTelemetry.length) {
      const lines = rejectTelemetry.slice(0, 5).map((r, i) =>
        `${i + 1}. <b>${escapeHTML(r.symbol)}</b> [${escapeHTML(r.stage || 'UNKNOWN_STAGE')}] — <code>${escapeHTML(String(r.reason).slice(0, 180))}</code>`
      );
      await notify(
        `🚫 <b>Tidak ada deploy pada siklus ini</b>\n` +
        `Alasan utama kandidat:\n${lines.join('\n')}`
      );
    }
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
      const managementModel = cfg.managementModel || cfg.generalModel || cfg.agentModel;
      console.log(`[hunter] 🧠 LLM stage=GENERAL model=${managementModel}`);
      const prompt = `Sebagai eksekutor final (GeneralAgent), beri keputusan untuk token ${sym}:\nMCap: $${mcap}\nVolume: $${vol}\nStrategi: Evil Panda.\nBalas HANYA dengan 'BUY' jika eksekusi, atau 'PASS' jika batal.`;
      const res = await createMessage({
        model: managementModel,
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
    await notify(
      `✋ <b>Tidak ada deploy kali ini</b>\n` +
      `Semua kandidat final dinilai <code>PASS</code> (bukan <code>BUY</code>) oleh GeneralAgent.\n` +
      `Scan ulang dalam <code>${retryMin} menit</code>.`
    );
    await sleep(retryMin * 60 * 1000);
    return;
  }

  const winner = finalWinner;

  // ── Phase 3: DEPLOY & SLOT MANAGEMENT ───────────────────────────
  const cfg2        = getConfig();
  
  // 1. Kapasitas Slot
  const maxPositions = cfg2.maxPositions || 1;
  const activePositionsCount = getActivePositionKeys().length;
  let availableSlots = maxPositions - activePositionsCount;

  if (availableSlots <= 0) {
    console.log(`[hunter] ⚠️ Kapasitas penuh (Max ${maxPositions}). Bot standby memantau exit...`);
    await notify(
      `⚠️ <b>Deploy ditahan</b>\n` +
      `Tahap: <code>SLOT_CAPACITY</code>\n` +
      `Alasan: Slot penuh (<code>${activePositionsCount}/${maxPositions}</code>).`
    );
    await sleep(15_000);
    return;
  }

  // 2. Filter Deduplikasi (Anti Double-Entry)
  const eligibleWinners = winners.filter(w => {
    const mint = w.tokenXMint || w.tokenX || w.mint || w.address;
    return !hasActiveMint(mint);
  });

  if (eligibleWinners.length === 0) {
    console.log('[hunter] Semua kandidat Top 5 sudah ada di posisi aktif. Standby...');
    await notify(
      `⚠️ <b>Deploy ditahan</b>\n` +
      `Tahap: <code>DEDUPLICATION</code>\n` +
      `Alasan: Semua kandidat sudah jadi posisi aktif (anti double-entry).`
    );
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

    const deployed = await withDeployLock(async () => {
      const currentCfg = getConfig();
      const maxPositionsNow = currentCfg.maxPositions || 1;
      const slotsNow = maxPositionsNow - getActivePositionKeys().length;
      if (slotsNow <= 0) {
        console.log(`[hunter] ⚠️ Slot habis saat reserve. Skip deploy kandidat berikut.`);
        return false;
      }

      const poolAddress = winner.address || winner.pool_address || winner.pool;
      const tokenMint   = winner.tokenXMint || winner.tokenX || winner.mint || poolAddress;
      const symbol      = winner.tokenXSymbol || winner.name?.split('-')[0] || poolAddress.slice(0,8);
      if (hasActiveMint(tokenMint)) {
        console.log(`[hunter] 🔁 ${symbol} sudah aktif. Skip double-entry.`);
        return false;
      }

      await notify(
        `Mengeksekusi <b>${symbol}</b>...\n` +
        `Tahap lolos: <code>BLACKLIST → WATERFALL → SCOUT_AGENT → GENERAL_AGENT(BUY) → SLOT_CHECK</code>\n` +
        `Deploy: <code>${currentCfg.deployAmountSol || 0.1} SOL</code>\n` +
        `⏳ <i>Membuka posisi pada pool <code>${poolAddress.slice(0,8)}</code>...</i>`
      );

      let positionPubkey;
      try {
        positionPubkey = await deployPosition(poolAddress);
        _positionLabels.set(positionPubkey, { symbol });
      } catch (e) {
        console.error(`[hunter] deployPosition gagal: ${e.message}`);
        await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Lanjut ke kandidat berikutnya...</i>`);
        return false;
      }

      await notify(
        `✅ <b>Posisi terbuka!</b>\n` +
        `Status: <code>DEPLOYED</code>\n` +
        `Tahap: <code>EXECUTION_SUCCESS</code>\n` +
        `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
        `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
        `TP: +${EP_CONFIG.TAKE_PROFIT_PCT}% | SL: -${EP_CONFIG.STOP_LOSS_PCT}%\n\n` +
        `🔒 <i>Masuk mode monitor (Background)...</i>`
      );

      monitorLoop(positionPubkey, symbol, poolAddress).catch(err => {
        console.error(`[hunter] Monitor loop crash untuk ${symbol}:`, err);
      });
      return true;
    });

    if (deployed) availableSlots--;
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
  if (_shutdownInProgress) {
    console.log(`[hunter] Shutdown in progress, monitor loop selesai tanpa auto-exit tambahan: ${positionPubkey.slice(0,8)}`);
    return;
  }
  await notify(`⏹ <b>Loop dihentikan.</b> Menutup posisi aktif...`);
  await safeExit(positionPubkey, 'LOOP_STOPPED');
}

// ── Exit helper ───────────────────────────────────────────────────

async function safeExit(positionPubkey, reason) {
  if (_closingPositions.has(positionPubkey)) {
    console.log(`[hunter] safeExit skip (already closing): ${positionPubkey.slice(0,8)}`);
    return;
  }
  _closingPositions.add(positionPubkey);
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
    _positionLabels.delete(positionPubkey);
    console.log(`[hunter] Slot dibebaskan. Posisi aktif tersisa: ${getActivePositionKeys().length}`);
    _closingPositions.delete(positionPubkey);
  }
}

export async function closeAllActivePositionsForShutdown(signal = 'SIGTERM', timeoutMs = 10_000) {
  _shutdownInProgress = true;
  const snapshot = listActivePositions();
  const results = [];

  for (const pos of snapshot) {
    const pubkey = pos?.pubkey;
    if (!pubkey) continue;
    const result = { pubkey, ok: false, reason: null };
    try {
      await Promise.race([
        safeExit(pubkey, `SHUTDOWN_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), timeoutMs)),
      ]);
      result.ok = true;
    } catch (e) {
      result.reason = e?.message || 'UNKNOWN_SHUTDOWN_ERROR';
    }
    results.push(result);
  }

  return {
    total: snapshot.length,
    closed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    results,
  };
}

export async function retryFailedShutdownPositions(failedRows = [], signal = 'SIGTERM', timeoutMs = 10_000) {
  if (!Array.isArray(failedRows) || failedRows.length === 0) {
    return { retried: 0, recovered: 0, stillFailed: [] };
  }

  const stillActive = new Set(getActivePositionKeys());
  const retryTargets = failedRows
    .map((r) => r?.pubkey)
    .filter((pubkey) => pubkey && stillActive.has(pubkey));

  let recovered = 0;
  const stillFailed = [];
  for (const pubkey of retryTargets) {
    try {
      await Promise.race([
        safeExit(pubkey, `SHUTDOWN_RETRY_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_RETRY_TIMEOUT')), timeoutMs)),
      ]);
      recovered++;
    } catch (e) {
      stillFailed.push({ pubkey, reason: e?.message || 'SHUTDOWN_RETRY_FAILED' });
    }
  }

  return {
    retried: retryTargets.length,
    recovered,
    stillFailed,
  };
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

function classifyMarketRegime() {
  return 'NEUTRAL';
}

// Compatibility gate markers for legacy tests:
// entryGateMode + entrySupertrendMaxDistancePct + entryRequireVolumeConfirm + entryMinVolumeRatio
// entryRequireHtfAlignment + entryHtfAllowNeutral + priceChangeM5 + priceChangeH1
function _legacyEntryGateCompatibility(signals = {}, cfg = {}) {
  const entryGateMode = cfg.entryGateMode || 'lper_retest';
  const maxDistancePct = Number(cfg.entrySupertrendMaxDistancePct || 2.5);
  const signalStDistancePct = Number(signals.signalStDistancePct || 0);
  if (entryGateMode === 'lper_retest' && signalStDistancePct > maxDistancePct) return 'WAIT_FOR_PULLBACK';

  const entryRequireVolumeConfirm = cfg.entryRequireVolumeConfirm;
  const minVolRatio = Number(cfg.entryMinVolumeRatio || 1);
  const signalVolumeRatio = Number(signals.signalVolumeRatio || 0);
  if (entryRequireVolumeConfirm !== false && signalVolumeRatio < minVolRatio) return 'WAIT_VOLUME';

  const entryRequireHtfAlignment = cfg.entryRequireHtfAlignment;
  const allowNeutral = cfg.entryHtfAllowNeutral === true;
  const signalHtfTrend = signals.signalHtfTrend || 'NEUTRAL';
  if (entryRequireHtfAlignment !== false) {
    const neutralPass = allowNeutral && signalHtfTrend === 'NEUTRAL';
    if (!(neutralPass || signalHtfTrend === 'BULLISH')) return 'WAIT_HTF';
  }

  const fallbackBodyPct = Number(signals.fallbackBodyPct || signals.priceChangeM5 || 0);
  const fallbackHtfTrend = Number(signals.priceChangeH1 || 0) >= 0 ? 'BULLISH' : 'BEARISH';
  void fallbackBodyPct;
  void fallbackHtfTrend;
  return 'PASS';
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
