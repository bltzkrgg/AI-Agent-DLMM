'use strict';

import { getConfig } from '../config.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { getPoolMemorySignal, recordPoolDeploy } from '../market/poolMemory.js';
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
const _snapshotCache = new Map(); // key -> { at, snapshot }
const _snapshotInflight = new Map(); // key -> Promise
const SNAPSHOT_CACHE_TTL_MS = 12_000;
let _snapshotCacheHits = 0;
let _snapshotCacheMisses = 0;

function formatPct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : 'UNKNOWN';
}

function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setDeployQueueNotifyFn(fn) { _notifyFn  = fn; }
export function setDeployQueueDeployFn(fn) { _deployFn  = fn; }
export function setDeployQueueMonitorFn(fn) { _monitorFn = fn; }

async function safeSend(msg) {
  if (_notifyFn) {
    try { await _notifyFn(msg); } catch (e) { console.error('[QUEUE] notify error:', e.message); }
  }
}

function getSnapshotCacheKey(mint = '', poolAddress = '') {
  return `${mint || 'unknown'}:${poolAddress || 'nopool'}`;
}

export function isReliableLiveSnapshot(snapshot = null) {
  if (!snapshot) return false;
  const source = String(snapshot.dataSource || snapshot.ohlcv?.source || '').toLowerCase();
  if (!snapshot.ohlcv?.historySuccess) return false;
  if (source.includes('momentum-proxy')) return false;
  return true;
}

export function getSnapshotCacheStats() {
  return {
    hits: _snapshotCacheHits,
    misses: _snapshotCacheMisses,
    size: _snapshotCache.size,
  };
}

async function getCachedMarketSnapshot(mint, poolAddress = null) {
  if (!mint) return null;
  const key = getSnapshotCacheKey(mint, poolAddress || '');
  const now = Date.now();
  const cached = _snapshotCache.get(key);
  if (cached && (now - cached.at) <= SNAPSHOT_CACHE_TTL_MS) {
    _snapshotCacheHits += 1;
    console.log(`[QUEUE] 🧠 Snapshot cache hit ${mint.slice(0, 8)} hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`);
    return cached.snapshot;
  }

  if (_snapshotInflight.has(key)) {
    _snapshotCacheHits += 1;
    console.log(`[QUEUE] 🧠 Snapshot inflight reuse ${mint.slice(0, 8)} hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`);
    return _snapshotInflight.get(key);
  }

  _snapshotCacheMisses += 1;
  console.log(`[QUEUE] 🧠 Snapshot cache miss ${mint.slice(0, 8)} hits=${_snapshotCacheHits} misses=${_snapshotCacheMisses}`);
  const task = getMarketSnapshot(mint, poolAddress || null)
    .catch(() => null)
    .then((snapshot) => {
      _snapshotCache.set(key, { at: Date.now(), snapshot });
      _snapshotInflight.delete(key);
      return snapshot;
    });
  _snapshotInflight.set(key, task);
  return task;
}

function resolveQueueSignalSources({ meta = {}, liveSnapshot = null } = {}) {
  const metaTrendRaw = String(meta.taTrend || meta.liveTrend || '').toUpperCase();
  const metaM5Raw = Number(meta.priceChangeM5 ?? meta.snapshotM5Change ?? 0);
  const liveTrendRaw = String(
    liveSnapshot?.quality?.taTrend ||
    liveSnapshot?.ta?.supertrend?.trend ||
    'UNKNOWN'
  ).toUpperCase();
  const liveM5Raw = Number(liveSnapshot?.ohlcv?.priceChangeM5 ?? 0);
  const liveTrendKnown = ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(liveTrendRaw);
  const liveM5Known = Number.isFinite(liveM5Raw) && liveM5Raw !== 0;

  return {
    trend: liveTrendKnown ? liveTrendRaw : (metaTrendRaw || 'UNKNOWN'),
    trendSource: liveTrendKnown ? 'live' : (metaTrendRaw ? 'queue' : 'unknown'),
    m5: liveM5Known ? liveM5Raw : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? metaM5Raw : 0),
    m5Source: liveM5Known ? 'live' : (Number.isFinite(metaM5Raw) && metaM5Raw !== 0 ? 'queue' : 'unknown'),
    liveTrendRaw,
    liveM5Raw,
    metaTrendRaw,
    metaM5Raw,
  };
}

function isTrustedLpWatchMeta(meta = {}) {
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  return meta.queueTrustedWatch === true &&
    timingState === 'LP_LIVE' &&
    readiness === 'HIGH' &&
    (breakoutQuality === 'VALID' || breakoutQuality === 'STRONG');
}

export function summarizeQueueDecision({ meta = {}, liveSnapshot = null, cfg = getConfig(), lpMode = false } = {}) {
  const signals = resolveQueueSignalSources({ meta, liveSnapshot });
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const trustedLpWatch = isTrustedLpWatchMeta(meta);

  let decision = 'DEPLOY';
  let reason = '';

  if (lpMode) {
    if (signals.trend === 'BEARISH') {
      decision = 'DROP';
      reason = `Supertrend 15m bearish (${signals.trendSource})`;
    } else if (trustedLpWatch) {
      decision = 'DEPLOY';
      reason = `Trusted WATCH ready (${signals.trendSource}/${signals.m5Source})`;
    } else if (signals.trend !== 'BULLISH' || signals.m5 <= 0) {
      decision = 'HOLD';
      reason = `Freshness hilang: trend=${signals.trend || 'UNKNOWN'} (${signals.trendSource}) m5=${formatPct(signals.m5)} (${signals.m5Source})`;
    }
  } else if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') {
    decision = 'HOLD';
    reason = `Timing belum fresh: ${timingState || 'UNKNOWN'}`;
  }

  return {
    ...signals,
    lpMode,
    timingState,
    decision,
    reason,
    queueExpiryMin: Math.max(
      lpMode ? 1 : 5,
      Math.max(1, Number(cfg.deployQueueExpiryMin) || (lpMode ? 60 : 5))
    ),
  };
}

export function isFreshDeployMeta(meta = {}) {
  const cfg = getConfig();
  const lpMode = String(meta.entryGateMode || cfg.entryGateMode || '').toLowerCase().includes('lp');
  const timingState = String(meta.entryTimingState || '').toUpperCase();
  const readiness = String(meta.entryReadiness || '').toUpperCase();
  const breakoutQuality = String(meta.breakoutQuality || '').toUpperCase();
  const taTrend = String(meta.taTrend || meta.liveTrend || '').toUpperCase();
  const signalAthDistancePct = Number(meta.signalAthDistancePct);
  const signalStDistancePct = Number(meta.signalStDistancePct);
  const trustedLpWatch = isTrustedLpWatchMeta(meta);

  if (meta.isRetest || meta.isScoutDefer) return false;
  if (lpMode) {
    if (timingState !== 'LP_LIVE' && timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') return false;
    if (taTrend === 'BEARISH') return false;
    if (!trustedLpWatch && taTrend !== 'BULLISH') return false;
  } else if (timingState !== 'BREAKOUT' && timingState !== 'ATH_BREAK') {
    return false;
  }
  if (readiness !== 'HIGH') return false;
  if (breakoutQuality !== 'VALID' && breakoutQuality !== 'STRONG') return false;
  if (taTrend === 'BEARISH') return false;
  if (taTrend && taTrend !== 'BULLISH' && !trustedLpWatch) return false;
  if (!lpMode) {
    const freshAthBreakPct = Number(cfg.entryFreshBreakoutMinAthDistancePct ?? 99.25);
    const breakoutMinStPct = Number(cfg.entrySupertrendBreakMinPct ?? 1.25);
    if (Number.isFinite(signalAthDistancePct) && signalAthDistancePct < freshAthBreakPct) return false;
    if (Number.isFinite(signalStDistancePct) && signalStDistancePct < breakoutMinStPct) return false;
  } else if (!trustedLpWatch && Number.isFinite(signalStDistancePct) && signalStDistancePct <= 0) {
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
      `Entry=${meta.entryReadiness || 'N/A'}, Breakout=${meta.breakoutQuality || 'N/A'}, ` +
      `Timing=${meta.entryTimingState || 'N/A'}, Trend=${meta.taTrend || meta.liveTrend || 'N/A'}, ` +
      `M5=${formatPct(meta.priceChangeM5 ?? meta.snapshotM5Change)}, ` +
      `STDist=${formatPct(meta.signalStDistancePct)}, TrustedWatch=${meta.queueTrustedWatch === true ? 'YES' : 'NO'})`
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
  const mint = pool.tokenXMint || pool.mint || '';
  const poolAddress = pool.address || pool.pool_address || pool.pool || pool.poolAddress || pool.pubkey || '';
  const queueSignals = summarizeQueueDecision({ meta, liveSnapshot: null, cfg, lpMode });
  let activeSignals = queueSignals;
  let { trend: liveTrend, trendSource, m5: liveM5, m5Source, decision: freshnessDecision } = activeSignals;

  // Kondisi 1: Waktu expired di antrian
  // Token watch deploy: expiry mengikuti config deployQueueExpiryMin
  const ageMs  = Date.now() - entry.enqueuedAt;
  const maxAgeMinutes = queueSignals.queueExpiryMin;
  const maxAge = Math.max(60_000, Math.round(maxAgeMinutes * 60 * 1000));
  if (ageMs > maxAge) {
    return {
      ok: false,
      decision: 'DROP',
      reason: `Token expired dari antrian (> ${Math.round(maxAge / 60000)} menit)`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  if (lpMode) {
    const memorySignal = getPoolMemorySignal(pool);
    if (memorySignal.memory && Number(memorySignal.priorityDelta || 0) !== 0) {
      console.log(
        `[QUEUE] 🧠 Memory advisory ${mint.slice(0, 8)} ` +
        `delta=${memorySignal.priorityDelta} reason=${memorySignal.reason} lookup=${memorySignal.lookupMs || 0}ms`
      );
    }

    const tvl = Number(pool.totalTvl || pool.activeTvl || 0);
    if (tvl < 5000) {
      return {
        ok: false,
        decision: 'HOLD',
        reason: `TVL terlalu rendah: $${tvl.toLocaleString()}`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }

    if (freshnessDecision !== 'DEPLOY') {
      return {
        ok: false,
        decision: freshnessDecision,
        reason: freshnessDecision === 'DROP'
          ? queueSignals.reason
          : `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }

    const liveSnapshot = await getCachedMarketSnapshot(mint, poolAddress || null);
    if (liveSnapshot) {
      const liveSignals = summarizeQueueDecision({ meta, liveSnapshot, cfg, lpMode });
      const liveReliable = isReliableLiveSnapshot(liveSnapshot);
      if (!liveReliable) {
        console.log(
          `[QUEUE] 🧊 Ignored unreliable live snapshot for ${mint.slice(0, 8)} ` +
          `(source=${String(liveSnapshot.dataSource || liveSnapshot.ohlcv?.source || 'unknown')})`
        );
      }
      activeSignals = liveReliable ? liveSignals : queueSignals;
      ({ trend: liveTrend, trendSource, m5: liveM5, m5Source, decision: freshnessDecision } = activeSignals);

      if (liveReliable && freshnessDecision !== 'DEPLOY') {
        return {
          ok: false,
          decision: freshnessDecision,
          reason: freshnessDecision === 'DROP'
            ? liveSignals.reason
            : `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
          trendSource,
          m5Source,
          liveTrend,
          liveM5,
        };
      }
    }

    return {
      ok: true,
      decision: 'DEPLOY',
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  const watchWindowSec = lpMode
    ? Math.max(180, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 180))
    : Math.max(5, Number(meta.watchWindowSec || cfg.entryFreshWatchWindowSec || 90));
  const maxDriftPct = lpMode
    ? Math.max(8, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 8))
    : Math.max(0.1, Number(meta.maxDriftPct || cfg.entryFreshBreakoutMaxDriftPct || 2.5));
  const snapshotAt = Number(meta.snapshotAt || entry.enqueuedAt || 0);
  if (snapshotAt > 0 && (Date.now() - snapshotAt) > watchWindowSec * 1000) {
    return {
      ok: false,
      decision: 'HOLD',
      reason: `WATCH terlalu lama (${Math.round((Date.now() - snapshotAt) / 1000)}s > ${watchWindowSec}s)`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  const liveSnapshot = await getCachedMarketSnapshot(mint, poolAddress || null);
  if (liveSnapshot) {
    const liveSignals = summarizeQueueDecision({ meta, liveSnapshot, cfg, lpMode });
    if (!isReliableLiveSnapshot(liveSnapshot)) {
      console.log(
        `[QUEUE] 🧊 Ignored unreliable live snapshot for ${mint.slice(0, 8)} ` +
        `(source=${String(liveSnapshot.dataSource || liveSnapshot.ohlcv?.source || 'unknown')})`
      );
    }
    ({ trend: liveTrend, trendSource, m5: liveM5, m5Source } = liveSignals);
  }

  const livePrice = Number(liveSnapshot?.ohlcv?.currentPrice || liveSnapshot?.price?.currentPrice || pool?.price || 0);
  const snapshotPrice = Number(meta.snapshotPrice || 0);
  if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && Number.isFinite(livePrice) && livePrice > 0) {
    const driftPct = Math.abs(((livePrice - snapshotPrice) / snapshotPrice) * 100);
    if (driftPct > maxDriftPct) {
      return {
        ok: false,
        decision: 'HOLD',
        reason: `Breakout bergeser ${driftPct.toFixed(2)}% dari snapshot (> ${maxDriftPct}%)`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }
  }

  if (liveSnapshot) {
    if (liveTrend !== 'BULLISH' || liveM5 <= 0) {
      return {
        ok: false,
        decision: liveTrend === 'BEARISH' ? 'DROP' : 'HOLD',
        reason: `Freshness hilang: trend=${liveTrend || 'UNKNOWN'} (${trendSource}) m5=${formatPct(liveM5)} (${m5Source})`,
        trendSource,
        m5Source,
        liveTrend,
        liveM5,
      };
    }
  }

  // Kondisi 3: TVL minimal (hindari rug liquidity)
  const tvl = Number(pool.totalTvl || pool.activeTvl || 0);
  if (tvl < 5000) {
    return {
      ok: false,
      decision: 'HOLD',
      reason: `TVL terlalu rendah: $${tvl.toLocaleString()}`,
      trendSource,
      m5Source,
      liveTrend,
      liveM5,
    };
  }

  return {
    ok: true,
    decision: 'DEPLOY',
    trendSource,
    m5Source,
    liveTrend,
    liveM5,
  };
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
      const deferUntil = Number(entry.nextEligibleAt || 0);
      if (deferUntil > Date.now()) {
        continue;
      }

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
      const decision = String(check.decision || (check.ok ? 'DEPLOY' : 'HOLD')).toUpperCase();

      if (!check.ok) {
        console.log(
          `[QUEUE] ⏳ ${symbol} belum siap [${decision}] ` +
          `trend=${check.liveTrend || 'UNKNOWN'} (${check.trendSource || 'unknown'}) ` +
          `m5=${formatPct(check.liveM5)} (${check.m5Source || 'unknown'}) ` +
          `reason=${check.reason} (attempt ${entry.attempts}/3)`
        );
        if (check.deferUntil && Number(check.deferUntil) > Date.now()) {
          entry.nextEligibleAt = Number(check.deferUntil);
          entry.deferReason = check.reason;
          entry.deferNotifiedAt = entry.deferNotifiedAt || Date.now();
          entry.enqueuedAt = Date.now();
        }
        if (decision === 'DROP' || check.reason.includes('expired')) {
          _queue.delete(mint);
          await safeSend(
            `❌ <b>Deploy Queue ${decision === 'DROP' ? 'Drop' : 'Expired'}</b>\n` +
            `<b>${symbol}</b>\n` +
            `Trend: <code>${check.liveTrend || 'UNKNOWN'}</code> (<code>${check.trendSource || 'unknown'}</code>)\n` +
            `M5: <code>${formatPct(check.liveM5)}</code> (<code>${check.m5Source || 'unknown'}</code>)\n` +
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
      recordPoolDeploy({
        pool,
        reason: meta?.scoutReason || 'QUEUE_DEPLOY',
        source: 'DEPLOY_QUEUE',
        snapshot: {
          ...meta,
          recentTrend: check.liveTrend,
          recentM5: check.liveM5,
        },
      });
      console.log(
        `[QUEUE] 🚀 Attempting deploy for ${symbol} ` +
        `decision=${decision} trend=${check.liveTrend || 'UNKNOWN'} (${check.trendSource || 'unknown'}) ` +
        `m5=${formatPct(check.liveM5)} (${check.m5Source || 'unknown'}) ` +
        `amount=${solAmount} SOL (Pool: ${poolAddress.slice(0, 8)})`
      );
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
          `Trend: <code>${check.liveTrend || 'UNKNOWN'}</code> (<code>${check.trendSource || 'unknown'}</code>)\n` +
          `M5: <code>${formatPct(check.liveM5)}</code> (<code>${check.m5Source || 'unknown'}</code>)\n` +
          `Decision: <code>${decision}</code>\n` +
          `BinStep: <code>${pool.binStep || '?'}</code>\n` +
          `Entry: <code>${entry.meta.entryReadiness || 'N/A'}</code> | ` +
          `Breakout: <code>${entry.meta.breakoutQuality || 'N/A'}</code> | ` +
          `Timing: <code>${entry.meta.entryTimingState || 'N/A'}</code>\n` +
          `⏳ <i>Membuka posisi ${solAmount} SOL...</i>`
        );

        if (!_deployFn) {
          throw new Error('deployFn belum di-set ke DeployQueue — panggil setDeployQueueDeployFn() dulu.');
        }

        const result = await _deployFn(poolAddress, {
          hasNonRefundableFees:
            pool?._marketSnapshot?.pool?.hasNonRefundableFees ??
            pool?.hasNonRefundableFees ??
            meta?.hasNonRefundableFees ??
            false,
        });

        if (result && typeof result === 'object' && result.dryRun) {
          await safeSend(
            `🧪 <b>Dry-run (Queue Deploy)</b>\n` +
            `<b>${symbol}</b> — Simulasi selesai, tidak ada tx real.\n` +
            `Range: <code>${result.rangeMin}–${result.rangeMax}</code>`
          );
          continue;
        }
        if (result && typeof result === 'object' && result.blocked) {
          const blockedByRent = String(result.reason || '').includes('VETO_NON_REFUNDABLE_RENT');
          await safeSend(
            `${blockedByRent ? '⛔ <b>Deploy Ditolak (Queue)</b>' : '⛔ <b>Deploy Ditolak (Queue)</b>'}\n` +
            `<b>${symbol}</b> — <code>${result.reason || 'DEPLOY_BLOCKED'}</code>\n` +
          `Pool: <code>${poolAddress.slice(0, 8)}</code>\n` +
          `Range: <code>${result.rangeMin}-${result.rangeMax}</code> (max ${result.rangeMaxBins} bin)\n` +
          (result.detail ? `Detail: <code>${escapeHTML(String(result.detail).slice(0, 240))}</code>\n` : '') +
          (blockedByRent
              ? `<i>Adjust range gagal untuk pool/range ini. Pool lain tetap normal.</i>`
              : `<i>Queue menghormati veto deploy.</i>`)
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
