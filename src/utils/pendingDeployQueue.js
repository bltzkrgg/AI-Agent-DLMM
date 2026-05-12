'use strict';

import { getConfig } from '../config.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { reserveDeploySlot, releaseDeploySlot } from './deploySlotGuard.js';

/**
 * src/utils/pendingDeployQueue.js
 * Real-time Deploy Queue — token yang lolos Scout Agent masuk sini,
 * watcher memeriksa setiap 30-60 detik, jika kondisi pasar terpenuhi
 * maka eksekusi deployPosition() langsung tanpa menunggu siklus 15 menit.
 */

let _notifyFn  = null;
let _deployFn  = null;
let _monitorFn = null;
let _watcherTimer = null;
const _queue   = new Map(); // mint -> entry

export function setDeployQueueNotifyFn(fn) { _notifyFn  = fn; }
export function setDeployQueueDeployFn(fn) { _deployFn  = fn; }
export function setDeployQueueMonitorFn(fn) { _monitorFn = fn; }

async function safeSend(msg) {
  if (_notifyFn) {
    try { await _notifyFn(msg); } catch (e) { console.error('[QUEUE] notify error:', e.message); }
  }
}

export function isFreshDeployMeta(meta = {}) {
  const cfg = getConfig();
  const lpMode = String(meta.entryGateMode || cfg.entryGateMode || '').toLowerCase().includes('lp');
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  const signalAthDistancePct = Number(meta.signalAthDistancePct);
  const signalStDistancePct = Number(meta.signalStDistancePct);

  if (meta.isRetest || meta.isScoutDefer) return false;
  if (lpMode) {
    if (timingState !== 'LP_LIVE' && timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') return false;
  } else if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') {
    return false;
  }
  if (readiness !== 'HIGH') return false;
  if (breakoutQuality !== 'VALID' && breakoutQuality !== 'STRONG') return false;
  if (!lpMode) {
    const freshAthBreakPct = Number(cfg.entryFreshBreakoutMinAthDistancePct ?? 99.25);
    const breakoutMinStPct = Number(cfg.entrySupertrendBreakMinPct ?? 1.25);
    if (Number.isFinite(signalAthDistancePct) && signalAthDistancePct < freshAthBreakPct) return false;
    if (Number.isFinite(signalStDistancePct) && signalStDistancePct < breakoutMinStPct) return false;
  } else if (Number.isFinite(signalStDistancePct) && signalStDistancePct <= 0) {
    return false;
  }
  return true;
}

/**
 * Tambahkan token ke queue setelah lolos Scout Agent.
 * @param {Object} pool     - raw pool object dari pipeline
 * @param {string} symbol   - nama token
 * @param {Object} meta     - { scoutReason, entryReadiness, breakoutQuality }
 */
export function enqueueForDeploy(pool, symbol, meta = {}) {
  const mint = pool.tokenXMint || pool.mint || '';
  if (!mint || _queue.has(mint)) return;

  if (!isFreshDeployMeta(meta)) {
    console.log(
      `[QUEUE] ⏸️ ${symbol} tidak masuk queue deploy (DEFER / LP flow belum siap: ` +
      `Entry=${meta.entryReadiness || 'N/A'}, Breakout=${meta.breakoutQuality || 'N/A'}, Timing=${meta.entryTimingState || 'N/A'})`
    );
    return;
  }

  _queue.set(mint, {
    pool,
    symbol,
    mint,
    meta,
    enqueuedAt: Date.now(),
    attempts: 0,
  });

  console.log(`[QUEUE] ✅ ${symbol} masuk antrian deploy real-time (Entry=${meta.entryReadiness}, Breakout=${meta.breakoutQuality})`);

  // Auto-start watcher jika belum jalan — token langsung dipantau setiap 30 detik
  if (!_watcherTimer) {
    console.log('[QUEUE] 👀 Auto-start watcher karena ada token baru masuk antrian');
    _watcherTimer = setTimeout(runWatcher, 30_000);
  }
}

/** Hapus token dari queue */
export function dequeueToken(mint) {
  _queue.delete(mint);
}

/**
 * Cek kondisi pasar sebelum deploy.
 */
async function evaluateDeployConditions(entry) {
  const { pool, meta } = entry;
  const cfg = getConfig();
  const lpMode = String(meta.entryGateMode || cfg.entryGateMode || '').toLowerCase().includes('lp');

  // Kondisi 1: Waktu expired di antrian
  // Token watch deploy: expiry mengikuti config deployQueueExpiryMin
  const ageMs  = Date.now() - entry.enqueuedAt;
  const maxAgeMinutes = Math.max(
    lpMode ? 10 : 5,
    Math.max(1, Number(cfg.deployQueueExpiryMin) || (lpMode ? 10 : 5))
  );
  const maxAge = Math.max(60_000, Math.round(maxAgeMinutes * 60 * 1000));
  if (ageMs > maxAge) {
    return { ok: false, reason: `Token expired dari antrian (> ${Math.round(maxAge / 60000)} menit)` };
  }

  const watchWindowSec = lpMode
    ? Math.max(180, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 180))
    : Math.max(5, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 90));
  const maxDriftPct = lpMode
    ? Math.max(8, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 8))
    : Math.max(0.1, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 2.5));
  const snapshotAt = Number(meta.snapshotAt || entry.enqueuedAt || 0);
  if (snapshotAt > 0 && (Date.now() - snapshotAt) > watchWindowSec * 1000) {
    return { ok: false, reason: `WATCH terlalu lama (${Math.round((Date.now() - snapshotAt) / 1000)}s > ${watchWindowSec}s)` };
  }

  const mint = pool.tokenXMint || pool.mint || '';
  const poolAddress = pool.address || pool.pool_address || pool.pool || pool.poolAddress || pool.pubkey || '';
  const liveSnapshot = mint
    ? await getMarketSnapshot(mint, poolAddress || null).catch(() => null)
    : null;
  const livePrice = Number(liveSnapshot?.ohlcv?.currentPrice || liveSnapshot?.price?.currentPrice || pool?.price || 0);
  const snapshotPrice = Number(meta.snapshotPrice || 0);
  if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && Number.isFinite(livePrice) && livePrice > 0) {
    const driftPct = Math.abs(((livePrice - snapshotPrice) / snapshotPrice) * 100);
    if (driftPct > maxDriftPct) {
      return { ok: false, reason: `Breakout bergeser ${driftPct.toFixed(2)}% dari snapshot (> ${maxDriftPct}%)` };
    }
  }

  if (liveSnapshot) {
    const liveTrend = String(
      liveSnapshot?.quality?.taTrend ||
      liveSnapshot?.ta?.supertrend?.trend ||
      'UNKNOWN'
    ).toUpperCase();
    const liveM5 = Number(liveSnapshot?.ohlcv?.priceChangeM5 ?? 0);
    if (liveTrend !== 'BULLISH' || liveM5 <= 0) {
      return { ok: false, reason: `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} m5=${liveM5.toFixed(2)}%` };
    }
  }

  // Kondisi 3: TVL minimal (hindari rug liquidity)
  const tvl = Number(pool.totalTvl || pool.activeTvl || 0);
  if (tvl < 5000) {
    return { ok: false, reason: `TVL terlalu rendah: $${tvl.toLocaleString()}` };
  }

  return { ok: true };
}

/** Main watcher loop */
async function runWatcher() {
  // Snapshot entries SEBELUM iterasi agar modifikasi map di dalam loop aman
  const entries = Array.from(_queue.entries());

  for (const [mint, entry] of entries) {
    // Outer try-catch: satu token gagal tidak boleh crash loop keseluruhan
    try {
      // Re-check: mungkin sudah dihapus oleh caller lain
      if (!_queue.has(mint)) continue;

      const { symbol, pool, meta } = entry;
      const isRetest = meta?.isRetest || meta?.isScoutDefer;
      const queueType = isRetest ? 'RETEST' : 'DEPLOY';

      // Log real-time monitoring per token
      console.log(`[QUEUE] ⏳ Memantau TA untuk token ${symbol} secara real-time... [${queueType}] (attempt ${entry.attempts + 1})`);

      if (entry.attempts >= 3) {
        console.log(`[QUEUE] 🗑️ ${symbol} dihapus dari antrian (max attempts)`);
        _queue.delete(mint);
        await safeSend(
          `⏱️ <b>Deploy Queue Expired</b>\n` +
          `<b>${symbol}</b> dihapus setelah 3x gagal evaluate.`
        );
        continue;
      }

      const check = await evaluateDeployConditions(entry);

      if (!check.ok) {
        console.log(`[QUEUE] ⏳ ${symbol} belum siap: ${check.reason} (attempt ${entry.attempts}/3)`);
        if (check.reason.includes('expired')) {
          _queue.delete(mint);
          await safeSend(
            `⏱️ <b>Deploy Queue Expired</b>\n` +
            `<b>${symbol}</b> — dibatalkan.\n` +
            `<i>${check.reason}</i>`
          );
        }
        continue;
      }

      // Resolusi pool address — cek semua field yang mungkin dipakai Meteora API
      const poolAddress = pool.address || pool.pool_address || pool.pool || pool.poolAddress || pool.pubkey || '';
      if (!poolAddress) {
        console.warn(`[QUEUE] ⚠️ Pool address tidak ditemukan untuk ${symbol} — fields: ${JSON.stringify(Object.keys(pool))}`);
        _queue.delete(mint);
        await safeSend(
          `⚠️ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${symbol}</b> — Pool address tidak valid.\n` +
          `<i>Tidak ada field address yang tersedia di objek pool.</i>`
        );
        continue;
      }

      // Validate poolAddress adalah Solana pubkey (base58, 32–44 chars)
      if (typeof poolAddress !== 'string' || poolAddress.length < 32 || poolAddress.length > 44) {
        console.error(`[QUEUE] ❌ Pool address tidak valid untuk ${symbol}: "${poolAddress}"`);
        _queue.delete(mint);
        await safeSend(
          `❌ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${symbol}</b> — Pool address bukan Solana pubkey yang valid.`
        );
        continue;
      }

      const cfg = getConfig();
      const solAmount = cfg.deployAmountSol || 0.1;
      console.log(`[QUEUE] 🚀 Attempting deploy for ${symbol} with amount ${solAmount} SOL (Pool: ${poolAddress.slice(0, 8)})`);
      const slotReservation = reserveDeploySlot({
        owner: 'deployQueueWatcher',
        mint,
        symbol,
        poolAddress,
        source: isRetest ? 'retestQueue' : 'deployQueue',
        ttlMs: Number(cfg.deployTimeoutMs || 180_000) + 60_000,
      });

      if (!slotReservation.ok) {
        console.log(`[QUEUE] ⏳ Slot penuh, ${symbol} tetap di queue (${slotReservation.reason})`);
        continue;
      }
      entry.attempts++;
      const reservationId = slotReservation.id;
      _queue.delete(mint); // Hapus sebelum deploy (idempoten)

      try {
        await safeSend(
          `🚀 <b>Real-time Deploy Triggered!</b>\n` +
          `Token: <b>${symbol}</b>\n` +
          `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
          `BinStep: <code>${pool.binStep || '?'}</code>\n` +
          `Entry: <code>${entry.meta.entryReadiness || 'N/A'}</code> | ` +
          `Breakout: <code>${entry.meta.breakoutQuality || 'N/A'}</code> | ` +
          `Timing: <code>${entry.meta.entryTimingState || 'N/A'}</code>\n` +
          `⏳ <i>Membuka posisi ${solAmount} SOL...</i>`
        );

        if (!_deployFn) {
          throw new Error('deployFn belum di-set ke DeployQueue — panggil setDeployQueueDeployFn() dulu.');
        }

        const result = await _deployFn(poolAddress);

        if (result && typeof result === 'object' && result.dryRun) {
          await safeSend(
            `🧪 <b>Dry-run (Queue Deploy)</b>\n` +
            `<b>${symbol}</b> — Simulasi selesai, tidak ada tx real.\n` +
            `Range: <code>${result.rangeMin}–${result.rangeMax}</code>`
          );
          continue;
        }

        const positionPubkey = typeof result === 'string' ? result : null;
        await safeSend(
          `✅ <b>Deploy Berhasil! (Queue)</b>\n` +
          `<b>${symbol}</b> — <code>DEPLOYED</code>\n` +
          (positionPubkey ? `Position: <code>${positionPubkey.slice(0, 8)}</code>\n` : '') +
          `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
          `🔒 <i>Masuk mode monitor...</i>`
        );

        if (positionPubkey && _monitorFn) {
          _monitorFn(positionPubkey, symbol, poolAddress).catch(e => {
            console.error(`[QUEUE] Monitor loop crash untuk ${symbol}: ${e.message}`);
          });
        }
      } finally {
        await releaseDeploySlot(reservationId).catch(() => {});
      }

    } catch (tokenErr) {
      // Token-level error: log dan lanjut ke token berikutnya, jangan crash loop
      const sym = entry?.symbol || mint?.slice(0, 8) || 'UNKNOWN';
      console.error(`[QUEUE] ⛔ Error saat proses ${sym}: ${tokenErr.message}`);
      _queue.delete(mint); // Buang dari queue agar tidak retry tanpa batas
      await safeSend(
        `❌ <b>Deploy Gagal (Queue)</b>\n` +
        `<b>${sym}</b>\n` +
        `Error: <code>${tokenErr.message.slice(0, 200)}</code>\n` +
        `<i>Token dikeluarkan dari queue.</i>`
      );
    }
  }

  // Jadwalkan ulang watcher (15 detik — real-time monitoring)
  _watcherTimer = setTimeout(runWatcher, 15_000);
}

/** Mulai watcher. Panggil sekali saat startup. */
export function startDeployQueueWatcher() {
  if (_watcherTimer) return;
  console.log('[QUEUE] 👀 Watcher dimulai (interval: 15s real-time monitoring)');
  _watcherTimer = setTimeout(runWatcher, 15_000);
}

/** Hentikan watcher. */
export function stopDeployQueueWatcher() {
  if (_watcherTimer) {
    clearTimeout(_watcherTimer);
    _watcherTimer = null;
  }
  _queue.clear();
  console.log('[QUEUE] 🛑 Watcher dihentikan');
}

export function getQueueSize()    { return _queue.size; }
export function getQueueEntries() { return Array.from(_queue.values()); }
