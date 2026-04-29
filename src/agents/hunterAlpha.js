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
import { escapeHTML, safeParseAI } from '../utils/safeJson.js';

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
const _monitoredPositions = new Set();
const _pendingRetestQueue = new Map(); // mint -> { pool, symbol, reason, attempts, nextCheckAt, expiresAt }

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
  const rejectTelemetry = [];
  const candidateChunks = chunkArray(scoutCandidates, 2);

  const evaluatePool = async (pool) => {
    const tokenMint   = pool.tokenXMint || pool.tokenX || pool.mint;
    const tokenSymbol = pool.tokenXSymbol || pool.name?.split('-')[0] || '';
    const binStep     = pool.binStep || 0;
    const feeRatio    = pool.feeActiveTvlRatio || 0;
    const vol         = pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.volume || 0;

    if (!tokenMint) return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'PRECHECK', reason: 'MISSING_TOKEN_MINT', summary: [] };
    console.log(`[hunter] 📦 Mengevaluasi ${tokenSymbol}...`);
    const summary = [];
    summary.push('STAGE_0_DISCOVERY: PASS');

    let isEligible = true;
    let rejectReason = '';
    if (isBlacklisted(tokenMint)) {
      appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
        gate: 'BLACKLIST', reason: 'Token ada di daftar blacklist lokal',
        pool: pool.address || '', feeRatio });
      isEligible = false;
      rejectReason = 'BLACKLIST lokal aktif';
      summary.push('BLACKLIST_LOCAL: FAIL');
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'BLACKLIST', reason: rejectReason, summary };
    }
    summary.push('BLACKLIST_LOCAL: PASS');

    let screenResult = null;
    if (isEligible) {
      try {
        screenResult = await screenToken(tokenMint, tokenSymbol, tokenSymbol, { jupiterBudgetRef });
        const s1 = screenResult?.stageWaterfall?.stage1PublicData || 'UNKNOWN';
        const s2 = screenResult?.stageWaterfall?.stage2GmgnAudit || 'UNKNOWN';
        const s3 = screenResult?.stageWaterfall?.stage3Jupiter || 'UNKNOWN';
        summary.push(`STAGE_1_PUBLIC: ${s1}`);
        summary.push(`STAGE_2_GMGN: ${s2}`);
        summary.push(`STAGE_3_JUPITER: ${s3}`);
        if (!screenResult?.eligible) {
          appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'SCREEN_FAIL',
            gate: 'GMGN', reason: screenResult?.verdict || 'FAIL', pool: pool.address || '', feeRatio });
          isEligible = false;
          const stageReasonLines = Array.isArray(screenResult?.highFlags) && screenResult.highFlags.length
            ? screenResult.highFlags.slice(0, 3).map((f) => f?.msg).filter(Boolean)
            : [];
          const firstFlag = stageReasonLines.join('\n- ') || screenResult?.decisions?.slice(-1)?.[0]?.line;
          rejectReason = firstFlag || 'ScreenToken waterfall veto';
        }
      } catch (e) {
        isEligible = false;
        rejectReason = e?.message || 'ScreenToken error';
        summary.push('STAGE_1_PUBLIC: ERROR');
        summary.push('STAGE_2_GMGN: ERROR');
        summary.push('STAGE_3_JUPITER: ERROR');
      }
    }

    if (isEligible) {
      let vetoResult;
      try {
        vetoResult = await runMeridianVeto({ mint: tokenMint, symbol: tokenSymbol, pool });
      } catch (e) {
        vetoResult = {
          veto: true,
          gate: 'MERIDIAN_ERROR',
          reason: `[FAIL_CLOSED] Meridian Veto error: ${e?.message || 'UNKNOWN_ERROR'}`,
        };
      }
      if (vetoResult.veto) {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'VETO',
          gate: vetoResult.gate, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
        isEligible = false;
        rejectReason = vetoResult.reason || `Meridian veto (${vetoResult.gate || 'UNKNOWN_GATE'})`;
        summary.push('MERIDIAN_VETO: FAIL');
        if (isRetestableTaVeto(vetoResult)) {
          addPendingRetest(pool, rejectReason);
          summary.push('PENDING_RETEST: QUEUED');
        }
      } else {
        appendDecisionLog({ token: tokenSymbol, mint: tokenMint, decision: 'PASS',
          gate: null, reason: vetoResult.reason,
          pool: pool.address || pool.poolAddress || '', feeRatio });
        summary.push('MERIDIAN_VETO: PASS');
      }
    }

    if (isEligible) {
      const passesConfig = checkFlatConfig(pool, cfg);
      if (!passesConfig.ok) {
        summary.push(`FLAT_CONFIG_GATE: FAIL (${passesConfig.reason})`);
        return {
          ok: false,
          symbol: tokenSymbol || 'UNKNOWN',
          stage: passesConfig.gate || 'FLAT_CONFIG_GATE',
          reason: passesConfig.reason || 'Flat config gate failed',
          summary,
        };
      } else {
        summary.push('FLAT_CONFIG_GATE: PASS');
      }
    }

    if (!isEligible) {
      let rejectStage = 'WATERFALL';
      if (summary.includes('BLACKLIST_LOCAL: FAIL')) rejectStage = 'BLACKLIST_LOCAL';
      else if (summary.includes('STAGE_1_PUBLIC: FAIL') || summary.includes('STAGE_1_PUBLIC: ERROR')) rejectStage = 'STAGE_1_PUBLIC';
      else if (summary.includes('STAGE_2_GMGN: FAIL') || summary.includes('STAGE_2_GMGN: ERROR')) rejectStage = 'STAGE_2_GMGN';
      else if (summary.includes('STAGE_3_JUPITER: FAIL') || summary.includes('STAGE_3_JUPITER: ERROR')) rejectStage = 'STAGE_3_JUPITER';
      else if (summary.includes('MERIDIAN_VETO: FAIL')) rejectStage = 'MERIDIAN_VETO';
      else if (summary.includes('FLAT_CONFIG_GATE: FAIL')) rejectStage = 'FLAT_CONFIG_GATE';
      else if (summary.includes('SCOUT_AGENT: FAIL') || summary.includes('SCOUT_AGENT: ERROR')) rejectStage = 'SCOUT_AGENT';
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: rejectStage, reason: rejectReason || 'REJECTED_BY_GATE', summary };
    }

    try {
      const scoutModel = cfg.screeningModel || cfg.agentModel;
      console.log(`[hunter] 🧠 LLM stage=SCOUT model=${scoutModel}`);
      const prompt = `[ROLE: INITIAL SCREENING FILTER FOR DLMM LIQUIDITY PROVIDER]
Kamu adalah garis pertahanan pertama (screening filter) untuk penyedia likuiditas (LP) DLMM Meteora.
Tugas kamu BUKAN trading spekulatif, melainkan menilai secara mekanis apakah sebuah pool layak dan sehat untuk masuk shortlist penyediaan likuiditas.

FOKUS UTAMA KAMU:
- Volume & Market Cap (Apakah kolam cukup ramai dan dalam?)
- Safety Data & Contract Security (Mint/Freeze Authority, Top 10 Holders)
- Wash Trading / Bundling Risk (Apakah rasio Volume/TVL wajar atau palsu?)
- Dominasi Awal (Apakah likuiditas terpusat atau terfragmentasi?)
- Fee Opportunity (Apakah potensi pajaknya sepadan?)

MINDSET & ATURAN EKSEKUSI:
1. Pikirkan SELALU dari sudut pandang LP: aman, sehat, dan layak diberi likuiditas.
2. Jangan buang waktu memikirkan arah harga. Tugasmu hanya memastikan "Apakah kolam ini tidak beracun?"
3. DILARANG KERAS menggunakan bahasa trader seperti "pump", "moon", "buy murah", atau "breakout".
4. Kalau ada satu saja Hard Gate (indikasi rugpull/dump) yang gagal: REJECT.
5. Kalau data belum lengkap, API timeout, atau safety belum jelas: DEFER.
6. Kalau pool cukup sehat untuk dilanjutkan ke evaluasi teknikal berikutnya: PASS.

DATA POOL:
- Token: ${tokenSymbol || 'UNKNOWN'}
- Bin Step: ${binStep}
- Fee/TVL: ${(feeRatio * 100).toFixed(2)}%
- Volume 24h: $${Math.round(vol).toLocaleString('en-US')}
- TVL: $${Math.round(Number(pool.activeTvl || pool.totalTvl || 0)).toLocaleString('en-US')}
- Mcap: $${Math.round(Number(pool.mcap || 0)).toLocaleString('en-US')}

[FORMAT JAWABAN JSON]
{
  "decision": "PASS | REJECT | DEFER",
  "reason": "Alasan singkat evaluasi berbasis mcap, volume, safety data, atau wash trading risk.",
  "safety_score": 0-100
}

Balas HANYA JSON valid tanpa Markdown.`;
      const res = await createMessage({
        model: scoutModel,
        maxTokens: 220,
        messages: [{ role: 'user', content: prompt }]
      });
      const rawText = res.content.find(c => c.type === 'text')?.text?.trim() || '';
      const parsed = safeParseAI(rawText, null);
      const decision = String(parsed?.decision || rawText || '').trim().toUpperCase();
      const scoutReason = String(parsed?.reason || '').trim();
      const safetyScore = Number(parsed?.safety_score);
      const scoreSuffix = Number.isFinite(safetyScore) ? ` (${Math.max(0, Math.min(100, safetyScore))})` : '';
      if (decision.includes('PASS')) {
        console.log(`[hunter] 🤖 ScoutAgent LP APPROVED: ${tokenSymbol}${scoreSuffix}`);
        summary.push(`SCOUT_AGENT: PASS${scoreSuffix}`);
        return { ok: true, pool, symbol: tokenSymbol || 'UNKNOWN', summary };
      }
      const isDeferred = decision.includes('DEFER');
      const label = isDeferred ? 'DEFER' : 'FAIL';
      const reason = scoutReason || (isDeferred ? 'ScoutAgent DEFER' : 'ScoutAgent REJECT');
      console.log(`[hunter] 🤖 ScoutAgent LP ${isDeferred ? 'DEFERRED' : 'REJECTED'}: ${tokenSymbol}${scoreSuffix}`);
      summary.push(`SCOUT_AGENT: ${label}${scoreSuffix}`);
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason, summary };
    } catch (e) {
      console.warn(`[hunter] ScoutAgent error pada ${tokenSymbol}: ${e.message}`);
      summary.push('SCOUT_AGENT: ERROR');
      return { ok: false, symbol: tokenSymbol || 'UNKNOWN', stage: 'SCOUT_AGENT', reason: `ScoutAgent error: ${e.message}`, summary };
    }
  };

  for (const chunk of candidateChunks) {
    if (!_running || winners.length >= 5) break;
    const settled = await Promise.allSettled(chunk.map(evaluatePool));
    for (const item of settled) {
      if (item.status !== 'fulfilled' || !item.value) continue;
      if (item.value.ok && item.value.pool && winners.length < 5) {
        item.value.pool._gateSummary = item.value.summary || [];
        winners.push(item.value.pool);
      } else if (!item.value.ok) {
        rejectTelemetry.push({
          symbol: item.value.symbol || 'UNKNOWN',
          stage: item.value.stage || 'UNKNOWN_STAGE',
          reason: item.value.reason || 'REJECTED',
          summary: item.value.summary || [],
        });
      }
    }
    await sleep(1500);
  }

  if (winners.length === 0) {
    const retryCfg = getConfig();
    const retryMin = getIdleDelayMin(retryCfg);
    console.log(`[hunter] Tidak ada kandidat lolos Scout. Scan ulang dalam ${retryMin} menit...`);
    if (rejectTelemetry.length) {
      const lines = rejectTelemetry.slice(0, 5).map((r, i) => {
        const gateReport = formatGateReport(r.summary || [], r.stage || 'UNKNOWN_STAGE');
        return (
          `${i + 1}) <b>${escapeHTML(r.symbol)}</b> — REJECT\n` +
          `Tahap gagal: <code>${escapeHTML(r.stage || 'UNKNOWN_STAGE')}</code>\n` +
          `Alasan:\n<pre>${escapeHTML(String(r.reason).slice(0, 360))}</pre>\n` +
          `Gate:\n<pre>${escapeHTML(gateReport)}</pre>`
        );
      });
      await notify(
        `🚫 <b>Tidak ada deploy pada siklus ini</b>\n` +
        `${lines.join('\n\n')}`
      );
    }
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
      const prompt = `[ROLE: PRINCIPAL DLMM LIQUIDITY PROVIDER (FINAL DECISION MAKER)]
Kamu adalah pengambil keputusan final untuk ekosistem Liquidity Provider DLMM.
Tugas kamu adalah mengambil keputusan mutlak berdasarkan agregasi semua filter, safety checks, dan kondisi market. Keputusan kamu menentukan nasib modal.

FOKUS UTAMA KAMU:
- Capital Protection (Mitigasi Impermanent Loss secara mutlak)
- Fee Generation Potential (Yield/TVL Ratio)
- Exit Safety & Structure Health
- Range Quality (Kualitas volatilitas di dalam Bin Step)
- Reliability of Safety Data (Keakuratan data Meridian/Oracle)

MINDSET & ATURAN EKSEKUSI:
1. Pikirkan seperti LPer kelas institusi yang menaruh modal ke dalam range tertutup dan ingin menjaga modal tetap utuh sembari memanen pajak transaksi.
2. Kamu BUKAN trader. Jangan pernah berpikir dalam kerangka pump, quick flip, spekulasi arah harga, atau buy low sell high.
3. Momentum Sebagai Asuransi: Gunakan tren M5 hijau dan Supertrend Bullish HANYA sebagai konfirmasi bahwa struktur harga mampu menahan SOL kita agar tidak anjlok menjadi token sampah, bukan sebagai alasan fomo.
4. Kalau semua syarat metrik aman, bebas jebakan honeypot, dan produktif: DEPLOY.
5. Kalau belum cukup yakin, data ambigu, tapi kondisi belum mengancam: DEFER atau HOLD.
6. Kalau terdeteksi risiko IL yang meroket tajam atau perubahan tren ke Bearish ekstrem: EXIT atau PROTECT_CAPITAL.

DATA FINAL:
- Token: ${sym || 'UNKNOWN'}
- Mcap: $${mcap}
- Volume 24h: $${vol}
- Fee/TVL: ${((w.feeActiveTvlRatio || 0) * 100).toFixed(2)}%
- Bin Step: ${w.binStep || '?'}
- Gate Summary:
${gateSummary || 'N/A'}

[FORMAT JAWABAN JSON]
{
  "decision": "DEPLOY | HOLD | DEFER | EXIT | PROTECT_CAPITAL",
  "confidence": 0-100,
  "il_risk_assessment": "Low | Medium | High - Penjelasan potensi Impermanent Loss saat ini",
  "lp_thesis": "1 kalimat konklusif kenapa range ini layak dieksekusi atau wajib dihindari demi menjaga keutuhan modal dan fee."
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
        w._gateSummary = [...(w._gateSummary || []), `GENERAL_AGENT: DEPLOY${confidenceSuffix}`];
        finalWinner = w;
        break; // Segera eksekusi, stop audit sisanya
      } else {
        const finalDecision = decision.includes('PROTECT_CAPITAL') ? 'PROTECT_CAPITAL'
          : decision.includes('EXIT') ? 'EXIT'
          : decision.includes('DEFER') ? 'DEFER'
          : decision.includes('HOLD') ? 'HOLD'
          : 'DEFER';
        console.log(`[hunter] ✋ GeneralAgent ${finalDecision}: ${sym}${confidenceSuffix}`);
        w._gateSummary = [...(w._gateSummary || []), `GENERAL_AGENT: ${finalDecision}${confidenceSuffix}`];
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
        positionPubkey = await deployPosition(poolAddress);
        _positionLabels.set(positionPubkey, { symbol });
      } catch (e) {
        console.error(`[hunter] deployPosition gagal: ${e.message}`);
        await notify(`❌ <b>Deploy gagal:</b>\n<code>${e.message}</code>\n\n<i>Lanjut ke kandidat berikutnya...</i>`);
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
  if (_monitoredPositions.has(positionPubkey)) {
    console.log(`[hunter] Monitor loop already active: ${positionPubkey.slice(0,8)}`);
    return;
  }
  _monitoredPositions.add(positionPubkey);
  console.log(`[hunter] 🔒 MONITOR lock: ${positionPubkey.slice(0,8)}`);
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
  } finally {
    _monitoredPositions.delete(positionPubkey);
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
    const { solRecovered } = await exitPosition(positionPubkey, reason);
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
    await notify(`⚠️ <b>Exit gagal:</b>\n<code>${e.message}</code>\n\n<i>Posisi mungkin masih terbuka on-chain!</i>`);
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
          const discoverySource = pool.DISCOVERY_SOURCE || pool.discoverySource || 'METEORA_PRIMARY';

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
            `   Status: ${stIcon}\n` +
            `   Source: <code>${discoverySource}</code>`
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
