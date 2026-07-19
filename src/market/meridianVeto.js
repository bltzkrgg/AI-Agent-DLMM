/**
 * src/market/meridianVeto.js — Meridian Intelligence VETO Layer
 *
 * Mengintegrasikan kecerdasan dari repo Meridian-Experimental:
 *   1. Supertrend 15m VETO   — arah harus bullish (via Meridian chart-indicators API)
 *   2. ATH Distance VETO     — harga > 85% ATH = VETO (tidak LP di puncak)
 *   3. PVP Guard             — ada rival token serupa dengan TVL dominan = VETO
 *   4. Fee/TVL Priority Sort — pilih pool dengan rasio fee tertinggi
 *
 * Semua VETO bersifat hard-filter: return { veto: true, reason: '...' }
 * Caller (hunterAlpha.js) langsung skip token tanpa retry.
 *
 * API Base: https://api.agentmeridian.xyz/api
 * Header:   x-api-key: <publicApiKey dari config>
 */

'use strict';

import { getConfig }            from '../config.js';
import { fetchWithTimeout, withRetry } from '../utils/safeJson.js';
import { calculateSupertrend }  from '../utils/ta.js';
import * as oracle              from './oracle.js';

const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag';
const DLMM_API_BASE       = 'https://dlmm.datapi.meteora.ag';
const DATAPI_JUP          = 'https://datapi.jup.ag/v1';
const PVP_MIN_ACTIVE_TVL  = 5_000;
const PVP_MIN_HOLDERS     = 500;
const PVP_MIN_GLOBAL_FEES = 30;   // SOL
const DOMINANCE_MIN_PCT   = 15;   // Pool kita harus ≥ 15% dari total likuiditas token
const ALLOWED_QUOTE_SYMBOLS = new Set(['SOL', 'WSOL']);
const ALLOWED_QUOTE_MINTS = new Set(['So11111111111111111111111111111111111111112']);

function getQuoteTokenInfo(pool = {}) {
  const symbol = String(
    pool?.tokenYSymbol ||
    pool?.quoteSymbol ||
    pool?.quote?.symbol ||
    pool?.token_y?.symbol ||
    ''
  ).trim().toUpperCase();
  const mint = String(
    pool?.tokenYMint ||
    pool?.quoteMint ||
    pool?.quote?.mint ||
    pool?.token_y?.address ||
    pool?.token_y ||
    ''
  ).trim();
  return { symbol, mint };
}

export function isSupportedQuoteToken(pool = {}) {
  const { symbol, mint } = getQuoteTokenInfo(pool);
  return ALLOWED_QUOTE_SYMBOLS.has(symbol) || ALLOWED_QUOTE_MINTS.has(mint);
}

export function getQuoteTokenLabel(pool = {}) {
  const { symbol, mint } = getQuoteTokenInfo(pool);
  return symbol || mint || 'UNKNOWN';
}

function buildUnsupportedQuoteReason(pool = {}) {
  return `Unsupported quote token ${getQuoteTokenLabel(pool)}; expected SOL/WSOL`;
}

// ── API helpers ───────────────────────────────────────────────────

function getMeridianBase() {
  const cfg = getConfig();
  return String(cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api').replace(/\/+$/, '');
}

function getMeridianHeaders() {
  const cfg = getConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.publicApiKey) headers['x-api-key'] = cfg.publicApiKey;
  return headers;
}

// ── 1. Supertrend VETO ────────────────────────────────────────────
//
// Memanggil Meridian chart-indicators API untuk mendapatkan Supertrend 15m.
// Jika direction === 'bearish', VETO koin tersebut.
// Jika API gagal (timeout/error), VETO (fail-closed — jangan deploy saat safety data buta).

/**
 * @param {string} mint  - Token mint address
 * @returns {Promise<{veto: boolean, reason: string, direction?: string}>}
 */
export async function checkSupertrendVeto(mint, currentRealtimePrice = 0) {
  try {
    const url = `${getMeridianBase()}/chart-indicators/${mint}?interval=15_MINUTE`;
    const cfg = getConfig();
    const timeoutMs = Math.max(3000, Number(cfg.meridianSupertrendTimeoutMs) || 8000);
    const retries = Math.max(1, Number(cfg.meridianSupertrendRetries) || 2);
    const res = await withRetry(
      () => fetchWithTimeout(url, { headers: getMeridianHeaders() }, timeoutMs),
      retries,
      500
    );

    if (!res.ok) {
      return { veto: true, reason: `[FAIL_CLOSED] Meridian Supertrend API ${res.status} — safety data unavailable`, direction: 'UNKNOWN' };
    }
    
    const data = await res.json().catch(() => null);
    const direction = String(data?.latest?.supertrend?.direction || '').trim().toLowerCase();
    if (!direction) {
      return { veto: true, reason: '[FAIL_CLOSED] Meridian Supertrend missing direction', direction: 'UNKNOWN' };
    }

    if (direction === 'bullish') {
      return { veto: false, reason: `PASS: Trend 15m BULLISH via Meridian API`, direction: 'BULLISH' };
    }

    if (direction === 'bearish') {
      return { veto: true, reason: `VETO: Trend 15m BEARISH via Meridian API`, direction: 'BEARISH' };
    }

    return { veto: true, reason: `[FAIL_CLOSED] Meridian Supertrend unsupported direction: ${direction || 'UNKNOWN'}`, direction: 'UNKNOWN' };
  } catch (e) {
    return { veto: true, reason: `[FAIL_CLOSED] Meridian Supertrend exception: ${e.message}`, direction: 'UNKNOWN' };
  }
}

// ── 2. ATH Distance VETO ──────────────────────────────────────────
//
// Mengambil price_vs_ath_pct dari Meridian/OKX.
// Jika harga > (100 - maxAthDistancePct)% dari ATH → VETO.
// Contoh: maxAthDistancePct=15 → threshold=85 → VETO jika price > 85% ATH.
// Jika data tidak tersedia → VETO (fail-closed).

/**
 * @param {string} mint
 * @returns {Promise<{veto: boolean, reason: string, priceVsAthPct?: number}>}
 */
export async function checkAthDistanceVeto(mint) {
  const cfg = getConfig();
  const maxAthDistancePct = Number(cfg.maxAthDistancePct) || 15;
  const threshold         = 100 - maxAthDistancePct; // e.g. 85 → VETO jika price > 85% ATH

  try {
    const base    = getMeridianBase();
    const headers = getMeridianHeaders();

    const url = `${base}/price-info/${mint}`;
    const res = await fetchWithTimeout(url, { headers }, 6000);

    if (!res.ok) {
      return await checkAthViaJupiter(mint, threshold);
    }

    const data          = await res.json();
    const priceVsAthPct = Number(data?.price_vs_ath_pct ?? data?.priceVsAthPct ?? null);

    if (!Number.isFinite(priceVsAthPct)) {
      return { veto: true, reason: '[FAIL_CLOSED] ATH data tidak tersedia', priceVsAthPct: null };
    }

    if (priceVsAthPct > threshold) {
      return {
        veto:         true,
        reason:       `[TA_ATH_DANGER] Harga ${priceVsAthPct.toFixed(1)}% dari ATH > limit ${threshold}% — terlalu dekat puncak, tidak aman untuk LP`,
        priceVsAthPct,
      };
    }

    return {
      veto:         false,
      reason:       `ATH ok: ${priceVsAthPct.toFixed(1)}% dari ATH (limit ${threshold}%)`,
      priceVsAthPct,
    };

  } catch (e) {
    console.warn(`[meridianVeto] ATH check error ${mint.slice(0,8)}: ${e.message} — FAIL_CLOSED`);
    return { veto: true, reason: `[FAIL_CLOSED] ATH API error: ${e.message}`, priceVsAthPct: null };
  }
}

async function checkAthViaJupiter(mint, threshold) {
  try {
    const url = `${DATAPI_JUP}/assets/search?query=${encodeURIComponent(mint)}`;
    const res = await fetchWithTimeout(url, {}, 6000);
    if (!res.ok) return { veto: true, reason: `[FAIL_CLOSED] Jupiter ATH unavailable HTTP_${res.status}` };

    const data          = await res.json();
    const asset         = Array.isArray(data) ? data[0] : data;
    const priceVsAthPct = Number(asset?.priceVsAth ?? asset?.price_vs_ath_pct ?? null);

    if (!Number.isFinite(priceVsAthPct)) {
      return { veto: true, reason: '[FAIL_CLOSED] ATH data tidak tersedia', priceVsAthPct: null };
    }
    if (priceVsAthPct > threshold) {
      return {
        veto:         true,
        reason:       `[TA_ATH_DANGER] (jup) Harga ${priceVsAthPct.toFixed(1)}% dari ATH > ${threshold}% — euforia puncak`,
        priceVsAthPct,
      };
    }
    return { veto: false, reason: `ATH ok (jup): ${priceVsAthPct.toFixed(1)}%`, priceVsAthPct };
  } catch {
    return { veto: true, reason: '[FAIL_CLOSED] ATH Jupiter error', priceVsAthPct: null };
  }
}

// ── NEW: Dominance Check (PVP Risk) ───────────────────────────────────────────────
//
// Cek apakah pool yang kita pilih memiliki dominasi likuiditas yang cukup.
// Jika activeTvl pool kita < DOMINANCE_MIN_PCT% dari total likuiditas token
// di seluruh jaringan → VETO [LOW_DOMINANCE].
// Sumber data: Meteora DLMM API (semua pool token tersebut, sort by tvl:desc).
// Fail-closed jika API error atau data tidak tersedia.

/**
 * @param {string} mint        - Token mint (base token)
 * @param {number} poolTvl     - TVL aktif pool yang kita pilih (USD)
 * @param {string} [poolAddr]  - Alamat pool kita (untuk exclude dari total jika perlu)
 * @returns {Promise<{veto: boolean, reason: string, dominancePct?: number}>}
 */
export async function checkDominanceVeto(mint, poolTvl, poolAddr) {
  const minDomPct = DOMINANCE_MIN_PCT; // 15%

  // Jika pool kita tidak punya TVL data — fail-closed
  if (!mint || !Number.isFinite(poolTvl) || poolTvl <= 0) {
    return { veto: true, reason: '[FAIL_CLOSED] TVL data pool tidak tersedia — dominance safety unavailable' };
  }

  try {
    // Ambil semua pool DLMM untuk token ini, sorted by TVL DESC
    const url = `${DLMM_API_BASE}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent('tvl:desc')}&page_size=20`;
    const res = await fetchWithTimeout(url, {}, 8000);

    if (!res.ok) {
      console.warn(`[meridianVeto] Dominance API ${res.status} untuk ${mint.slice(0,8)} — FAIL_CLOSED`);
      return { veto: true, reason: `[FAIL_CLOSED] Dominance API ${res.status}` };
    }

    const data  = await res.json();
    const pools = Array.isArray(data?.data) ? data.data : [];

    if (pools.length === 0) {
      return { veto: true, reason: '[FAIL_CLOSED] Dominance data kosong — safety unavailable' };
    }

    // Hitung total TVL semua pool yang mengandung token ini
    const totalNetworkTvl = pools.reduce((sum, p) => {
      const tvl = Number(p.tvl || p.active_tvl || 0);
      return sum + (Number.isFinite(tvl) ? tvl : 0);
    }, 0);

    if (totalNetworkTvl <= 0) {
      return { veto: true, reason: '[FAIL_CLOSED] Total network TVL nol — dominance safety unavailable' };
    }

    const dominancePct = (poolTvl / totalNetworkTvl) * 100;

    console.log(`[meridianVeto] Dominance: pool=${poolTvl.toFixed(0)} total=${totalNetworkTvl.toFixed(0)} dom=${dominancePct.toFixed(1)}%`);

    if (dominancePct < minDomPct) {
      return {
        veto:         true,
        reason:       `[LOW_DOMINANCE] Pool kita ${dominancePct.toFixed(1)}% dari total likuiditas token ($${Math.round(totalNetworkTvl).toLocaleString()}) — ada pool lebih dominan`,
        dominancePct,
        totalNetworkTvl,
      };
    }

    return {
      veto:         false,
      reason:       `Dominance ok: ${dominancePct.toFixed(1)}% dari total TVL`,
      dominancePct,
      totalNetworkTvl,
    };

  } catch (e) {
    console.warn(`[meridianVeto] Dominance check error ${mint.slice(0,8)}: ${e.message} — FAIL_CLOSED`);
    return { veto: true, reason: `[FAIL_CLOSED] Dominance error: ${e.message}` };
  }
}

// ── 3. PVP Guard ──────────────────────────────────────────────────
//
// Cek apakah ada token rival dengan simbol sama yang punya:
//   - holders > 500 AND total fees > 30 SOL AND TVL aktif > $5000
// Jika rival dominan ditemukan → VETO (pasar terpecah, LP kita tidak dominan).
// Fail-closed jika API error.

/**
 * @param {string} mint   - Token mint kita
 * @param {string} symbol - Simbol token (untuk cari rival)
 * @returns {Promise<{veto: boolean, reason: string, rivalName?: string}>}
 */
export async function checkPvpGuardVeto(mint, symbol) {
  try {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!normalizedSymbol) return { veto: false, reason: 'No symbol — skip PVP check' };

    // Cari semua aset dengan simbol yang sama
    const searchUrl = `${DATAPI_JUP}/assets/search?query=${encodeURIComponent(normalizedSymbol)}`;
    const searchRes = await fetchWithTimeout(searchUrl, {}, 6000);
    if (!searchRes.ok) return { veto: true, reason: `[FAIL_CLOSED] PVP search HTTP_${searchRes.status}` };

    const assets      = await searchRes.json();
    const assetList   = Array.isArray(assets) ? assets : [assets];

    // Filter rival: simbol sama, mint berbeda, holders & fees cukup besar
    const rivals = assetList.filter(a => {
      const sameSymbol   = String(a?.symbol || '').trim().toUpperCase() === normalizedSymbol;
      const differentMint = a?.id && a.id !== mint;
      const enoughHolders = Number(a?.holderCount || 0) >= PVP_MIN_HOLDERS;
      const enoughFees    = Number(a?.fees || 0) >= PVP_MIN_GLOBAL_FEES;
      return sameSymbol && differentMint && enoughHolders && enoughFees;
    });

    if (rivals.length === 0) {
      return { veto: false, reason: 'Tidak ada rival PVP ditemukan' };
    }

    // Cek apakah rival punya pool dengan TVL aktif > threshold
    for (const rival of rivals.slice(0, 2)) {
      try {
        const poolUrl = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(rival.id)}&sort_by=${encodeURIComponent('tvl:desc')}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
        const poolRes = await fetchWithTimeout(poolUrl, {}, 6000);
        if (!poolRes.ok) {
          return { veto: true, reason: `[FAIL_CLOSED] PVP rival pool HTTP_${poolRes.status}` };
        }

        const poolData  = await poolRes.json();
        const pools     = Array.isArray(poolData?.data) ? poolData.data : [];
        const rivalPool = pools.find(p => p?.token_x?.address === rival.id || p?.token_y?.address === rival.id);

        if (rivalPool) {
          const rivalTvl = Number(rivalPool.tvl || 0);
          return {
            veto:      true,
            reason:    `PVP guard: rival "${rival.name || rival.symbol}" (${rival.id?.slice(0,8)}) punya pool dominan TVL=$${Math.round(rivalTvl).toLocaleString()}`,
            rivalName: rival.name || rival.symbol,
            rivalMint: rival.id,
            rivalTvl,
          };
        }
      } catch (e) {
        return { veto: true, reason: `[FAIL_CLOSED] PVP rival pool error: ${e.message}` };
      }
    }

    return { veto: false, reason: 'Rival ada tapi tidak punya pool dominan — PASS' };

  } catch (e) {
    console.warn(`[meridianVeto] PVP check error ${mint.slice(0,8)}: ${e.message} — FAIL_CLOSED`);
    return { veto: true, reason: `[FAIL_CLOSED] PVP error: ${e.message}` };
  }
}

// ── 4. Pool Discovery via Meteora-first ───────────────────────────
//
// Mengambil daftar pool dari Meteora Pool Discovery API sebagai sumber utama.
// Meridian Server Discovery dipakai hanya sebagai fallback bila Meteora kosong/error.
// Filter: binStep sesuai binStepPriority, sorted by fee_active_tvl_ratio DESC.

async function fetchDiscoveryPoolsFromMeteora(limit, filterStr, timeframe, category) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${limit}&filter_by=${encodeURIComponent(filterStr)}&timeframe=${timeframe}&category=${category}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) {
    return { pools: [], source: null, reason: `Meteora Discovery ${res.status}` };
  }
  const data = await res.json();
  const pools = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
  return { pools, source: 'METEORA_PRIMARY', reason: 'Meteora Discovery PASS' };
}

async function fetchDiscoveryPoolsFromMeridian(limit, filterStr, timeframe, category) {
  const cfg = getConfig();
  if (!cfg.publicApiKey) return { pools: [], source: null, reason: 'Meridian discovery skipped (no publicApiKey)' };
  const base = getMeridianBase();
  const url = `${base}/discovery/pools?page_size=${limit}&filter_by=${encodeURIComponent(filterStr)}&timeframe=${timeframe}&category=${category}`;
  const res = await fetchWithTimeout(url, { headers: getMeridianHeaders() }, 10000);
  if (!res.ok) {
    return { pools: [], source: null, reason: `Meridian Discovery ${res.status}` };
  }
  const data = await res.json();
  const pools = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
  return { pools, source: 'MERIDIAN_FALLBACK', reason: 'Meridian Discovery PASS' };
}

function getDiscoveryActivityPriorityMode(category = '') {
  const normalized = String(category || '').trim().toLowerCase();
  if (normalized === 'trending') return 'trend_activity';
  if (normalized === 'top performers') return 'performance_activity';
  return 'fee_first';
}

function readNonNegativeMetric(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return { available: true, value: numeric };
    }
  }
  return { available: false, value: null };
}

function readSignedMetric(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function readWindowMetric(pool = {}, key = '', window = '', flatValues = []) {
  const nested = pool?.[key];
  const nestedValue = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested?.[window]
    : null;
  const scalarValue = window === '24h' && (typeof nested === 'number' || typeof nested === 'string')
    ? nested
    : null;
  return readNonNegativeMetric(nestedValue, ...flatValues, scalarValue);
}

function getActivityStateRank(pool = {}) {
  const state = String(pool?.activityState || pool?._activityState || 'UNKNOWN_ACTIVITY').toUpperCase();
  if (state === 'OBSERVED_ACTIVE') return 3;
  if (state === 'UNKNOWN_ACTIVITY') return 2;
  return 0;
}

function getDiscoveryFlowTrendScore(pool = {}) {
  const values = [
    pool?.feeChangePct,
    pool?.swapCountChangePct,
    pool?.volumeChangePct,
  ].map(Number).filter(Number.isFinite);
  if (values.length === 0) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(-100, Math.min(100, average));
}

function isObservedDryDiscoveryPool(pool = {}) {
  const state = String(pool?.activityState || pool?._activityState || '').toUpperCase();
  return state === 'OBSERVED_DRY' || state === 'STALE_SPIKE';
}

function classifyDiscoveryActivity({
  volume1h = { available: false, value: null },
  fees1h = { available: false, value: null },
  swaps1h = { available: false, value: null },
  volume24h = { available: false, value: null },
  fees24h = { available: false, value: null },
  swaps24h = { available: false, value: null },
  windowLabel = '24h',
} = {}) {
  if (swaps1h.available && swaps1h.value > 0) {
    return { state: 'OBSERVED_ACTIVE', window: '1h', reason: 'recent activity is positive' };
  }
  if (
    fees1h.available &&
    fees1h.value === 0 &&
    swaps1h.available &&
    swaps1h.value === 0
  ) {
    const historicalPositive = [volume24h, fees24h, swaps24h]
      .some((metric) => metric?.available && metric.value > 0);
    return {
      state: historicalPositive ? 'STALE_SPIKE' : 'OBSERVED_DRY',
      window: '1h',
      reason: historicalPositive ? 'historical flow exists but recent activity is zero' : 'recent activity is zero',
    };
  }

  if (swaps24h.available && swaps24h.value > 0) {
    return { state: 'OBSERVED_ACTIVE', window: windowLabel, reason: 'discovery-window swaps are positive' };
  }
  if (
    fees24h.available &&
    fees24h.value === 0 &&
    swaps24h.available &&
    swaps24h.value === 0
  ) {
    return {
      state: volume24h.available && volume24h.value > 0 ? 'STALE_SPIKE' : 'OBSERVED_DRY',
      window: '24h',
      reason: volume24h.available && volume24h.value > 0
        ? 'volume is present without fee or swap support'
        : 'fee and swap activity are explicitly zero',
    };
  }

  return { state: 'UNKNOWN_ACTIVITY', window: null, reason: 'recent activity evidence is incomplete' };
}

function getDiscoveryActivityBiasScore(pool = {}) {
  const volume24h = Number(pool?.volume24h || 0);
  const volume1h = Number(pool?.volume1h || 0);
  const feeRatio = Number(pool?.feeActiveTvlRatio || 0);
  const fees24h = Number(pool?.fees24h || 0);
  const fees1h = Number(pool?.fees1h || 0);
  const txns24h = Number(pool?.swapCount24h || 0);
  const tvl = Number(pool?.activeTvl || pool?.totalTvl || 0);
  const volumeTvlRatio = tvl > 0 ? volume24h / tvl : 0;
  const activityRank = getActivityStateRank(pool);
  const flowTrendScore = getDiscoveryFlowTrendScore(pool);

  let score = 0;

  if (activityRank === 3) score += 5;
  if (isObservedDryDiscoveryPool(pool)) score -= 20;
  if (flowTrendScore >= 20) score += 3;
  else if (flowTrendScore < 0) score -= 3;

  if (volume1h >= 50_000) score += 4;
  else if (volume1h >= 10_000) score += 2;
  else if (volume1h > 0) score += 1;

  if (fees1h >= 300) score += 4;
  else if (fees1h >= 50) score += 2;
  else if (fees1h > 0) score += 1;

  if (volume24h >= 500_000) score += 4;
  else if (volume24h >= 150_000) score += 2;
  else if (volume24h > 0 && volume24h < 50_000) score -= 2;

  if (feeRatio >= 0.02) score += 4;
  else if (feeRatio >= 0.01) score += 2;
  else if (feeRatio > 0 && feeRatio < 0.005) score -= 2;

  if (fees24h >= 1_000) score += 2;
  else if (fees24h >= 300) score += 1;
  else if (fees24h > 0 && fees24h < 100) score -= 1;

  if (volumeTvlRatio >= 4) score += 2;
  else if (volumeTvlRatio >= 2) score += 1;
  else if (volumeTvlRatio > 0 && volumeTvlRatio < 1) score -= 2;

  if (txns24h >= 1_000) score += 1;
  else if (txns24h > 0 && txns24h < 200) score -= 1;

  return score;
}

function getDiscoveryLivingFlowScore(pool = {}) {
  const volume24h = Number(pool?.volume24h || 0);
  const volume1h = Number(pool?.volume1h || 0);
  const feeRatio = Number(pool?.feeActiveTvlRatio || 0);
  const fees24h = Number(pool?.fees24h || 0);
  const fees1h = Number(pool?.fees1h || 0);
  const txns24h = Number(pool?.swapCount24h || 0);
  const txns1h = Number(pool?.swapCount1h || 0);
  const tvl = Number(pool?.activeTvl || pool?.totalTvl || 0);
  const volumeTvlRatio = tvl > 0 ? volume24h / tvl : 0;
  const flowTrendScore = getDiscoveryFlowTrendScore(pool);

  if (isObservedDryDiscoveryPool(pool)) return -100;

  let score = 0;

  if (getActivityStateRank(pool) === 3) score += 12;
  score += Math.round(flowTrendScore / 20);

  if (volume1h >= 100_000) score += 10;
  else if (volume1h >= 30_000) score += 7;
  else if (volume1h >= 10_000) score += 4;
  else if (volume1h > 0) score += 1;

  if (fees1h >= 300) score += 5;
  else if (fees1h >= 50) score += 3;
  else if (fees1h > 0) score += 1;

  if (txns1h >= 300) score += 4;
  else if (txns1h >= 50) score += 2;
  else if (txns1h > 0) score += 1;

  if (volume24h >= 900_000) score += 10;
  else if (volume24h >= 500_000) score += 7;
  else if (volume24h >= 200_000) score += 4;
  else if (volume24h > 0 && volume24h < 60_000) score -= 5;

  if (fees24h >= 1_000) score += 5;
  else if (fees24h >= 300) score += 3;
  else if (fees24h > 0 && fees24h < 100) score -= 3;

  if (txns24h >= 1_500) score += 4;
  else if (txns24h >= 700) score += 2;
  else if (txns24h > 0 && txns24h < 200) score -= 3;

  if (volumeTvlRatio >= 4) score += 3;
  else if (volumeTvlRatio >= 2) score += 1;
  else if (volumeTvlRatio > 0 && volumeTvlRatio < 1) score -= 2;

  if (feeRatio >= 0.01) score += 2;
  else if (feeRatio > 0 && feeRatio < 0.003) score -= 2;

  if (volume24h >= 500_000 && fees24h >= 300 && txns24h >= 500) score += 5;
  if (volume24h >= 200_000 && (fees24h <= 0 || txns24h <= 0)) score -= 4;

  return score;
}

function compareDiscoveryPriority(a = {}, b = {}, {
  binStepPriority = [],
  priorityMode = 'fee_first',
} = {}) {
  const aVolume = Number(a?.volume24h || 0);
  const bVolume = Number(b?.volume24h || 0);
  const aRecentVolume = Number(a?.volume1h || 0);
  const bRecentVolume = Number(b?.volume1h || 0);
  const aFeeRatio = Number(a?.feeActiveTvlRatio || 0);
  const bFeeRatio = Number(b?.feeActiveTvlRatio || 0);
  const aRecentFees = Number(a?.fees1h || 0);
  const bRecentFees = Number(b?.fees1h || 0);
  const aTxns = Number(a?.swapCount24h || 0);
  const bTxns = Number(b?.swapCount24h || 0);
  const aRecentTxns = Number(a?.swapCount1h || 0);
  const bRecentTxns = Number(b?.swapCount1h || 0);
  const aTvl = Number(a?.activeTvl || a?.totalTvl || 0);
  const bTvl = Number(b?.activeTvl || b?.totalTvl || 0);
  const aActivityRank = getActivityStateRank(a);
  const bActivityRank = getActivityStateRank(b);
  const aFlowTrend = getDiscoveryFlowTrendScore(a);
  const bFlowTrend = getDiscoveryFlowTrendScore(b);
  const aAvgSwaps = Number(a?.avgSwapCount || 0);
  const bAvgSwaps = Number(b?.avgSwapCount || 0);
  const aAvgFees = Number(a?.avgFee || 0);
  const bAvgFees = Number(b?.avgFee || 0);
  const aAvgVolume = Number(a?.avgVolume || 0);
  const bAvgVolume = Number(b?.avgVolume || 0);
  const aActivityBias = getDiscoveryActivityBiasScore(a);
  const bActivityBias = getDiscoveryActivityBiasScore(b);
  const aLivingFlow = getDiscoveryLivingFlowScore(a);
  const bLivingFlow = getDiscoveryLivingFlowScore(b);

  if (aActivityRank !== bActivityRank) return bActivityRank - aActivityRank;
  if (aRecentTxns !== bRecentTxns) return bRecentTxns - aRecentTxns;
  if (aRecentFees !== bRecentFees) return bRecentFees - aRecentFees;
  if (aRecentVolume !== bRecentVolume) return bRecentVolume - aRecentVolume;
  if (aFlowTrend !== bFlowTrend) return bFlowTrend - aFlowTrend;
  if (aLivingFlow !== bLivingFlow) return bLivingFlow - aLivingFlow;
  if (aAvgSwaps !== bAvgSwaps) return bAvgSwaps - aAvgSwaps;
  if (aAvgFees !== bAvgFees) return bAvgFees - aAvgFees;
  if (aAvgVolume !== bAvgVolume) return bAvgVolume - aAvgVolume;

  if (priorityMode === 'trend_activity') {
    if (aActivityBias !== bActivityBias) return bActivityBias - aActivityBias;
    if (aTxns !== bTxns) return bTxns - aTxns;
    if (aVolume !== bVolume) return bVolume - aVolume;
    if (aFeeRatio !== bFeeRatio) return bFeeRatio - aFeeRatio;
    if (aTvl !== bTvl) return bTvl - aTvl;
  } else if (priorityMode === 'performance_activity') {
    if (aActivityBias !== bActivityBias) return bActivityBias - aActivityBias;
    if (aFeeRatio !== bFeeRatio) return bFeeRatio - aFeeRatio;
    if (aVolume !== bVolume) return bVolume - aVolume;
    if (aTxns !== bTxns) return bTxns - aTxns;
    if (aTvl !== bTvl) return bTvl - aTvl;
  } else {
    if (aActivityBias !== bActivityBias) return bActivityBias - aActivityBias;
    if (aTxns !== bTxns) return bTxns - aTxns;
    if (aVolume !== bVolume) return bVolume - aVolume;
    if (aFeeRatio !== bFeeRatio) return bFeeRatio - aFeeRatio;
    if (aTvl !== bTvl) return bTvl - aTvl;
  }

  const aPrio = binStepPriority.indexOf(Number(a?.binStep || 0));
  const bPrio = binStepPriority.indexOf(Number(b?.binStep || 0));
  const aBinRank = aPrio >= 0 ? aPrio : Number.MAX_SAFE_INTEGER;
  const bBinRank = bPrio >= 0 ? bPrio : Number.MAX_SAFE_INTEGER;
  return aBinRank - bBinRank;
}

/**
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array>} - Array pool objects sorted by fee/tvl ratio
 */
export async function discoverHighFeePoolsMeridian({ limit = 50 } = {}) {
  const cfg = getConfig();

  const binStepPriority = Array.isArray(cfg.binStepPriority) ? cfg.binStepPriority.map(Number) : [200, 125, 100];
  const minFeeRatio = Number(cfg.minFeeActiveTvlRatio) || 0.002;
  const minMcap = cfg.minMcap !== undefined ? Number(cfg.minMcap) : 250000;
  const maxMcap = Number(cfg.maxMcapUsd || cfg.maxMcap) || 0;
  const minTvl = Number(cfg.minTvl) || 0;
  const maxTvl = Number(cfg.maxTvl) || 0;
  const timeframe = cfg.discoveryTimeframe || '1h';
  const category = cfg.discoveryCategory || '';
  const priorityMode = getDiscoveryActivityPriorityMode(category);

  const minBinStep = Math.min(...binStepPriority);
  const maxBinStep = Math.max(...binStepPriority);

  const filterParts = [
    'base_token_has_critical_warnings=false',
    'quote_token_has_critical_warnings=false',
    'pool_type=dlmm',
    `base_token_market_cap>=${minMcap}`,
    `tvl>=${minTvl}`,
    `dlmm_bin_step>=${minBinStep}`,
    `dlmm_bin_step<=${maxBinStep}`,
    `fee_active_tvl_ratio>=${minFeeRatio}`,
  ];
  if (maxMcap > 0) filterParts.push(`base_token_market_cap<=${maxMcap}`);
  if (maxTvl > 0) filterParts.push(`tvl<=${maxTvl}`);

  const filterStr = filterParts.join('&&');

  let rawPools = [];
  let discoverySource = 'METEORA_PRIMARY';

  try {
    const meteora = await fetchDiscoveryPoolsFromMeteora(limit, filterStr, timeframe, category);
    rawPools = meteora.pools || [];
    discoverySource = meteora.source || discoverySource;
    console.log(`[meridianVeto] Meteora Discovery: ${rawPools.length} pools`);
  } catch (e) {
    console.warn(`[meridianVeto] Meteora Discovery error: ${e.message} — fallback ke Meridian`);
  }

  if (rawPools.length === 0) {
    try {
      const meridian = await fetchDiscoveryPoolsFromMeridian(limit, filterStr, timeframe, category);
      rawPools = meridian.pools || [];
      discoverySource = meridian.source || discoverySource;
      if (rawPools.length > 0) {
        console.log(`[meridianVeto] Meridian Discovery fallback: ${rawPools.length} pools`);
      }
    } catch (e) {
      console.warn(`[meridianVeto] Meridian Discovery error: ${e.message}`);
    }
  }

  if (rawPools.length === 0) return [];

  const normalized = rawPools
    .map((p) => normalizePool(p, discoverySource, timeframe))
    .filter(p => {
      if (!isSupportedQuoteToken(p)) return false;
      if (!binStepPriority.includes(p.binStep)) return false;
      return !isObservedDryDiscoveryPool(p);
    })
    .sort((a, b) => compareDiscoveryPriority(a, b, { binStepPriority, priorityMode }))
    .slice(0, limit);

  return normalized;
}

// ── Pool normalizer ───────────────────────────────────────────────

function normalizePool(p, discoverySource = 'MERIDIAN', timeframe = '24h') {
  const normalizedTimeframe = String(timeframe || '24h').trim().toLowerCase();
  const usesFlatOneHourWindow = normalizedTimeframe === '1h';
  const binStep = Number(p.pool_config?.bin_step || p.dlmm_params?.bin_step || p.bin_step || p.binStep || 0);
  const volume1hExplicit = readWindowMetric(p, 'volume', '1h', [
    p.volume1h,
    p.volume_1h,
    p.trade_volume_1h,
    p.tradeVolume1h,
    p.v1h,
  ]);
  const volume1h = volume1hExplicit.available || !usesFlatOneHourWindow
    ? volume1hExplicit
    : readNonNegativeMetric(p.volume);
  const volume24h = readWindowMetric(p, 'volume', '24h', [
    p.volume24h,
    p.volume_24h,
    p.trade_volume_24h,
    p.tradeVolume24h,
    p.v24h,
  ]);
  const fees1hExplicit = readWindowMetric(p, 'fees', '1h', [
    p.fees1h,
    p.fee1h,
    p.fee_1h,
  ]);
  const fees1h = fees1hExplicit.available || !usesFlatOneHourWindow
    ? fees1hExplicit
    : readNonNegativeMetric(p.fee);
  const fees24h = readWindowMetric(p, 'fees', '24h', [
    p.fees24h,
    p.fee24h,
    p.fee_24h,
    p.fee,
  ]);
  const swaps1hExplicit = readNonNegativeMetric(p.swap_count_1h, p.swapCount1h, p.txns1h);
  const swaps1h = swaps1hExplicit.available || !usesFlatOneHourWindow
    ? swaps1hExplicit
    : readNonNegativeMetric(p.swap_count, p.swapCount);
  const swaps24h = readNonNegativeMetric(p.swap_count, p.swapCount, p.txns24h);
  const feeRatio1hExplicit = readWindowMetric(p, 'fee_tvl_ratio', '1h', [
    p.fee_tvl_ratio_1h,
    p.feeTvlRatio1h,
  ]);
  const feeRatio1h = feeRatio1hExplicit.available || !usesFlatOneHourWindow
    ? feeRatio1hExplicit
    : readNonNegativeMetric(p.fee_active_tvl_ratio, p.feeActiveTvlRatio);
  const feeRatio24h = readWindowMetric(p, 'fee_tvl_ratio', '24h', [
    p.fee_active_tvl_ratio,
    p.fee_tvl_ratio_24h,
    p.feeTvlRatio,
    p.feeActiveTvlRatio,
  ]);
  const activeTvl = Number(p.active_tvl || p.activeTvl || 0);
  const totalTvl = Number(p.tvl || p.total_tvl || p.totalTvl || activeTvl || 0);
  const ratioTvl = activeTvl > 0 ? activeTvl : totalTvl;
  const derivedFeeRatio = ratioTvl > 0 && fees24h.available
    ? fees24h.value / ratioTvl
    : null;
  const activity = classifyDiscoveryActivity({
    volume1h,
    fees1h,
    swaps1h,
    volume24h,
    fees24h,
    swaps24h,
    windowLabel: timeframe,
  });
  const volumeChangePct = readSignedMetric(p.volume_change_pct, p.volumeChangePct);
  const feeChangePct = readSignedMetric(p.fee_change_pct, p.feeChangePct);
  const swapCountChangePct = readSignedMetric(p.swap_count_change_pct, p.swapCountChangePct);
  const createdAtRaw = p.created_at ?? p.pool_created_at ?? p.token_x?.created_at ?? null;
  const createdAtNumeric = createdAtRaw === null || createdAtRaw === undefined || createdAtRaw === ''
    ? NaN
    : Number(createdAtRaw);
  const createdAtMs = Number.isFinite(createdAtNumeric)
    ? (createdAtNumeric < 10_000_000_000 ? createdAtNumeric * 1000 : createdAtNumeric)
    : (createdAtRaw ? Date.parse(createdAtRaw) : NaN);
  const poolAgeHours = Number.isFinite(createdAtMs)
    ? Math.max(0, (Date.now() - createdAtMs) / 3_600_000)
    : null;

  return {
    address:           p.pool_address || p.address || p.pool || '',
    name:              p.name || '',
    tokenXMint:        p.token_x?.address || p.base?.mint || '',
    tokenXSymbol:      p.token_x?.symbol  || p.base?.symbol || '',
    tokenYMint:        p.token_y?.address || p.quote?.mint  || '',
    tokenYSymbol:      p.token_y?.symbol  || p.quote?.symbol || '',
    quoteMint:         p.token_y?.address || p.quote?.mint || p.quoteMint || '',
    quoteSymbol:       p.token_y?.symbol || p.quote?.symbol || p.quoteSymbol || '',
    binStep,
    feePct:            Number(p.fee_pct || 0),
    feeTvlRatio1h:     feeRatio1h.available ? feeRatio1h.value : null,
    feeActiveTvlRatio: feeRatio24h.available ? feeRatio24h.value : derivedFeeRatio,
    activeTvl,
    // total_tvl: dipakai oleh dominance check — seluruh TVL pool (bukan hanya active bins)
    totalTvl,
    volume1h:          volume1h.available ? volume1h.value : null,
    volume24h:         volume24h.available ? volume24h.value : null,
    fees1h:            fees1h.available ? fees1h.value : null,
    fees24h:           fees24h.available ? fees24h.value : null,
    swapCount1h:       swaps1h.available ? swaps1h.value : null,
    swapCount24h:      swaps24h.available ? swaps24h.value : null,
    avgVolume:         readNonNegativeMetric(p.avg_volume, p.avgVolume).value,
    avgFee:            readNonNegativeMetric(p.avg_fee, p.avgFee).value,
    avgSwapCount:      readNonNegativeMetric(p.avg_swap_count, p.avgSwapCount).value,
    volumeChangePct,
    feeChangePct,
    swapCountChangePct,
    flowTrendScore:    getDiscoveryFlowTrendScore({ volumeChangePct, feeChangePct, swapCountChangePct }),
    activityState:     activity.state,
    activityWindow:    activity.window,
    activityReason:    activity.reason,
    activityEvidenceAvailable: activity.state !== 'UNKNOWN_ACTIVITY',
    discoveryTimeframe: normalizedTimeframe,
    mcap:              Number(p.token_x?.market_cap || p.mcap || 0),
    holders:           Number(p.base_token_holders || p.holders || 0),
    organicScore:      Number(p.token_x?.organic_score || p.organic_score || 0),
    tokenAgeHours:     poolAgeHours,
    poolAgeHours,
    createdAt:         Number.isFinite(createdAtMs) ? createdAtMs : null,
    price:             Number(p.current_price || p.pool_price || p.price || 0),
    priceChangePct:    Number(p.pool_price_change_pct || 0),
    priceTrend:        p.price_trend || null,
    DISCOVERY_SOURCE:  discoverySource,
    discoverySource,
    raw:               p,
  };
}

export function __compareDiscoveryPriorityForTests(a, b, opts = {}) {
  return compareDiscoveryPriority(a, b, opts);
}

export function __getDiscoveryActivityBiasScoreForTests(pool = {}) {
  return getDiscoveryActivityBiasScore(pool);
}

export function __getDiscoveryLivingFlowScoreForTests(pool = {}) {
  return getDiscoveryLivingFlowScore(pool);
}

export function __normalizeDiscoveryPoolForTests(pool = {}, discoverySource = 'TEST', timeframe = '24h') {
  return normalizePool(pool, discoverySource, timeframe);
}

export function __isObservedDryDiscoveryPoolForTests(pool = {}) {
  return isObservedDryDiscoveryPool(pool);
}

// ── Composite VETO runner ─────────────────────────────────────────
//
// Jalankan semua VETO secara sekuensial.
// Return pada VETO pertama yang ditemukan.

const _vetoCache = new Map();
const VETO_CACHE_TTL_MAX_MS = 60 * 1000;

/**
 * @param {{ mint: string, symbol: string, pool?: object }} token
 * @returns {Promise<{veto: boolean, reason: string, gate: string|null}>}
 */
export async function runMeridianVeto(token) {
  const { mint, symbol, pool } = token;
  const now = Date.now();

  if (_vetoCache.has(mint)) {
    const cached = _vetoCache.get(mint);
    if (now - cached.timestamp < VETO_CACHE_TTL_MAX_MS) {
      return cached.result;
    }
  }

  const setCacheAndReturn = (result) => {
    _vetoCache.set(mint, { timestamp: now, result });
    return result;
  };
  try {
    const cfg = getConfig();
    const diagnostics = {
      supertrend15m: 'UNKNOWN',
      athDistancePct: null,
      athGate: cfg.maxAthDistancePct > 0 ? 'UNKNOWN' : 'SKIPPED',
      pvpGate: 'UNKNOWN',
      dominanceGate: pool ? 'UNKNOWN' : 'SKIPPED',
      volumeGate: 'SKIPPED',
      quoteGate: pool ? 'UNKNOWN' : 'SKIPPED',
    };

    if (pool && !isSupportedQuoteToken(pool)) {
      const reason = buildUnsupportedQuoteReason(pool);
      diagnostics.quoteGate = 'FAIL';
      return setCacheAndReturn({ veto: true, reason, gate: 'UNSUPPORTED_QUOTE_TOKEN', diagnostics });
    }
    
    const currentPrice = pool ? Number(pool.price || pool.pool_price || pool.currentPrice || 0) : 0;

    // Gate 1: Supertrend 15m
    const st = await checkSupertrendVeto(mint, currentPrice);
    diagnostics.supertrend15m = st.veto ? 'BEARISH_OR_UNAVAILABLE' : 'BULLISH';
    if (st.veto) return setCacheAndReturn({ veto: true, reason: st.reason, gate: 'SUPERTREND_15M', diagnostics });

    // Gate 2: ATH Distance [TA_ATH_DANGER]
    if (cfg.maxAthDistancePct > 0) {
      const ath = await checkAthDistanceVeto(mint);
      diagnostics.athDistancePct = Number.isFinite(ath?.priceVsAthPct) ? ath.priceVsAthPct : null;
      diagnostics.athGate = ath.veto ? 'FAIL' : 'PASS';
      if (ath.veto) return setCacheAndReturn({ veto: true, reason: ath.reason, gate: 'TA_ATH_DANGER', diagnostics });
    }

    // Gate 3: PVP Guard (rival token)
    const pvp = await checkPvpGuardVeto(mint, symbol);
    diagnostics.pvpGate = pvp.veto ? 'FAIL' : 'PASS';
    if (pvp.veto) return setCacheAndReturn({ veto: true, reason: pvp.reason, gate: 'PVP_GUARD', diagnostics });

    // Volume Range Gate
    if (pool) {
      const vol = Number(pool.volume24h || pool.volume_24h || pool.trade_volume_24h || pool.tradeVolume24h || pool.volume || pool.v24h || 0);
      const minVol = Number(cfg.minVolume) || 0;
      const maxVol = Number(cfg.maxVolume) || 0;
      if (minVol > 0 && vol < minVol) {
        diagnostics.volumeGate = 'FAIL';
        return setCacheAndReturn({ veto: true, reason: `🚫 VETO: Volume $${Math.round(vol).toLocaleString()} di bawah minimal $${Math.round(minVol).toLocaleString()}`, gate: 'LOW_VOLUME', diagnostics });
      }
      if (maxVol > 0 && vol > maxVol) {
        diagnostics.volumeGate = 'FAIL';
        return setCacheAndReturn({ veto: true, reason: `🚫 VETO: Volume $${Math.round(vol).toLocaleString()} melebihi maksimal $${Math.round(maxVol).toLocaleString()}`, gate: 'HIGH_VOLUME', diagnostics });
      }
      diagnostics.volumeGate = 'PASS';
    }

    // Gate 4: Dominance Check [LOW_DOMINANCE]
    // Dijalankan hanya jika pool object tersedia (berisi activeTvl)
    if (pool) {
      const poolTvl  = Number(pool.activeTvl || pool.totalTvl || 0);
      const poolAddr = pool.address || '';
      const dom = await checkDominanceVeto(mint, poolTvl, poolAddr);
      diagnostics.dominanceGate = dom.veto ? 'FAIL' : 'PASS';
      if (dom.veto) return setCacheAndReturn({ veto: true, reason: dom.reason, gate: 'LOW_DOMINANCE', diagnostics });
    }

    return setCacheAndReturn({ veto: false, reason: 'All Meridian gates PASS', gate: null, diagnostics });
  } catch (e) {
    console.warn(`[meridianVeto] unexpected error ${mint.slice(0,8)}: ${e.message} — FAIL_CLOSED`);
    return setCacheAndReturn({
      veto: true,
      reason: `[FAIL_CLOSED] Meridian Veto error: ${e.message}`,
      gate: 'MERIDIAN_ERROR',
      diagnostics: {
        supertrend15m: 'UNKNOWN',
        athDistancePct: null,
        athGate: 'UNKNOWN',
        pvpGate: 'UNKNOWN',
        dominanceGate: 'UNKNOWN',
        volumeGate: 'UNKNOWN',
      },
    });
  }
}
