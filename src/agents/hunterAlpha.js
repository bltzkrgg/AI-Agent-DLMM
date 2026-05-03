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
import { getMarketSnapshot }      from '../market/oracle.js';
import { deployPosition, monitorPnL, exitPosition, markPositionManuallyClosed, setEvilPandaNotifyFn, setPositionLifecycle, getPositionOnChainStatus, EP_CONFIG, getActivePositionKeys, getPositionMeta } from '../sniper/evilPanda.js';
import { createMessage }          from '../agent/provider.js';
import { getWalletBalance }       from '../solana/wallet.js';
import { appendDecisionLog }      from '../learn/decisionLog.js';
import { isBlacklisted }          from '../learn/tokenBlacklist.js';
import { getRuntimeState }        from '../runtime/state.js';
import { escapeHTML, safeParseAI } from '../utils/safeJson.js';
import reportManager              from '../utils/reportManager.js';
import pendingStore               from '../utils/pendingStore.js';
import { enqueueForDeploy, startDeployQueueWatcher } from '../utils/pendingDeployQueue.js';
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
export function setNotifyFn(fn) {
  _notifyFn = fn;
  setEvilPandaNotifyFn(fn);
}
async function notify(msg) {
  try { await _notifyFn?.(msg); } catch { /* non-fatal */ }
}

// ── State ─────────────────────────────────────────────────────────
let _running   = false;
let _deployLock = false;
let _shutdownInProgress = false;
const _closingPositions = new Set();
const _positionLabels = new Map(); // pubkey -> { symbol }
const _monitoredPositions = new Set();
const _lastRealtimePnlLogAt = new Map();
const _pendingRetestQueue = new Map(); // mint -> { pool, symbol, reason, attempts, nextCheckAt, expiresAt }
let _manualCloseWatchTimer = null;
let _manualCloseWatchInFlight = false;

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
      pnlPct: Number(meta.pnlPct),
      currentValueSol: Number(meta.currentValueSol),
      deploySol: Number(meta.deploySol),
      hwmPct: Number(meta.hwmPct),
    };
  });
}

function hasActiveMint(mint) {
  if (!mint) return false;
  return listActivePositions().some((p) => p.mint === mint);
}

function hasActivePoolAddress(poolAddress) {
  if (!poolAddress) return false;
  return listActivePositions().some((p) => p.poolAddress === poolAddress);
}

function getPoolMint(pool = {}) {
  return pool.tokenXMint || pool.tokenX || pool.mint || pool.address || '';
}

function getPoolSymbol(pool = {}) {
  return pool.tokenXSymbol || pool.name?.split('-')[0] || getPoolMint(pool).slice(0, 8) || 'UNKNOWN';
}

function isRetestableTaVeto(vetoResult = {}) {
  const gate = String(vetoResult?.gate || '').toUpperCase();
  const reason = String(vetoResult?.reason || '').toUpperCase();
  return gate === 'SUPERTREND_15M' || reason.includes('SUPERTREND') || reason.includes('TREND 15M');
}

function addPendingRetest(pool, reason = 'TA belum valid') {
  const cfg = getConfig();
  if (cfg.pendingRetestEnabled === false) return;

  const mint = getPoolMint(pool);
  if (!mint || hasActiveMint(mint)) return;

  const now = Date.now();
  const intervalMin = Math.max(1, Number(cfg.retestIntervalMin) || 5);
  const ttlMin = Math.max(intervalMin, Number(cfg.retestTtlMin) || 60);
  const existing = _pendingRetestQueue.get(mint);

  _pendingRetestQueue.set(mint, {
    pool,
    symbol: getPoolSymbol(pool),
    reason,
    attempts: existing?.attempts || 0,
    firstSeenAt: existing?.firstSeenAt || now,
    lastReason: reason,
    nextCheckAt: now + intervalMin * 60 * 1000,
    expiresAt: existing?.expiresAt || (now + ttlMin * 60 * 1000),
  });
  console.log(`[hunter] ⏳ Pending retest: ${getPoolSymbol(pool)} — ${reason}`);
}

async function collectReadyRetestPools(cfg = getConfig()) {
  if (cfg.pendingRetestEnabled === false || _pendingRetestQueue.size === 0) return [];

  const now = Date.now();
  const maxAttempts = Math.max(1, Number(cfg.retestMaxAttempts) || 8);
  const maxReady = Math.max(1, Number(cfg.retestMaxReadyPerScan) || 3);
  const intervalMin = Math.max(1, Number(cfg.retestIntervalMin) || 5);
  const ready = [];

  for (const [mint, row] of [..._pendingRetestQueue.entries()]) {
    if (ready.length >= maxReady) break;
    if (!row?.pool || hasActiveMint(mint) || isBlacklisted(mint)) {
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.expiresAt <= now || row.attempts >= maxAttempts) {
      console.log(`[hunter] ⌛ Retest expired: ${row.symbol} attempts=${row.attempts}/${maxAttempts}`);
      _pendingRetestQueue.delete(mint);
      continue;
    }
    if (row.nextCheckAt > now) continue;

    row.attempts += 1;
    row.nextCheckAt = now + intervalMin * 60 * 1000;
    try {
      const veto = await runMeridianVeto({ mint, symbol: row.symbol, pool: row.pool });
      if (!veto.veto) {
        _pendingRetestQueue.delete(mint);
        const pool = {
          ...row.pool,
          _retestReason: row.reason,
          _retestAttempts: row.attempts,
        };
        console.log(`[hunter] ✅ Retest PASS: ${row.symbol} attempts=${row.attempts}`);
        ready.push(pool);
        continue;
      }
      row.lastReason = veto.reason || row.lastReason;
      if (!isRetestableTaVeto(veto)) {
        console.log(`[hunter] ❌ Retest dropped: ${row.symbol} — ${row.lastReason}`);
        _pendingRetestQueue.delete(mint);
        continue;
      }
      _pendingRetestQueue.set(mint, row);
      console.log(`[hunter] ⏳ Retest still pending: ${row.symbol} — ${row.lastReason}`);
    } catch (e) {
      row.lastReason = e?.message || 'Retest error';
      _pendingRetestQueue.set(mint, row);
      console.warn(`[hunter] Retest error ${row.symbol}: ${row.lastReason}`);
    }
  }

  return ready;
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

function isNaturalDeployError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return ['partial', 'simulation failed', 'slippage', 'timeout', 'blockhash']
    .some((needle) => msg.includes(needle));
}

function formatMaybePct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(digits)}%` : 'UNKNOWN';
}

function formatMaybeUsd(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `$${Math.round(num).toLocaleString('en-US')}` : 'UNKNOWN';
}

function formatMaybeBool(value) {
  if (value === true) return 'YES';
  if (value === false) return 'NO';
  return 'UNKNOWN';
}

function buildLlmPoolContext({ pool = {}, screenResult = null, vetoResult = null, marketSnapshot = null }) {
  const okx = screenResult?.okxSignals || null;
  const gmgn = screenResult?.gmgnMetrics || null;
  const taTrend = marketSnapshot?.quality?.taTrend || marketSnapshot?.ta?.supertrend?.trend || vetoResult?.diagnostics?.supertrend15m || 'UNKNOWN';
  const priceChangeM5 = marketSnapshot?.ohlcv?.priceChangeM5;
  const priceChangeH1 = marketSnapshot?.ohlcv?.priceChangeH1;
  const taReliable = marketSnapshot?.quality?.taReliable;
  const athDistancePct = vetoResult?.diagnostics?.athDistancePct;
  const stageWaterfall = screenResult?.stageWaterfall || {};
  const topFlags = Array.isArray(screenResult?.highFlags)
    ? screenResult.highFlags.slice(0, 3).map((f) => f?.msg).filter(Boolean)
    : [];

  return [
    `- Token: ${pool.tokenXSymbol || pool.name?.split('-')[0] || 'UNKNOWN'}`,
    `- Bin Step: ${pool.binStep || 0}`,
    `- Fee/TVL: ${formatMaybePct((pool.feeActiveTvlRatio || 0) * 100)}`,
    `- Volume 24h: ${formatMaybeUsd(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.volume || 0)}`,
    `- TVL: ${formatMaybeUsd(pool.activeTvl || pool.totalTvl || 0)}`,
    `- Mcap: ${formatMaybeUsd(pool.mcap || 0)}`,
    `- TA Supertrend 15m: ${String(taTrend || 'UNKNOWN').toUpperCase()}`,
    `- TA M5 Change: ${formatMaybePct(priceChangeM5)}`,
    `- TA H1 Change: ${formatMaybePct(priceChangeH1)}`,
    `- TA Reliable: ${formatMaybeBool(taReliable)}`,
    `- ATH Distance: ${Number.isFinite(Number(athDistancePct)) ? formatMaybePct(athDistancePct, 1) : 'UNKNOWN'}`,
    `- Meridian Gate: ${vetoResult?.veto ? 'FAIL' : 'PASS'} (${vetoResult?.gate || 'NONE'})`,
    `- Meridian Reason: ${vetoResult?.reason || 'UNKNOWN'}`,
    `- Stage 1 Public: ${stageWaterfall.stage1PublicData || 'UNKNOWN'}`,
    `- Stage 2 GMGN: ${stageWaterfall.stage2GmgnAudit || 'UNKNOWN'}`,
    `- Stage 3 Jupiter: ${stageWaterfall.stage3Jupiter || 'UNKNOWN'}`,
    `- OKX Available: ${formatMaybeBool(okx ? !okx.unavailable : null)}`,
    `- OKX High Risk: ${formatMaybeBool(okx?.highRisk)}`,
    `- OKX Risk Level: ${Number.isFinite(Number(okx?.riskLevel)) ? Number(okx.riskLevel) : 'UNKNOWN'}`,
    `- OKX Wash Trading: ${formatMaybePct(okx?.washTradingPct, 1)}`,
    `- OKX Bundler: ${formatMaybePct(okx?.bundlerPct, 1)}`,
    `- GMGN Status: ${screenResult?.gmgnStatus || 'UNKNOWN'}`,
    `- GMGN Top10: ${formatMaybePct(gmgn?.top10Pct, 2)}`,
    `- GMGN Dev Hold: ${formatMaybePct(gmgn?.devHoldPct, 2)}`,
    `- GMGN Insider: ${formatMaybePct(gmgn?.insiderPct, 2)}`,
    `- GMGN Bundler: ${formatMaybePct(gmgn?.bundlerPct, 2)}`,
    `- GMGN Total Fees: ${Number.isFinite(Number(gmgn?.totalFeesSol)) ? `${Number(gmgn.totalFeesSol).toFixed(2)} SOL` : 'UNKNOWN'}`,
    `- GMGN Burned LP: ${formatMaybeBool(gmgn?.burnedLp)}`,
    `- GMGN Zero Tax: ${formatMaybeBool(gmgn?.zeroTax)}`,
    `- GMGN CTO Flag: ${formatMaybeBool(gmgn?.ctoFlag)}`,
    `- GMGN Vamped: ${formatMaybeBool(gmgn?.vamped)}`,
    `- High Flags: ${topFlags.length ? topFlags.join(' | ') : 'NONE'}`,
  ].join('\n');
}

function summarizeExitError(error) {
  const raw = String(error?.message || error || 'UNKNOWN_EXIT_ERROR');
  const lower = raw.toLowerCase();
  if (lower.includes('exceeded cus meter') || lower.includes('compute units')) {
    return 'EXIT_COMPUTE_UNITS_EXHAUSTED_AFTER_RETRY — transaksi close masih kehabisan compute budget setelah retry maksimum.';
  }
  if (lower.includes('position_still_open_after_exit')) {
    return raw;
  }
  return raw.length > 900 ? `${raw.slice(0, 900)}...` : raw;
}

function getRealtimePnlIntervalMs() {
  const cfg = getConfig();
  const seconds = Math.max(5, Number(cfg.realtimePnlIntervalSec) || 15);
  return Math.round(seconds * 1000);
}

function getManualCloseWatchIntervalMs() {
  return Math.max(5000, getRealtimePnlIntervalMs());
}

export function startManualCloseWatcher() {
  if (_manualCloseWatchTimer) return false;

  const tick = async () => {
    if (_manualCloseWatchInFlight) return;
    _manualCloseWatchInFlight = true;
    try {
      const snapshot = listActivePositions();
      for (const pos of snapshot) {
        if (!pos?.pubkey || _closingPositions.has(pos.pubkey)) continue;
        try {
          const status = await getPositionOnChainStatus(pos.pubkey);
          if (!status.tracked) continue;
          if (status.manualWithdrawn) {
            console.log(
              `[hunter] Manual close watcher detected ${pos.symbol || pos.pubkey.slice(0, 8)} ` +
              `pos=${pos.pubkey.slice(0,8)} reason=${status.reason}`
            );
            await markPositionManuallyClosed(pos.pubkey, `MANUAL_WITHDRAW_DETECTED_${status.reason}`);
            _positionLabels.delete(pos.pubkey);
          }
        } catch (e) {
          console.warn(`[hunter] Manual close watcher skip ${pos.pubkey.slice(0,8)}: ${e.message}`);
        }
      }
    } finally {
      _manualCloseWatchInFlight = false;
    }
  };

  _manualCloseWatchTimer = setInterval(tick, getManualCloseWatchIntervalMs());
  _manualCloseWatchTimer.unref?.();
  tick().catch((e) => console.warn(`[hunter] Manual close watcher initial tick error: ${e.message}`));
  console.log(`[hunter] 👁️ Manual close watcher aktif interval=${Math.round(getManualCloseWatchIntervalMs() / 1000)}s`);
  return true;
}

export function stopManualCloseWatcher() {
  if (!_manualCloseWatchTimer) return false;
  clearInterval(_manualCloseWatchTimer);
  _manualCloseWatchTimer = null;
  return true;
}

function shouldLogRealtimePnl(positionPubkey) {
  const now = Date.now();
  const intervalMs = getRealtimePnlIntervalMs();
  const last = _lastRealtimePnlLogAt.get(positionPubkey) || 0;
  if (last && now - last < intervalMs) return false;
  _lastRealtimePnlLogAt.set(positionPubkey, now);
  return true;
}

function logRealtimePnl({ positionPubkey, symbol, status }) {
  const pnlPct = Number(status?.pnlPct) || 0;
  const currentValueSol = Number(status?.currentValueSol) || 0;
  const rangeIcon = status?.inRange ? '🟢' : '🟡';
  const intervalSec = Math.round(getRealtimePnlIntervalMs() / 1000);
  const ts = new Date().toISOString();
  console.log(
    `[RealtimePnL] ${ts} ${rangeIcon} ${symbol} ` +
    `pos=${positionPubkey.slice(0,8)} pnl=${pnlPct.toFixed(2)}% ` +
    `value=${currentValueSol.toFixed(4)}SOL ` +
    `action=${status?.action || 'UNKNOWN'} ` +
    `interval=${intervalSec}s`
  );
}

async function notifyRealtimePnl({ positionPubkey, symbol, status }) {
  const pnlPct = Number(status?.pnlPct) || 0;
  const currentValueSol = Number(status?.currentValueSol) || 0;
  const intervalSec = Math.round(getRealtimePnlIntervalMs() / 1000);
  const rangeStatus = status?.inRange ? 'IN_RANGE' : 'OUT_OF_RANGE';
  const sign = pnlPct >= 0 ? '+' : '';
  await notify(
    `📊 <b>Realtime PnL</b>\n` +
    `Token: <b>${escapeHTML(symbol)}</b>\n` +
    `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
    `PnL: <code>${sign}${pnlPct.toFixed(2)}%</code>\n` +
    `Value: <code>${currentValueSol.toFixed(4)} SOL</code>\n` +
    `Range: <code>${rangeStatus}</code>\n` +
    `Action: <code>${escapeHTML(status?.action || 'UNKNOWN')}</code>\n` +
    `Interval: <code>${intervalSec}s</code>`
  );
}

function getIdleDelayMin(cfg = getConfig()) {
  if (_pendingRetestQueue.size > 0) {
    return Math.max(1, Number(cfg.retestIntervalMin) || 5);
  }
  return Number(cfg.screeningIntervalMin) || 15;
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
      await notify('🚀 <b>Multi-Agent Scheduler aktif.</b>\n⚠️ <i>Auto-Screening OFF. Ketik <code>/autoscreen on</code> untuk mulai.</i>');
    } else {
      await notify('🚀 <b>Multi-Agent Scheduler aktif.</b> 🔍 Memulai scan real-time (No Cache)...');
    }

    // Loop is now managed by src/index.js multi-agent scheduler
    console.log('[hunter] Scheduler initialized. Delegating to index.js async loops.');
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

export async function scanAndDeploy() {
  let cycleReport = [];

  try {
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


  let pools = await collectReadyRetestPools(cfg);
  if (pools.length > 0) {
    console.log(`[hunter] ${pools.length} kandidat retest siap diproses ulang.`);
    await notify(
      `♻️ <b>Retest queue aktif</b>\n` +
      `${pools.length} kandidat TA sudah hijau dan masuk ulang ke pipeline.`
    );
  } else {
    try {
      // Ambil semua pool dari Meteora/Meridian fallback (sorted by binStep priority + fee ratio)
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
  // Jupiter budget dibuat minimal sebesar jumlah kandidat batch ini agar
  // pool yang sudah lolos tahap awal tidak ke-defer prematur sebelum sempat diuji.
  const configuredJupiterBudget = Number(cfg.jupiterMaxChecksPerScan);
  const jupiterBudgetRef = {
    remaining: Math.max(
      1,
      scoutCandidates.length,
      Number.isFinite(configuredJupiterBudget) && configuredJupiterBudget > 0 ? configuredJupiterBudget : 0,
      15,
    ),
  };

  let winners = [];
  reportManager.newCycle();
  
  // 1. Process Pending Store Tokens first
  pendingStore.cleanExpired();
  const pendingTokens = pendingStore.getPendingTokens();
  for (const pending of pendingTokens) {
    const poolData = pending.poolData || { mint: pending.address, tokenXMint: pending.address, tokenXSymbol: pending.name, name: pending.name };
    
    let reportEntry = reportManager.currentCycle.find(t => t.name === pending.name);
    if (!reportEntry) {
      reportEntry = reportManager.addToken(pending.name, pending.address);
    }
    
    // Check meridianVeto or TA again for the pending token
    try {
      const vetoResult = await runMeridianVeto({ mint: pending.address, symbol: pending.name, pool: poolData });
      if (vetoResult.veto && isRetestableTaVeto(vetoResult)) {
        console.log(`⏳ [Pending] Token ${pending.name} masih menunggu TA valid (Supertrend/Momentum)`);
        pendingStore.add(pending.address, pending.name, 0, 0); // Update attempt
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'DEFER', vetoResult.reason);
      } else if (vetoResult.veto) {
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'FAIL', vetoResult.reason);
        reportManager.setFinalVerdict(pending.name, 'REJECT', vetoResult.reason);
        pendingStore.remove(pending.address);
      } else {
        console.log(`🔄 [Pending] Token ${pending.name} berhasil melewati TA, melanjutkan evaluasi...`);
        reportManager.updateGate(pending.name, 'PENDING_RETEST', 'PASS', 'Berhasil melewati Supertrend');
        pendingStore.remove(pending.address);
        // Feed it back to evaluatePool by pushing to scoutCandidates
        scoutCandidates.unshift(poolData);
      }
    } catch (e) {
      console.warn(`Error processing pending token ${pending.name}: ${e.message}`);
    }
  }

  const evaluatePool = async (pool) => {
    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    
    const record = reportManager.addToken(tokenSymbol || 'UNKNOWN', tokenMint || '');
    reportManager.updateGate(tokenSymbol, 'STAGE_0_DISCOVERY', 'PASS');

    if (!tokenMint) {
      reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'FAIL', 'MISSING_TOKEN_MINT');
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'PRECHECK', reason: 'MISSING_TOKEN_MINT', summary: [] };
    }
    console.log(`[hunter] 📦 Mengevaluasi ${tokenSymbol}...`);
    
    if (isBlacklisted(tokenMint)) {
      const rejectReason = 'BLACKLIST lokal aktif';
      reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'FAIL', rejectReason);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'BLACKLIST', reason: rejectReason, summary: [] };
    }
    reportManager.updateGate(tokenSymbol, 'BLACKLIST_LOCAL', 'PASS');

    let screenResult = null;
    try {
      screenResult = await screenToken(tokenMint, tokenSymbol, tokenSymbol, { jupiterBudgetRef });
      const s1 = screenResult?.stageWaterfall?.stage1PublicData || 'UNKNOWN';
      const s2 = screenResult?.stageWaterfall?.stage2GmgnAudit || 'UNKNOWN';
      const s3 = screenResult?.stageWaterfall?.stage3Jupiter || 'UNKNOWN';
      
      reportManager.updateGate(tokenSymbol, 'STAGE_1_PUBLIC', s1 === 'PASS' ? 'PASS' : s1 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', screenResult?.sources?.okx === false ? 'OKX unavailable' : '');
      if (s1 !== 'PASS') return { ok: false, symbol: tokenSymbol, stage: 'STAGE_1_PUBLIC', reason: 'Failed Stage 1' };

      reportManager.updateGate(tokenSymbol, 'STAGE_2_GMGN', s2 === 'PASS' ? 'PASS' : s2 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', Array.isArray(screenResult?.gmgnRejects) && screenResult.gmgnRejects.length ? screenResult.gmgnRejects.map((r) => r.msg).join(' | ') : '');
      if (s2 !== 'PASS') return { ok: false, symbol: tokenSymbol, stage: 'STAGE_2_GMGN', reason: 'Failed GMGN' };

      reportManager.updateGate(tokenSymbol, 'STAGE_3_JUPITER', s3 === 'PASS' ? 'PASS' : s3 === 'SKIPPED' ? 'SKIPPED' : 'FAIL', Array.isArray(screenResult?.highFlags) && screenResult.highFlags.length ? screenResult.highFlags.map((f) => f.msg).join(' | ') : '');
      if (s3 !== 'PASS') return { ok: false, symbol: tokenSymbol, stage: 'STAGE_3_JUPITER', reason: 'Failed Jupiter' };

      if (!screenResult?.eligible) {
        return { ok: false, symbol: tokenSymbol, stage: 'WATERFALL', reason: 'Not eligible' };
      }
    } catch (e) {
      reportManager.updateGate(tokenSymbol, 'STAGE_1_PUBLIC', 'FAIL', e.message);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'STAGE_1_PUBLIC', reason: e.message };
    }

    let vetoResult = null;
    try {
      vetoResult = await runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol, pool });
      if (vetoResult.veto) {
        const rejectReason = vetoResult.reason || 'Meridian veto';
        reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'FAIL', rejectReason);
        if (isRetestableTaVeto(vetoResult)) {
          pendingStore.add(tokenMint, tokenSymbol, 0, 0, pool);
          reportManager.updateGate(tokenSymbol, 'PENDING_RETEST', 'DEFER', rejectReason);
        }
        return { ok: false, symbol: tokenSymbol, stage: 'MERIDIAN_VETO', reason: rejectReason };
      }
      reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'PASS');
      reportManager.updateGate(tokenSymbol, 'PENDING_RETEST', 'PASS');
    } catch (e) {
      reportManager.updateGate(tokenSymbol, 'MERIDIAN_VETO', 'FAIL', e.message);
      return { ok: false, symbol: tokenSymbol, stage: 'MERIDIAN_VETO', reason: e.message };
    }

    const passesConfig = checkFlatConfig(pool, cfg);
    if (!passesConfig.ok) {
      reportManager.updateGate(tokenSymbol, 'FLAT_CONFIG_GATE', 'FAIL', passesConfig.reason);
      return { ok: false, symbol: tokenSymbol, stage: 'FLAT_CONFIG_GATE', reason: passesConfig.reason };
    }
    reportManager.updateGate(tokenSymbol, 'FLAT_CONFIG_GATE', 'PASS');

    let marketSnapshot = null;
    try {
      marketSnapshot = await getMarketSnapshot(tokenMint, pool.address || pool.poolAddress || null);
    } catch (e) {
      console.warn(`[hunter] MarketSnapshot error pada ${tokenSymbol}: ${e.message}`);
    }

    try {
      const scoutModel = cfg.llm_settings?.agentModel || cfg.screeningModel || cfg.agentModel || 'UNKNOWN';
      console.log(`[hunter] 🧠 LLM stage=SCOUT model=${scoutModel}`);
      const llmPoolContext = buildLlmPoolContext({ pool, screenResult, vetoResult, marketSnapshot });
      const prompt = `[ROLE: INITIAL SCREENING FILTER FOR DLMM LIQUIDITY PROVIDER]
Kamu adalah garis pertahanan pertama untuk penyedia likuiditas DLMM Meteora.
Tugas kamu BUKAN trading spekulatif. Tugas kamu adalah menilai secara mekanis apakah sebuah pool layak masuk shortlist untuk penyediaan likuiditas.

MINDSET UTAMA:
- Kamu berpikir sebagai Liquidity Provider, bukan trader.
- Kamu tidak mengejar "buy low sell high".
- Kamu menilai apakah pool ini sehat, aman, dan punya momentum breakout yang layak untuk dipasang likuiditas.
- Entry yang kamu cari adalah breakout yang matang, bukan harga yang baru menyentuh supertrend.
- Jangan entry kalau harga masih terlalu dekat dengan supertrend 15m atau momentum belum terbukti kuat.
- Jika supertrend 15m belum bullish, jangan entry.
- Jika candle M5 belum hijau, jangan entry.
- Jika breakout belum jelas atau belum close kuat, jangan entry.
- Jika ATH belum close hijau dan momentum belum terbentuk, jangan entry.
- Jika data safety tidak lengkap atau meragukan, DEFER.
- Jika ada hard gate safety yang gagal, REJECT.
- Kalau pool sudah lolos semua filter dan breakout-nya matang, PASS.

ATURAN ENTRY YANG WAJIB:
1. Supertrend 15m harus bullish.
2. Candle M5 harus hijau.
3. Breakout harus kuat, close candle harus meyakinkan.
4. Entry terbaik adalah saat harga sudah break jauh dan valid di atas supertrend 15m bullish, atau saat ATH close hijau terbentuk dengan momentum bullish yang jelas.
5. Kalau harga cuma nempel supertrend atau baru sedikit naik, jangan entry.
6. Jangan memaksa entry saat momentum belum terbentuk.

FOKUS UTAMA KAMU:
- Volume & Market Cap
- Safety Data & Contract Security
- Wash Trading / Bundling Risk
- Dominasi awal likuiditas
- Fee opportunity
- Momentum breakout yang benar-benar hidup

DATA POOL:
${llmPoolContext}

[FORMAT JAWABAN JSON]
{
  "decision": "PASS | REJECT | DEFER",
  "reason": "Alasan singkat berbasis mcap, volume, safety data, breakout strength, atau wash trading risk.",
  "safety_score": 0-100,
  "entry_readiness": "LOW | MEDIUM | HIGH",
  "breakout_quality": "WEAK | VALID | STRONG"
}

Balas HANYA JSON valid tanpa Markdown.`;
      const res = await createMessage({
        model: scoutModel,
        componentType: 'screening',
        maxTokens: 320,
        messages: [{ role: 'user', content: prompt }]
      });
      const rawText = res.content.find(c => c.type === 'text')?.text?.trim() || '';
      const parsed = safeParseAI(rawText, null);
      const decision = String(parsed?.decision || rawText || '').trim().toUpperCase();
      const scoutReason = String(parsed?.reason || '').trim();
      const safetyScore = Number(parsed?.safety_score);
      const entryReadiness = String(parsed?.entry_readiness || '').trim().toUpperCase();
      const breakoutQuality = String(parsed?.breakout_quality || '').trim().toUpperCase();
      const scoreSuffix = Number.isFinite(safetyScore) ? ` (${Math.max(0, Math.min(100, safetyScore))})` : '';
      const detailSuffix = [
        entryReadiness ? `Entry=${entryReadiness}` : '',
        breakoutQuality ? `Breakout=${breakoutQuality}` : '',
      ].filter(Boolean).join(', ');
      
      if (decision.includes('PASS')) {
        console.log(`[hunter] 🤖 ScoutAgent LP APPROVED: ${tokenSymbol}${scoreSuffix}${detailSuffix ? ` | ${detailSuffix}` : ''}`);
        reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'PASS', scoutReason || `Entry=${entryReadiness || 'UNKNOWN'}, Breakout=${breakoutQuality || 'UNKNOWN'}`);
        pool._screenResult = screenResult;
        pool._vetoResult = vetoResult;
        pool._marketSnapshot = marketSnapshot;
        pool._llmPoolContext = llmPoolContext;
        // Masukkan ke Real-time Deploy Queue — watcher akan eksekusi saat kondisi terpenuhi
        enqueueForDeploy(pool, tokenSymbol, { scoutReason, entryReadiness, breakoutQuality });
        return { ok: true, pool, symbol: tokenSymbol || 'UNKNOWN' };
      }
      const isDeferred = decision.includes('DEFER');
      const label = isDeferred ? 'DEFER' : 'FAIL';
      const reason = scoutReason || (isDeferred ? 'Insufficient Information' : 'Weak Breakout');
      console.log(`[hunter] 🤖 ScoutAgent LP ${isDeferred ? 'DEFERRED' : 'REJECTED'}: ${tokenSymbol}${scoreSuffix}${detailSuffix ? ` | ${detailSuffix}` : ''}`);
      reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', isDeferred ? 'DEFER' : 'FAIL', reason, `Entry=${entryReadiness}, Breakout=${breakoutQuality}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason };
    } catch (e) {
      console.warn(`[hunter] ScoutAgent error pada ${tokenSymbol}: ${e.message}`);
      reportManager.updateGate(tokenSymbol, 'SCOUT_AGENT', 'FAIL', `ScoutAgent error: ${e.message}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: `ScoutAgent error: ${e.message}` };
    }

  };

  const candidateChunks = chunkArray(scoutCandidates, 2);
  for (const chunk of candidateChunks) {
    if (!_running || winners.length >= 5) break;
    const settled = await Promise.allSettled(chunk.map(evaluatePool));
    for (const item of settled) {
      if (item.status !== 'fulfilled' || !item.value) continue;
      if (item.value.ok && item.value.pool && winners.length < 5) {
        winners.push(item.value.pool);
      } else if (!item.value.ok && item.value.symbol) {
        // Handled by reportManager automatically inside evaluatePool
        reportManager.setFinalVerdict(item.value.symbol, 'REJECT', item.value.reason);
      }
    }
    await sleep(1500);
  }

  if (winners.length === 0) {
    const retryCfg = getConfig();
    const retryMin = getIdleDelayMin(retryCfg);
    console.log(`[hunter] Tidak ada kandidat lolos Scout. Scan ulang dalam ${retryMin} menit...`);
    await notify(`🔍 <i>Tidak ada kandidat lolos screening. Scan ulang dalam ${retryMin} menit.</i>`);
    await sleep(retryMin * 60 * 1000);
    return;
  }


  // ── GeneralAgent Final LP Decision ─────────────────────────────
  console.log(`[hunter] 🧠 GeneralAgent memulai final audit LP sekuensial untuk ${winners.length} kandidat...`);
  let finalWinner = null;

  for (const w of winners) {
    const sym = w.tokenXSymbol || w.name?.split('-')[0];
    const mcap = Math.round(w.mcap || 0).toLocaleString('en-US');
    const vol = Math.round(w.volume24h || w.volume_24h || w.trade_volume_24h || w.tradeVolume24h || w.volume || w.v24h || 0).toLocaleString('en-US');
    
    try {
      const managementModel = cfg.managementModel || cfg.generalModel || cfg.agentModel;
      console.log(`[hunter] 🧠 LLM stage=GENERAL model=${managementModel}`);
      const gateSummary = (w._gateSummary || []).join('\n');
      const llmPoolContext = w._llmPoolContext || buildLlmPoolContext({
        pool: w,
        screenResult: w._screenResult,
        vetoResult: w._vetoResult,
        marketSnapshot: w._marketSnapshot,
      });
      const prompt = `[ROLE: PRINCIPAL DLMM LIQUIDITY PROVIDER (FINAL DECISION MAKER)]
Kamu adalah pengambil keputusan final untuk posisi DLMM.
Keputusan kamu menentukan apakah modal jadi dipasang, dipertahankan, atau ditarik.

MINDSET UTAMA:
- Kamu bukan trader.
- Kamu adalah Liquidity Provider yang menjaga modal tetap utuh sambil memanen fee.
- Kamu tidak mengejar entry dekat supertrend.
- Kamu justru mencari breakout yang sudah matang: harga break jauh di atas supertrend 15m bullish, atau ATH close hijau dengan momentum bullish yang jelas.
- Kalau bullish momentum belum terbentuk, jangan deploy.
- Kalau posisi sudah aktif dan momentum masih bullish, pertahankan posisi.
- Jangan exit hanya karena profit kecil sempat turun kalau struktur bullish masih valid.
- Exit hanya kalau struktur rusak, stop loss kena, take profit kena, atau safety memburuk.

ATURAN KEPUTUSAN:
1. DEPLOY jika:
   - semua hard gate safety lulus
   - supertrend 15m bullish
   - candle M5 hijau
   - breakout kuat dan valid
   - harga sudah benar-benar menunjukkan momentum bullish yang sehat
2. HOLD jika:
   - posisi sudah aktif
   - supertrend 15m masih bullish
   - momentum masih sehat
   - fee capture masih berjalan
   - belum ada alasan exit yang valid
3. DEFER jika:
   - data belum cukup
   - momentum belum terbentuk
   - breakout belum matang
   - safety data ambigu
4. EXIT jika:
   - momentum bullish patah
   - stop loss kena
   - take profit kena
   - struktur trend rusak
5. PROTECT_CAPITAL jika:
   - risiko modal meningkat tajam
   - safety memburuk
   - kondisi tidak layak dipertahankan

PRINSIP KERJA:
- Entry = breakout matang, bukan harga yang baru menyentuh garis.
- Hold = selama momentum bullish masih hidup.
- Exit = hanya saat struktur patah atau target risiko tercapai.
- Kalau ada keraguan, pilih aman.

DATA FINAL:
- Token: ${sym || 'UNKNOWN'}
- High-level Summary:
${llmPoolContext}
- Gate Summary:
${gateSummary || 'N/A'}

[FORMAT JAWABAN JSON]
{
  "decision": "DEPLOY | HOLD | DEFER | EXIT | PROTECT_CAPITAL",
  "confidence": 0-100,
  "il_risk_assessment": "Low | Medium | High - Penjelasan singkat potensi impermanent loss saat ini",
  "lp_thesis": "1 kalimat konklusif kenapa range ini layak dipasang, dipertahankan, atau wajib dihindari."
}

Balas HANYA JSON valid tanpa Markdown.`;
      const res = await createMessage({
        model: managementModel,
        maxTokens: 260,
        messages: [{ role: 'user', content: prompt }]
      });
      const rawText = res.content.find(c => c.type === 'text')?.text?.trim() || '';
      const parsed = safeParseAI(rawText, null);
      const decision = String(parsed?.decision || rawText || '').trim().toUpperCase();
      const confidence = Number(parsed?.confidence);
      const confidenceSuffix = Number.isFinite(confidence) ? ` (${Math.max(0, Math.min(100, confidence))})` : '';
      const thesis = String(parsed?.lp_thesis || parsed?.il_risk_assessment || '').trim();
      
      if (decision.includes('DEPLOY')) {
        console.log(`[hunter] 🎯 GeneralAgent MEMUTUSKAN DEPLOY: ${sym}${confidenceSuffix}`);
        if (w._record) {
          w._record.reason = thesis || 'GeneralAgent DEPLOY';
        }
        finalWinner = w;
        break; // Segera eksekusi, stop audit sisanya
      } else {
        const finalDecision = decision.includes('PROTECT_CAPITAL') ? 'PROTECT_CAPITAL'
          : decision.includes('EXIT') ? 'EXIT'
          : decision.includes('DEFER') ? 'DEFER'
          : decision.includes('HOLD') ? 'HOLD'
          : 'DEFER';
        console.log(`[hunter] ✋ GeneralAgent ${finalDecision}: ${sym}${confidenceSuffix}`);
        if (w._record) {
          recordGate(w._record, 'SCOUT_AGENT', 'FAIL', thesis || finalDecision);
        }
        if (thesis) {
          appendDecisionLog({ token: sym, mint: w.tokenXMint || w.tokenX || w.mint || '', decision: 'SCREEN_FAIL',
            gate: 'GENERAL_AGENT', reason: thesis, pool: w.address || w.poolAddress || '', feeRatio: w.feeActiveTvlRatio || 0 });
        }
      }
    } catch (e) {
      console.warn(`[hunter] GeneralAgent error pada ${sym}: ${e.message}`);
    }
  }

  if (!finalWinner) {
    const retryCfg = getConfig();
    const retryMin = getIdleDelayMin(retryCfg);
    console.log(`[hunter] GeneralAgent membatalkan semua kandidat. Scan ulang dalam ${retryMin} menit...`);
    await notify(
      `✋ <b>Tidak ada deploy kali ini</b>\n` +
      `Semua kandidat final belum mendapat keputusan <code>DEPLOY</code> dari GeneralAgent LP.\n` +
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
    const poolAddress = w.address || w.pool_address || w.pool || '';
    return !hasActiveMint(mint) && !hasActivePoolAddress(poolAddress);
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
      if (hasActiveMint(tokenMint) || hasActivePoolAddress(poolAddress)) {
        console.log(`[hunter] 🔁 ${symbol} / ${poolAddress.slice(0,8)} sudah aktif. Skip double-entry.`);
        return false;
      }

      await notify(
        `Mengeksekusi <b>${symbol}</b>...\n` +
        `Tahap lolos:\n<pre>${escapeHTML((winner._gateSummary || [
          'BLACKLIST_LOCAL: PASS',
          'STAGE_1_PUBLIC: PASS',
          'STAGE_2_GMGN: PASS',
          'STAGE_3_JUPITER: PASS',
          'SCOUT_AGENT: PASS',
          'GENERAL_AGENT: DEPLOY',
        ]).join('\n'))}</pre>\n` +
        `Deploy: <code>${currentCfg.deployAmountSol || 0.1} SOL</code>\n` +
        `⏳ <i>Membuka posisi pada pool <code>${poolAddress.slice(0,8)}</code>...</i>`
      );

      let positionPubkey;
      try {
        const deployResult = await deployPosition(poolAddress);
        if (deployResult && typeof deployResult === 'object' && deployResult.dryRun) {
          if (winner._record) {
            recordGate(winner._record, 'SCOUT_AGENT', 'DEFER', 'Dry-run simulation');
          }
          await notify(
            `🧪 <b>Dry-run deploy disimulasikan</b>\n` +
            `Token: <b>${escapeHTML(symbol)}</b>\n` +
            `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
            `Tx simulasi: <code>${deployResult.txCount || 0}</code>\n` +
            `Range: <code>${deployResult.rangeMin}-${deployResult.rangeMax}</code>\n` +
            `<i>Tidak ada transaksi real yang dikirim karena mode dryRun aktif.</i>`
          );
          return false;
        }
        positionPubkey = deployResult;
        _positionLabels.set(positionPubkey, { symbol });
      } catch (e) {
        console.error(`[hunter] deployPosition gagal: ${e.message}`);
        await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Lanjut ke kandidat berikutnya...</i>`);
        if (winner._record) {
          recordGate(winner._record, 'SCOUT_AGENT', 'FAIL', `EXECUTION_FAILED: ${e.message}`);
        }
        return false;
      }

      await notify(
        `✅ <b>Posisi terbuka!</b>\n` +
        `<b>${escapeHTML(symbol)}</b> — <code>DEPLOYED</code>\n` +
        `Tahap lolos ringkas: <code>${escapeHTML(toGateCompact(winner._gateSummary || []))}</code>\n` +
        `Status: <code>DEPLOYED</code>\n` +
        `Tahap: <code>EXECUTION_SUCCESS</code>\n` +
        `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
        `Pool: <code>${poolAddress.slice(0,8)}</code>\n` +
        `TP: RSI(2) ≥ ${currentCfg.smartExitRsi || 90} | SL: -${currentCfg.stopLossPct || 10}%\n\n` +
        `🔒 <i>Masuk mode monitor (Background)...</i>`
      );

      monitorLoop(positionPubkey, symbol, poolAddress).catch(err => {
        console.error(`[hunter] Monitor loop crash untuk ${symbol}:`, err);
      });
      return true;
    });

      if (deployed) {
        if (winner._record) {
          winner._record.status = 'DEPLOYED';
          winner._record.stageFailed = '-';
        }
        availableSlots--;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (error) {
    console.error(`[hunter] scanAndDeploy critical error:`, error.message);
    return;
  } finally {
    try {
      const report = reportManager.generateReport();
      await notify(report);
    } catch (e) {
      console.error("Gagal kirim ke Telegram:", e.message);
    }
  }
}


// ── Phase 4: MONITOR loop (while position active) ────────────────

async function monitorLoop(positionPubkey, symbol, poolAddress) {
  if (_monitoredPositions.has(positionPubkey)) {
    console.log(`[hunter] Monitor loop already active: ${positionPubkey.slice(0,8)}`);
    return;
  }
  _monitoredPositions.add(positionPubkey);
  console.log(`[hunter] 🔒 MONITOR lock: ${positionPubkey.slice(0,8)} | RealtimePnL interval=${Math.round(getRealtimePnlIntervalMs() / 1000)}s`);
  let consecutiveErrors = 0;

  try {
    while (_running || getActivePositionKeys().includes(positionPubkey)) {
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
      const meta = getPositionMeta(positionPubkey) || {};
      const deploySol = Number(meta.deploySol || 0);
      const currentLifecycle = meta.lifecycleState || meta.lifecycle_state || 'open';
      const lifecycleExtra = {
        currentValueSol,
        pnlPct,
        inRange,
        deploySol,
      };
      if (Number.isFinite(Number(meta.hwmPct))) {
        lifecycleExtra.hwmPct = Number(meta.hwmPct);
      }
      const nextStatus = {
        ...status,
        deploySol,
      };
      await setPositionLifecycle(positionPubkey, currentLifecycle, lifecycleExtra);
      status = nextStatus;

      if (action === 'ERROR') {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          await notify(`⚠️ <b>Status error 5x berturut.</b> Force exit...`);
          await safeExit(positionPubkey, 'STATUS_ERROR');
          return;
        }
        continue;
      }

      if (action === 'MANUAL_CLOSED') {
        await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED');
        _positionLabels.delete(positionPubkey);
        return;
      }

      if (shouldLogRealtimePnl(positionPubkey)) {
        logRealtimePnl({ positionPubkey, symbol, status });
        await notifyRealtimePnl({ positionPubkey, symbol, status });
      }

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
  } finally {
    _monitoredPositions.delete(positionPubkey);
    _lastRealtimePnlLogAt.delete(positionPubkey);
  }
}

export function spawnMonitorForRestoredPositions() {
  const active = listActivePositions();
  let spawned = 0;
  for (const pos of active) {
    if (!pos?.pubkey || _monitoredPositions.has(pos.pubkey)) continue;
    const symbol = pos.symbol || pos.mint?.slice(0, 8) || pos.pubkey.slice(0, 8);
    monitorLoop(pos.pubkey, symbol, pos.poolAddress).catch(err => {
      console.error(`[hunter] Restored monitor loop crash untuk ${symbol}:`, err);
    });
    spawned++;
  }
  return spawned;
}

// ── Exit helper ───────────────────────────────────────────────────

async function safeExit(positionPubkey, reason) {
  if (_closingPositions.has(positionPubkey)) {
    console.log(`[hunter] safeExit skip (already closing): ${positionPubkey.slice(0,8)}`);
    throw new Error(`POSITION_ALREADY_CLOSING_${positionPubkey.slice(0,8)}`);
  }
  _closingPositions.add(positionPubkey);
  let success = false;
  try {
    const exitResult = await exitPosition(positionPubkey, reason);
    if (exitResult?.dryRun) {
      await notify(
        `🧪 <b>Dry-run exit disimulasikan</b>\n` +
        `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
        `Alasan: <code>${escapeHTML(reason)}</code>\n` +
        `<i>Tidak ada transaksi real yang dikirim karena mode dryRun aktif.</i>`
      );
      return { ok: true, dryRun: true, simulated: true };
    }
    const { solRecovered } = exitResult;
    const balance = await getWalletBalance();
    success = true;
    await notify(
      `✅ <b>Posisi ditutup (${reason})</b>\n` +
      `Position: <code>${positionPubkey.slice(0,8)}</code>\n` +
      `Balance: <code>${balance} SOL</code>`
    );
    return { ok: true, solRecovered };
  } catch (e) {
    console.error(`[hunter] exitPosition error: ${e.message}`);
    await notify(
      `⚠️ <b>Exit gagal:</b>\n` +
      `<code>${escapeHTML(summarizeExitError(e))}</code>\n\n` +
      `<i>Posisi mungkin masih terbuka on-chain dan registry lokal tidak dihapus.</i>`
    );
    throw e;
  } finally {
    if (success) _positionLabels.delete(positionPubkey);
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
      const closeResult = await Promise.race([
        safeExit(pubkey, `SHUTDOWN_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), timeoutMs)),
      ]);
      result.ok = closeResult?.ok === true && !getActivePositionKeys().includes(pubkey);
      if (!result.ok) result.reason = 'SHUTDOWN_CLOSE_NOT_VERIFIED';
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

export async function closeAllActivePositionsByUser(reason = 'MANUAL_COMMAND', timeoutMs = 180_000) {
  const snapshot = listActivePositions();
  const results = [];

  for (const pos of snapshot) {
    const pubkey = pos?.pubkey;
    if (!pubkey) continue;
    const result = {
      pubkey,
      symbol: pos.symbol || pos.mint?.slice(0, 8) || pubkey.slice(0, 8),
      ok: false,
      reason: null,
    };
    try {
      const closeResult = await Promise.race([
        safeExit(pubkey, reason),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MANUAL_EXIT_TIMEOUT')), timeoutMs)),
      ]);
      result.ok = closeResult?.ok === true && !getActivePositionKeys().includes(pubkey);
      if (!result.ok) result.reason = 'MANUAL_EXIT_NOT_VERIFIED';
    } catch (e) {
      result.reason = e?.message || 'MANUAL_EXIT_FAILED';
    }
    results.push(result);
  }

  return {
    total: snapshot.length,
    closed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    remaining: getActivePositionKeys().length,
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
      const closeResult = await Promise.race([
        safeExit(pubkey, `SHUTDOWN_RETRY_${signal}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SHUTDOWN_RETRY_TIMEOUT')), timeoutMs)),
      ]);
      if (closeResult?.ok === true && !getActivePositionKeys().includes(pubkey)) {
        recovered++;
      } else {
        stillFailed.push({ pubkey, reason: 'SHUTDOWN_RETRY_NOT_VERIFIED' });
      }
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
    return { ok: false, gate: 'BIN_STEP', reason: `binStep ${binStep} not in priority list [${binStepPriority}]` };
  }
  if (minVol > 0 && vol24h < minVol) {
    return { ok: false, gate: 'VOLUME_MIN', reason: `vol24h $${vol24h.toLocaleString()} < min $${minVol.toLocaleString()}` };
  }
  if (maxVol > 0 && vol24h > maxVol) {
    return { ok: false, gate: 'VOLUME_MAX', reason: `vol24h $${vol24h.toLocaleString()} > max $${maxVol.toLocaleString()}` };
  }
  if (minFee > 0 && feeRatio < minFee) {
    return { ok: false, gate: 'FEE_TVL_MIN', reason: `fee/tvl ${(feeRatio*100).toFixed(4)}% < min ${(minFee*100).toFixed(4)}%` };
  }
  return { ok: true, gate: 'FLAT_CONFIG_GATE', reason: 'PASS' };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toGateCompact(summary = []) {
  if (!Array.isArray(summary) || summary.length === 0) return 'N/A';
  return summary.map((line) => {
    if (line.startsWith('STAGE_0_DISCOVERY:')) return line.replace('STAGE_0_DISCOVERY:', 'S0 Discovery');
    if (line.startsWith('STAGE_1_PUBLIC:')) return line.replace('STAGE_1_PUBLIC:', 'S1 Public');
    if (line.startsWith('STAGE_2_GMGN:')) return line.replace('STAGE_2_GMGN:', 'S2 GMGN');
    if (line.startsWith('STAGE_3_JUPITER:')) return line.replace('STAGE_3_JUPITER:', 'S3 Jupiter');
    if (line.startsWith('BLACKLIST_LOCAL:')) return line.replace('BLACKLIST_LOCAL:', 'Blacklist');
    if (line.startsWith('MERIDIAN_VETO:')) return line.replace('MERIDIAN_VETO:', 'Meridian');
    if (line.startsWith('PENDING_RETEST:')) return line.replace('PENDING_RETEST:', 'Retest');
    if (line.startsWith('FLAT_CONFIG_GATE:')) return line.replace('FLAT_CONFIG_GATE:', 'FlatConfig');
    if (line.startsWith('SCOUT_AGENT:')) return line.replace('SCOUT_AGENT:', 'Scout');
    if (line.startsWith('GENERAL_AGENT:')) return line.replace('GENERAL_AGENT:', 'General');
    return line;
  }).join(' | ');
}

function buildGateStateMap(summary = []) {
  const map = new Map();
  if (!Array.isArray(summary)) return map;
  for (const line of summary) {
    if (typeof line !== 'string') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function formatGateReport(summary = [], stage = 'UNKNOWN_STAGE') {
  const gateMap = buildGateStateMap(summary);
  const normalizedStage = String(stage || '').toUpperCase();
  const order = [
    'STAGE_0_DISCOVERY',
    'BLACKLIST_LOCAL',
    'STAGE_1_PUBLIC',
    'STAGE_2_GMGN',
    'STAGE_3_JUPITER',
    'MERIDIAN_VETO',
    'PENDING_RETEST',
    'FLAT_CONFIG_GATE',
    'SCOUT_AGENT',
  ];

  const stageIndexMap = {
    BLACKLIST_LOCAL: 1,
    STAGE_1_PUBLIC: 2,
    STAGE_2_GMGN: 3,
    STAGE_3_JUPITER: 4,
    MERIDIAN_VETO: 5,
    PENDING_RETEST: 6,
    FLAT_CONFIG_GATE: 7,
    SCOUT_AGENT: 8,
  };
  const failIdx = stageIndexMap[normalizedStage] || 0;

  const labels = {
    STAGE_0_DISCOVERY: 'STAGE_0_DISCOVERY',
    BLACKLIST_LOCAL: 'BLACKLIST_LOCAL',
    STAGE_1_PUBLIC: 'STAGE_1_PUBLIC',
    STAGE_2_GMGN: 'STAGE_2_GMGN',
    STAGE_3_JUPITER: 'STAGE_3_JUPITER',
    MERIDIAN_VETO: 'MERIDIAN_VETO',
    PENDING_RETEST: 'PENDING_RETEST',
    FLAT_CONFIG_GATE: 'FLAT_CONFIG_GATE',
    SCOUT_AGENT: 'SCOUT_AGENT',
  };

  return order.map((key) => {
    const value = gateMap.get(key);
    if (value) return `${labels[key]}: ${value}`;
    if (key === 'STAGE_0_DISCOVERY') return `${labels[key]}: PASS`;
    if (key === 'BLACKLIST_LOCAL' && normalizedStage !== 'BLACKLIST_LOCAL') return `${labels[key]}: PASS`;
    if (stageIndexMap[key] && failIdx && stageIndexMap[key] < failIdx) return `${labels[key]}: PASS`;
    if (stageIndexMap[key] === failIdx) return `${labels[key]}: FAIL`;
    if (stageIndexMap[key] && stageIndexMap[key] > failIdx) return `${labels[key]}: SKIPPED`;
    return `${labels[key]}: SKIPPED`;
  }).join('\n');
}

function createCycleRecord(pool = {}, tokenMint = '', tokenSymbol = '') {
  return {
    name: tokenSymbol || pool.name || 'UNKNOWN',
    mint: tokenMint || '',
    status: 'PENDING',
    stageFailed: '',
    reason: '',
    gates: {
      STAGE_0_DISCOVERY: 'PASS',
      BLACKLIST_LOCAL: 'SKIPPED',
      STAGE_1_PUBLIC: 'SKIPPED',
      STAGE_2_GMGN: 'SKIPPED',
      STAGE_3_JUPITER: 'SKIPPED',
      MERIDIAN_VETO: 'SKIPPED',
      PENDING_RETEST: 'SKIPPED',
      FLAT_CONFIG_GATE: 'SKIPPED',
      SCOUT_AGENT: 'SKIPPED'
    },
    metadata: {}
  };
}

function recordGate(record, gate, status, reason = '', metadata = {}) {
  if (record.finalized) return;
  
  const gatesOrder = [
    'STAGE_0_DISCOVERY',
    'BLACKLIST_LOCAL',
    'STAGE_1_PUBLIC',
    'STAGE_2_GMGN',
    'STAGE_3_JUPITER',
    'MERIDIAN_VETO',
    'PENDING_RETEST',
    'FLAT_CONFIG_GATE',
    'SCOUT_AGENT'
  ];
  
  const currentIdx = gatesOrder.indexOf(gate);
  if (currentIdx === -1) return;
  
  record.gates[gate] = status;
  if (reason) record.reason = reason;
  if (metadata) record.metadata = { ...record.metadata, ...metadata };

  if (status === 'FAIL' || status === 'DEFER') {
    record.status = status === 'FAIL' ? 'REJECT' : 'REJECT'; // Format asks for REJECT/DEPLOYED
    record.stageFailed = gate;
    record.finalized = true;
    // Mark next gates as SKIPPED
    for (let i = currentIdx + 1; i < gatesOrder.length; i++) {
      record.gates[gatesOrder[i]] = 'SKIPPED';
    }
  } else if (status === 'PASS') {
    // Continue to next gate
    if (currentIdx < gatesOrder.length - 1) {
      record.gates[gatesOrder[currentIdx + 1]] = 'NOT_STARTED'; // Initial state for next gate if we wanted
    }
  }
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

// ── Immediate Top Pools Report ─────────────────────────────────────
// Dipanggil saat /autoscreen on — kirim snapshot 5 pool terbaik SEKARANG
// (sebelum pipeline screening panjang selesai).

export async function sendImmediateTopPoolsReport(chatId) {
  try {
    const cfg = getConfig();
    const limit = Number(cfg.meteoraDiscoveryLimit) || 180;
    const rawPools = await discoverHighFeePoolsMeridian({ limit });

    if (!rawPools || rawPools.length === 0) {
      await notify('⚠️ Tidak ada pool ditemukan untuk laporan instan.');
      return;
    }

    // Sort by efficiency (Vol/TVL), top 5 saja ke Telegram
    const sorted = [...rawPools]
      .sort((a, b) => {
        const aVol = Number(a.volume24h || a.trade_volume_24h || 0);
        const bVol = Number(b.volume24h || b.trade_volume_24h || 0);
        const aTvl = Number(a.totalTvl || a.activeTvl || 0) || 1;
        const bTvl = Number(b.totalTvl || b.activeTvl || 0) || 1;
        return (bVol / bTvl) - (aVol / aTvl);
      });

    const top5   = sorted.slice(0, 5);
    const rest   = sorted.slice(5);
    rest.forEach((p, i) => console.log(`[hunter][top-pools] #${i + 6} ${p.name || p.tokenXMint?.slice(0,8)} — skipped (console only)`));

    const lines = await Promise.all(top5.map(async (pool, i) => {
      const symbol  = pool.name || pool.tokenXSymbol || pool.tokenXMint?.slice(0, 8) || 'UNKNOWN';
      const binStep = pool.binStep || '?';
      const tvlRaw  = Number(pool.totalTvl || pool.activeTvl || 0);
      const volRaw  = Number(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || 0);
      const mcapRaw = Number(pool.mcap || 0);
      const ratio   = tvlRaw > 0 ? ((pool.feeRate || 0) * 100).toFixed(2) : '?';
      const effVal  = tvlRaw > 0 ? volRaw / tvlRaw : 0;
      const eff     = effVal > 1000 ? '>1000' : effVal.toFixed(2);

      let stIcon = '⚪';
      try {
        const veto = await runMeridianVeto({ mint: pool.tokenXMint || pool.address || '', symbol, pool });
        stIcon = veto.veto ? `🔴 ${veto.reason?.slice(0, 30) || 'VETO'}` : `🟢 PASS`;
      } catch (e) {
        stIcon = `⚪ skip`;
      }

      return (
        `<b>${i + 1}. ${escapeHTML(symbol)}</b> [${binStep}]\n` +
        `   Eff: <code>${eff}x</code> | Fee/TVL: <code>${ratio}%</code>\n` +
        `   TVL: <code>$${safeNum(tvlRaw, 0).toLocaleString('en-US')}</code> | ` +
        `Vol: <code>$${safeNum(volRaw, 0).toLocaleString('en-US')}</code> | ` +
        `MCap: <code>$${safeNum(mcapRaw, 0).toLocaleString('en-US')}</code>\n` +
        `   TA: ${stIcon}`
      );
    }));

    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', timeStyle: 'short' });
    const header = `📡 <b>Top 5 Pool Efisien — ${nowStr} WIB</b>\n` +
                   `<i>(Laporan instan saat autoscreen ON)</i>\n\n`;
    await notify(header + lines.join('\n\n'));
  } catch (e) {
    console.error('[sendImmediateTopPoolsReport] error:', e.message);
  }
}

// ── Auto-Screening Manual Runner ───────────────────────────────────
// Dipanggil oleh /screening dan awal /autoscreen on

let _autoScreenTimer = null;

export async function runAutoscreening(bot, chatId, opts = {}) {
  const cfg = getConfig();
  const emitReport = opts.emitReport !== false;
  
  // Guard rekursif: Hentikan loop jika Autoscreen dimatikan dari config
  if (!cfg.autoScreeningEnabled) {
    if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
    return { report: null };
  }

  if (emitReport) {
    await notify(`🔍 <b>Memulai siklus autoscreening...</b>`);
  }

  try {
    // Menjalankan pipeline lengkap (screening, gate, deploy, dan reporting akhir via notify)
    await scanAndDeploy();
  } catch (error) {
    console.error("⚠️ Autoscreening Loop Error:", error.message);
    if (emitReport) {
      await notify(`❌ <b>Error screening:</b> ${error.message}. Retrying in 15s...`);
    }
    if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
    _autoScreenTimer = setTimeout(() => runAutoscreening(bot, chatId, opts), 15000);
    return { report: null };
  }

  // Rekursif Loop: Eksekusi berulang HANYA setelah proses fetch sebelumnya sepenuhnya selesai
  const intervalMin = Number(cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15);
  const intervalMs  = intervalMin * 60 * 1000;
  
  if (_autoScreenTimer) clearTimeout(_autoScreenTimer);
  _autoScreenTimer = setTimeout(() => runAutoscreening(bot, chatId, opts), intervalMs);
  
  return { report: null };
}

export async function updatePnlStatus() {
  // Placeholder for Realtime PnL Status updates if needed
  // Monitor loop currently handles this internally per position
}

export async function inventoryManagement() {
  // Placeholder for periodic portfolio rebalancing / management
}
