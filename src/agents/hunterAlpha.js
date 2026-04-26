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
import { getWalletBalance }       from '../solana/wallet.js';

// ── Notify helper (diset dari index.js) ──────────────────────────
let _notifyFn = null;
export function setNotifyFn(fn) { _notifyFn = fn; }
async function notify(msg) {
  try { await _notifyFn?.(msg); } catch { /* non-fatal */ }
}

// ── State ─────────────────────────────────────────────────────────
let _running   = false;
let _currentPositionPubkey = null;

export function isRunning()            { return _running; }
export function getCurrentPosition()   { return _currentPositionPubkey; }

// ── Delay helper ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main Linear Loop ─────────────────────────────────────────────

/**
 * Jalankan loop Linear Sniper.
 * Dipanggil sekali dari index.js — berjalan terus sampai di-stop.
 */
export async function runLinearLoop() {
  if (_running) {
    console.warn('[hunter] Loop sudah berjalan, skip.');
    return;
  }
  _running = true;
  console.log('[hunter] ▶ Linear Sniper Loop dimulai');
  await notify('🚀 <b>Linear Sniper aktif.</b> Memulai scan pool...');

  while (_running) {
    try {
      await scanAndDeploy();
    } catch (e) {
      console.error(`[hunter] Loop error: ${e.message}`);
      await notify(`⚠️ <b>Loop error:</b>\n<code>${e.message}</code>\n\n<i>Retry dalam 30 detik...</i>`);
      await sleep(30_000);
    }
  }

  console.log('[hunter] ⏹ Loop dihentikan.');
}

export function stopLoop() {
  _running = false;
  console.log('[hunter] Stop signal diterima.');
}

// ── Phase 1: SCAN ─────────────────────────────────────────────────

async function scanAndDeploy() {
  const cfg    = getConfig();
  const limit  = cfg.meteoraDiscoveryLimit || 50;

  console.log(`[hunter] 🔍 SCAN — High-Fee Hunter (binStep priority: ${(cfg.binStepPriority || [200,125,100]).join('>')} )...`);
  await notify('🔍 <b>Scan dimulai.</b> Mencari pool dengan fee tertinggi...');

  let pools;
  try {
    // TAHAP 2: Gunakan Meridian High-Fee Hunter discovery
    // Sort by fee_active_tvl_ratio DESC, prioritas binStep [200, 125, 100]
    pools = await discoverHighFeePoolsMeridian({ limit });
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

  // ── Phase 2: FILTER — sequential, 5 detik antar koin ────────────
  let winner = null;

  for (const pool of pools) {
    if (!_running) return;

    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    const binStep     = pool.binStep || 0;
    const feeRatio    = pool.feeActiveTvlRatio || 0;

    if (!tokenMint) {
      await sleep(5_000);
      continue;
    }

    console.log(`[hunter] 🔬 Screen: ${tokenSymbol} | binStep=${binStep} | fee/tvl=${(feeRatio*100).toFixed(3)}%`);

    // ── GMGN / Coinfilter screening ───────────────────────────────
    let screenResult;
    try {
      screenResult = await screenToken(tokenMint, tokenSymbol, tokenSymbol);
    } catch (e) {
      console.warn(`[hunter] screenToken error ${tokenMint.slice(0,8)}: ${e.message}`);
      await sleep(5_000);
      continue;
    }

    if (!screenResult?.eligible) {
      console.log(`[hunter] ❌ ${tokenSymbol}: ${screenResult?.verdict || 'FAIL'} (GMGN gate)`);
      await sleep(5_000);  // Anti-429: jeda 5 detik antar koin
      continue;
    }

    // ── Meridian VETO (Supertrend 15m + ATH + PVP) ───────────────
    const vetoResult = await runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol });
    if (vetoResult.veto) {
      console.log(`[hunter] 🚫 ${tokenSymbol}: VETO [${vetoResult.gate}] — ${vetoResult.reason}`);
      await sleep(5_000);
      continue;
    }
    console.log(`[hunter] ✅ Meridian: ${vetoResult.reason}`);

    // ── Pure Flat Config gate ─────────────────────────────────────
    const passesConfig = checkFlatConfig(pool, cfg);
    if (!passesConfig.ok) {
      console.log(`[hunter] ❌ ${tokenSymbol}: config gate — ${passesConfig.reason}`);
      await sleep(5_000);
      continue;
    }

    console.log(`[hunter] ✅ ${tokenSymbol} LOLOS semua gate! (binStep=${binStep} fee/tvl=${(feeRatio*100).toFixed(3)}%)`);
    winner = pool;
    break;
  }

  if (!winner) {
    console.log('[hunter] Tidak ada kandidat lolos. Tunggu 2 menit...');
    await notify('🔍 <i>Tidak ada kandidat lolos screening. Scan ulang dalam 2 menit.</i>');
    await sleep(120_000);
    return;
  }

  // ── Phase 3: DEPLOY ───────────────────────────────────────────────
  const cfg2        = getConfig();
  const poolAddress = winner.address || winner.pool_address || winner.pool;
  const symbol      = winner.tokenXSymbol || winner.name?.split('-')[0] || poolAddress.slice(0,8);
  const binStep     = winner.binStep || '?';
  const feeRatio    = winner.feeActiveTvlRatio || 0;

  await notify(
    `🎯 <b>Target ditemukan!</b>\n` +
    `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
    `Token: <b>${symbol}</b> | BinStep: <code>${binStep}</code>\n` +
    `Fee/TVL: <code>${(feeRatio*100).toFixed(3)}%</code>\n` +
    `Deploy: <code>${cfg2.deployAmountSol || 0.1} SOL</code>\n\n` +
    `⏳ <i>Membuka posisi...</i>`
  );

  let positionPubkey;
  try {
    positionPubkey = await deployPosition(poolAddress);
    _currentPositionPubkey = positionPubkey;
  } catch (e) {
    console.error(`[hunter] deployPosition gagal: ${e.message}`);
    await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Kembali ke scan...</i>`);
    await sleep(10_000);
    return;
  }

  await notify(
    `✅ <b>Posisi terbuka!</b>\n` +
    `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
    `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
    `TP: +${EP_CONFIG.TAKE_PROFIT_PCT}% | SL: -${EP_CONFIG.STOP_LOSS_PCT}%\n\n` +
    `🔒 <i>Masuk mode monitor...</i>`
  );

  // ── Phase 4: MONITOR (LOCK — pencarian pool BERHENTI) ────────────
  await monitorLoop(positionPubkey, symbol, poolAddress);

  // ── Phase 5: RELOAD — setelah exit, kembali ke scan ──────────────
  _currentPositionPubkey = null;
  console.log('[hunter] 🔄 Reload — kembali ke scan...');
  await notify('🔄 <b>Posisi ditutup.</b> Memulai ulang scan pool...');
  await sleep(5_000);
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
        `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n\n` +
        `⏳ <i>Menutup posisi...</i>`
      );
      await safeExit(positionPubkey, 'TAKE_PROFIT');
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
  }
}

// ── Pure Flat Config Gate ─────────────────────────────────────────

function checkFlatConfig(pool, cfg) {
  const vol24h   = safeNum(pool.volume24h || pool.volume24hRaw || 0);
  const minVol   = cfg.minVolume24h || 0;
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
  if (minFee > 0 && feeRatio < minFee) {
    return { ok: false, reason: `fee/tvl ${(feeRatio*100).toFixed(4)}% < min ${(minFee*100).toFixed(4)}%` };
  }
  return { ok: true };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
