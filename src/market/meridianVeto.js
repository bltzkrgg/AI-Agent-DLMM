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
import { fetchWithTimeout }     from '../utils/safeJson.js';

const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag';
const DLMM_API_BASE       = 'https://dlmm.datapi.meteora.ag';
const DATAPI_JUP          = 'https://datapi.jup.ag/v1';
const PVP_MIN_ACTIVE_TVL  = 5_000;
const PVP_MIN_HOLDERS     = 500;
const PVP_MIN_GLOBAL_FEES = 30;   // SOL
const DOMINANCE_MIN_PCT   = 15;   // Pool kita harus ≥ 15% dari total likuiditas token

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
// Jika API gagal (timeout/error), PASS (fail-open — jangan blokir karena API down).

/**
 * @param {string} mint  - Token mint address
 * @returns {Promise<{veto: boolean, reason: string, direction?: string}>}
 */
export async function checkSupertrendVeto(mint) {
  try {
    const base = getMeridianBase();
    const headers = getMeridianHeaders();
    const params = new URLSearchParams({ interval: '15_MINUTE', candles: '10' });
    const url = `${base}/chart-indicators/${mint}?${params.toString()}`;
    const res = await fetchWithTimeout(url, { headers }, 8000);

    if (!res.ok) return { veto: true, reason: `API ${res.status} down — Safety Veto` };

    const data = await res.json();
    const candles = data?.candles || [];
    if (candles.length === 0) return { veto: true, reason: 'No candle data' };

    const currentCandle = candles[0];
    const st = data?.latest?.supertrend || {};
    const direction = String(st.direction || 'unknown').toLowerCase();
    
    // Logika Konfirmasi
    const isGreenCandle = Number(currentCandle.close) > Number(currentCandle.open);
    const isAboveST = Number(currentCandle.close) > Number(st.value);
    
    // Logika Local ATH
    const previousHighs = candles.slice(1).map(c => Number(c.high));
    const localATH = Number(currentCandle.close) >= Math.max(...previousHighs);

    if (direction === 'bearish') return { veto: true, reason: 'Trend 15m BEARISH' };
    if (!isGreenCandle) return { veto: true, reason: 'Candle 15m MERAH (Haram Entry)' };

    const canEntry = isAboveST || localATH;
    if (!canEntry) return { veto: true, reason: 'Belum Break ST / Belum ATH' };

    const entryType = localATH ? 'ATH BREAKOUT 🚀' : 'ST BREAKOUT 🟢';
    return { veto: false, reason: `KONFIRMASI: Candle Hijau + ${entryType}` };
  } catch (e) {
    return { veto: true, reason: `Logic error: ${e.message}` };
  }
}

// ── 2. ATH Distance VETO ──────────────────────────────────────────
//
// Mengambil price_vs_ath_pct dari Meridian/OKX.
// Jika harga > (100 - maxAthDistancePct)% dari ATH → VETO.
// Contoh: maxAthDistancePct=15 → threshold=85 → VETO jika price > 85% ATH.
// Jika data tidak tersedia → PASS (fail-open).

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
      return { veto: false, reason: 'ATH data tidak tersedia — PASS', priceVsAthPct: null };
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
    console.warn(`[meridianVeto] ATH check error ${mint.slice(0,8)}: ${e.message} — PASS`);
    return { veto: false, reason: `ATH API error — skip veto`, priceVsAthPct: null };
  }
}

async function checkAthViaJupiter(mint, threshold) {
  try {
    const url = `${DATAPI_JUP}/assets/search?query=${encodeURIComponent(mint)}`;
    const res = await fetchWithTimeout(url, {}, 6000);
    if (!res.ok) return { veto: false, reason: 'Jupiter ATH unavailable — PASS' };

    const data          = await res.json();
    const asset         = Array.isArray(data) ? data[0] : data;
    const priceVsAthPct = Number(asset?.priceVsAth ?? asset?.price_vs_ath_pct ?? null);

    if (!Number.isFinite(priceVsAthPct)) {
      return { veto: false, reason: 'ATH data tidak tersedia — PASS', priceVsAthPct: null };
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
    return { veto: false, reason: 'ATH Jupiter error — PASS', priceVsAthPct: null };
  }
}

// ── NEW: Dominance Check (PVP Risk) ───────────────────────────────────────────────
//
// Cek apakah pool yang kita pilih memiliki dominasi likuiditas yang cukup.
// Jika activeTvl pool kita < DOMINANCE_MIN_PCT% dari total likuiditas token
// di seluruh jaringan → VETO [LOW_DOMINANCE].
// Sumber data: Meteora DLMM API (semua pool token tersebut, sort by tvl:desc).
// Fail-open jika API error atau data tidak tersedia.

/**
 * @param {string} mint        - Token mint (base token)
 * @param {number} poolTvl     - TVL aktif pool yang kita pilih (USD)
 * @param {string} [poolAddr]  - Alamat pool kita (untuk exclude dari total jika perlu)
 * @returns {Promise<{veto: boolean, reason: string, dominancePct?: number}>}
 */
export async function checkDominanceVeto(mint, poolTvl, poolAddr) {
  const minDomPct = DOMINANCE_MIN_PCT; // 15%

  // Jika pool kita tidak punya TVL data — skip (fail-open)
  if (!mint || !Number.isFinite(poolTvl) || poolTvl <= 0) {
    return { veto: false, reason: 'TVL data pool tidak tersedia — skip dominance check' };
  }

  try {
    // Ambil semua pool DLMM untuk token ini, sorted by TVL DESC
    const url = `${DLMM_API_BASE}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent('tvl:desc')}&page_size=20`;
    const res = await fetchWithTimeout(url, {}, 8000);

    if (!res.ok) {
      console.warn(`[meridianVeto] Dominance API ${res.status} untuk ${mint.slice(0,8)} — PASS`);
      return { veto: false, reason: `Dominance API ${res.status} — skip check` };
    }

    const data  = await res.json();
    const pools = Array.isArray(data?.data) ? data.data : [];

    if (pools.length === 0) {
      return { veto: false, reason: 'Tidak ada pool lain ditemukan — dominance ok' };
    }

    // Hitung total TVL semua pool yang mengandung token ini
    const totalNetworkTvl = pools.reduce((sum, p) => {
      const tvl = Number(p.tvl || p.active_tvl || 0);
      return sum + (Number.isFinite(tvl) ? tvl : 0);
    }, 0);

    if (totalNetworkTvl <= 0) {
      return { veto: false, reason: 'Total network TVL nol — skip dominance check' };
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
    console.warn(`[meridianVeto] Dominance check error ${mint.slice(0,8)}: ${e.message} — PASS`);
    return { veto: false, reason: `Dominance error — skip veto` };
  }
}

// ── 3. PVP Guard ──────────────────────────────────────────────────
//
// Cek apakah ada token rival dengan simbol sama yang punya:
//   - holders > 500 AND total fees > 30 SOL AND TVL aktif > $5000
// Jika rival dominan ditemukan → VETO (pasar terpecah, LP kita tidak dominan).
// Fail-open jika API error.

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
    if (!searchRes.ok) return { veto: false, reason: `PVP search ${searchRes.status} — PASS` };

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
        if (!poolRes.ok) continue;

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
      } catch {
        continue;
      }
    }

    return { veto: false, reason: 'Rival ada tapi tidak punya pool dominan — PASS' };

  } catch (e) {
    console.warn(`[meridianVeto] PVP check error ${mint.slice(0,8)}: ${e.message} — PASS`);
    return { veto: false, reason: `PVP error — skip veto` };
  }
}

// ── 4. Pool Discovery via Meridian API ───────────────────────────
//
// Mengambil daftar pool dari Meridian Server Discovery (jika publicApiKey ada)
// atau langsung dari Meteora Pool Discovery API sebagai fallback.
// Filter: binStep sesuai binStepPriority, sorted by fee_active_tvl_ratio DESC.

/**
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array>} - Array pool objects sorted by fee/tvl ratio
 */
export async function discoverHighFeePoolsMeridian({ limit = 50 } = {}) {
  const cfg    = getConfig();
  const apiKey = cfg.publicApiKey;
  const base   = getMeridianBase();

  const binStepPriority    = Array.isArray(cfg.binStepPriority) ? cfg.binStepPriority.map(Number) : [200, 125, 100];
  const minFeeRatio        = Number(cfg.minFeeActiveTvlRatio) || 0.002;
  const minMcap            = cfg.minMcap !== undefined ? Number(cfg.minMcap) : 250000;
  const maxMcap            = Number(cfg.maxMcapUsd || cfg.maxMcap) || 0;
  const minTvl             = Number(cfg.minTvl) || 0;
  const maxTvl             = Number(cfg.maxTvl) || 0;
  const timeframe          = cfg.discoveryTimeframe || '1h';
  const category           = cfg.discoveryCategory || '';

  // Build filter string (Meteora format)
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
  if (maxTvl  > 0) filterParts.push(`tvl<=${maxTvl}`);

  const filterStr = filterParts.join('&&');

  let rawPools = [];

  try {
    // Tier 1: Meridian Server Discovery (authenticated, lebih fresh)
    if (apiKey) {
      const url  = `${base}/discovery/pools?page_size=${limit}&filter_by=${encodeURIComponent(filterStr)}&timeframe=${timeframe}&category=${category}`;
      const res  = await fetchWithTimeout(url, { headers: getMeridianHeaders() }, 10000);
      if (res.ok) {
        const data = await res.json();
        rawPools   = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
        console.log(`[meridianVeto] Meridian Discovery: ${rawPools.length} pools`);
      } else {
        console.warn(`[meridianVeto] Meridian Discovery ${res.status} — fallback ke Meteora`);
      }
    }
  } catch (e) {
    console.warn(`[meridianVeto] Meridian Discovery error: ${e.message} — fallback ke Meteora`);
  }

  // Tier 2: Meteora Pool Discovery API langsung
  if (rawPools.length === 0) {
    try {
      const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${limit}&filter_by=${encodeURIComponent(filterStr)}&timeframe=${timeframe}&category=${category}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      if (res.ok) {
        const data = await res.json();
        rawPools   = Array.isArray(data.data) ? data.data : [];
        console.log(`[meridianVeto] Meteora Discovery fallback: ${rawPools.length} pools`);
      }
    } catch (e) {
      console.warn(`[meridianVeto] Meteora Discovery error: ${e.message}`);
    }
  }

  if (rawPools.length === 0) return [];

  // Normalize, filter, dan sort by fee/tvl ratio + binStep priority
  const normalized = rawPools
    .map(p => normalizePool(p))
    .filter(p => {
      // Hanya pool dengan binStep yang ada di priority list
      return binStepPriority.includes(p.binStep);
    })
    .sort((a, b) => {
      // Priority sort: pertama urutkan binStep (200 > 125 > 100), lalu fee ratio
      const aPrio = binStepPriority.indexOf(a.binStep);
      const bPrio = binStepPriority.indexOf(b.binStep);
      if (aPrio !== bPrio) return aPrio - bPrio; // lower index = higher priority
      return (b.feeActiveTvlRatio || 0) - (a.feeActiveTvlRatio || 0);
    })
    .slice(0, limit);

  return normalized;
}

// ── Pool normalizer ───────────────────────────────────────────────

function normalizePool(p) {
  const binStep = Number(p.dlmm_params?.bin_step || p.bin_step || p.binStep || 0);
  const feeTvl  = Number(p.fee_active_tvl_ratio || 0) ||
    (Number(p.active_tvl) > 0 ? (Number(p.fee || 0) / Number(p.active_tvl)) * 100 : 0);

  return {
    address:           p.pool_address || p.address || p.pool || '',
    name:              p.name || '',
    tokenXMint:        p.token_x?.address || p.base?.mint || '',
    tokenXSymbol:      p.token_x?.symbol  || p.base?.symbol || '',
    tokenYMint:        p.token_y?.address || p.quote?.mint  || '',
    tokenYSymbol:      p.token_y?.symbol  || p.quote?.symbol || 'SOL',
    binStep,
    feePct:            Number(p.fee_pct || 0),
    feeActiveTvlRatio: parseFloat(feeTvl.toFixed(6)),
    activeTvl:         Number(p.active_tvl || 0),
    // total_tvl: dipakai oleh dominance check — seluruh TVL pool (bukan hanya active bins)
    totalTvl:          Number(p.tvl || p.total_tvl || p.active_tvl || 0),
    volume24h:         Number(p.volume || p.volume24h || 0),
    mcap:              Number(p.token_x?.market_cap || p.mcap || 0),
    holders:           Number(p.base_token_holders || p.holders || 0),
    organicScore:      Number(p.token_x?.organic_score || p.organic_score || 0),
    tokenAgeHours:     p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    price:             Number(p.pool_price || p.price || 0),
    priceChangePct:    Number(p.pool_price_change_pct || 0),
    priceTrend:        p.price_trend || null,
    raw:               p,
  };
}

// ── Composite VETO runner ─────────────────────────────────────────
//
// Jalankan semua VETO secara sekuensial.
// Return pada VETO pertama yang ditemukan.

/**
 * @param {{ mint: string, symbol: string, pool?: object }} token
 * @returns {Promise<{veto: boolean, reason: string, gate: string|null}>}
 */
export async function runMeridianVeto(token) {
  const { mint, symbol, pool } = token;
  const cfg = getConfig();

  // Gate 1: Supertrend 15m
  const st = await checkSupertrendVeto(mint);
  if (st.veto) return { veto: true, reason: st.reason, gate: 'SUPERTREND_15M' };

  // Gate 2: ATH Distance [TA_ATH_DANGER]
  if (cfg.maxAthDistancePct > 0) {
    const ath = await checkAthDistanceVeto(mint);
    if (ath.veto) return { veto: true, reason: ath.reason, gate: 'TA_ATH_DANGER' };
  }

  // Gate 3: PVP Guard (rival token)
  const pvp = await checkPvpGuardVeto(mint, symbol);
  if (pvp.veto) return { veto: true, reason: pvp.reason, gate: 'PVP_GUARD' };

  // Volume Range Gate
  if (pool) {
    const vol = Number(pool.volume || pool.volume24h || pool.v24h || pool.trade_volume_24h || 0);
    const minVol = Number(cfg.minVolume) || 0;
    const maxVol = Number(cfg.maxVolume) || 0;
    if (minVol > 0 && vol < minVol) {
      return { veto: true, reason: `🚫 VETO: Volume $${Math.round(vol).toLocaleString()} di bawah minimal $${Math.round(minVol).toLocaleString()}`, gate: 'LOW_VOLUME' };
    }
    if (maxVol > 0 && vol > maxVol) {
      return { veto: true, reason: `🚫 VETO: Volume $${Math.round(vol).toLocaleString()} melebihi maksimal $${Math.round(maxVol).toLocaleString()}`, gate: 'HIGH_VOLUME' };
    }
  }

  // Gate 4: Dominance Check [LOW_DOMINANCE]
  // Dijalankan hanya jika pool object tersedia (berisi activeTvl)
  if (pool) {
    const poolTvl  = Number(pool.activeTvl || pool.totalTvl || 0);
    const poolAddr = pool.address || '';
    const dom = await checkDominanceVeto(mint, poolTvl, poolAddr);
    if (dom.veto) return { veto: true, reason: dom.reason, gate: 'LOW_DOMINANCE' };
  }

  return { veto: false, reason: 'All Meridian gates PASS', gate: null };
}
