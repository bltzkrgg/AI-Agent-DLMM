'use strict';

import { getConfig } from '../config.js';

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
    try { await _notifyFn(msg); } catch (e) { console.error('[DeployQueue] notify error:', e.message); }
  }
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

  _queue.set(mint, {
    pool,
    symbol,
    mint,
    meta,
    enqueuedAt: Date.now(),
    attempts: 0,
  });

  console.log(`[DeployQueue] ✅ ${symbol} masuk antrian deploy real-time (Entry=${meta.entryReadiness}, Breakout=${meta.breakoutQuality})`);

  // Auto-start watcher jika belum jalan — token langsung dipantau setiap 30 detik
  if (!_watcherTimer) {
    console.log('[DeployQueue] 👀 Auto-start watcher karena ada token baru masuk antrian');
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
function evaluateDeployConditions(entry) {
  const { pool, meta } = entry;

  // Kondisi 1: Sudah terlalu lama di antrian (> 5 menit)
  const ageMs = Date.now() - entry.enqueuedAt;
  if (ageMs > 5 * 60 * 1000) {
    return { ok: false, reason: 'Token expired dari antrian (>5 menit)' };
  }

  // Kondisi 2: Entry readiness tidak boleh LOW
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  if (readiness === 'LOW') {
    return { ok: false, reason: `Entry readiness masih LOW` };
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

      const { symbol, pool } = entry;

      if (entry.attempts >= 3) {
        console.log(`[DeployQueue] 🗑️ ${symbol} dihapus dari antrian (max attempts)`);
        _queue.delete(mint);
        await safeSend(
          `⏱️ <b>Deploy Queue Expired</b>\n` +
          `<b>${symbol}</b> dihapus setelah 3x gagal evaluate.`
        );
        continue;
      }

      entry.attempts++;
      const check = evaluateDeployConditions(entry);

      if (!check.ok) {
        console.log(`[DeployQueue] ⏳ ${symbol} belum siap: ${check.reason} (attempt ${entry.attempts}/3)`);
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
        console.warn(`[DeployQueue] ⚠️ Pool address tidak ditemukan untuk ${symbol} — fields: ${JSON.stringify(Object.keys(pool))}`);
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
        console.error(`[DeployQueue] ❌ Pool address tidak valid untuk ${symbol}: "${poolAddress}"`);
        _queue.delete(mint);
        await safeSend(
          `❌ <b>Deploy Gagal (Queue)</b>\n` +
          `<b>${symbol}</b> — Pool address bukan Solana pubkey yang valid.`
        );
        continue;
      }

      const cfg = getConfig();
      const solAmount = cfg.deployAmountSol || 0.1;
      console.log(`[DeployQueue] 🚀 Attempting deploy for ${symbol} with amount ${solAmount} SOL (Pool: ${poolAddress.slice(0, 8)})`);
      _queue.delete(mint); // Hapus sebelum deploy (idempoten)

      await safeSend(
        `🚀 <b>Real-time Deploy Triggered!</b>\n` +
        `Token: <b>${symbol}</b>\n` +
        `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
        `BinStep: <code>${pool.binStep || '?'}</code>\n` +
        `Entry: <code>${entry.meta.entryReadiness || 'N/A'}</code> | ` +
        `Breakout: <code>${entry.meta.breakoutQuality || 'N/A'}</code>\n` +
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
          console.error(`[DeployQueue] Monitor loop crash untuk ${symbol}:`, e.message);
        });
      }

    } catch (tokenErr) {
      // Token-level error: log dan lanjut ke token berikutnya, jangan crash loop
      const sym = entry?.symbol || mint?.slice(0, 8) || 'UNKNOWN';
      console.error(`[DeployQueue] ⛔ Error saat proses ${sym}: ${tokenErr.message}`);
      _queue.delete(mint); // Buang dari queue agar tidak retry tanpa batas
      await safeSend(
        `❌ <b>Deploy Gagal (Queue)</b>\n` +
        `<b>${sym}</b>\n` +
        `Error: <code>${tokenErr.message.slice(0, 200)}</code>\n` +
        `<i>Token dikeluarkan dari queue.</i>`
      );
    }
  }

  // Jadwalkan ulang watcher (30 detik)
  _watcherTimer = setTimeout(runWatcher, 30_000);
}

/** Mulai watcher. Panggil sekali saat startup. */
export function startDeployQueueWatcher() {
  if (_watcherTimer) return;
  console.log('[DeployQueue] 👀 Watcher dimulai (interval: 30s)');
  _watcherTimer = setTimeout(runWatcher, 30_000);
}

/** Hentikan watcher. */
export function stopDeployQueueWatcher() {
  if (_watcherTimer) {
    clearTimeout(_watcherTimer);
    _watcherTimer = null;
  }
  _queue.clear();
  console.log('[DeployQueue] 🛑 Watcher dihentikan');
}

export function getQueueSize()    { return _queue.size; }
export function getQueueEntries() { return Array.from(_queue.values()); }
