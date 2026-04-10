/**
 * LP Agent API Integration
 * https://docs.lpagent.io
 *
 * Rate limit: 5 RPM (1 request per 12 seconds).
 * All calls are funneled through rateLimitedFetch() to stay compliant.
 *
 * Three integration points:
 *   1. discoverPools()       — pre-filtered pool list for Hunter
 *   2. getWalletPositions()  — PnL fallback for Healer (3rd tier after SDK + Meteora API)
 *   3. enrichPools()         — cross-reference candidate pools with LP Agent top list
 */

import { fetchWithTimeout } from '../utils/safeJson.js';
import { getConfig } from '../config.js';

const LP_AGENT_BASE = 'https://api.lpagent.io/open-api/v1';
const MIN_INTERVAL_MS = 13000; // conservative ~4.6 RPM (under 5 RPM limit)

// ─── Rate limiter (sequential, simple) ───────────────────────────

let _lastCallTs = 0;

async function rateLimitedFetch(path, params = {}) {
  const cfg = getConfig();
  let apiKey = process.env.LP_AGENT_API_KEY;
  let baseUrl = LP_AGENT_BASE;
  let useRelay = false;

  // Use Meridian Relay if enabled and no private key is present
  if (cfg.lpAgentRelayEnabled && (!apiKey || cfg.publicApiKey)) {
    apiKey = cfg.publicApiKey || 'bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz';
    baseUrl = cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api';
    useRelay = true;
  }

  if (!apiKey) return null; // API key not configured — skip silently

  const now  = Date.now();
  const wait = Math.max(0, _lastCallTs + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTs = Date.now();

  try {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString();
    const url = `${baseUrl}${path}${query ? '?' + query : ''}`;

    const res = await fetchWithTimeout(url, {
      headers: { 
        [useRelay ? 'Authorization' : 'x-api-key']: (useRelay ? `Bearer ${apiKey}` : apiKey),
        'Content-Type': 'application/json' 
      },
    }, 12000);

    if (!res.ok) {
      console.warn(`[lpAgent] ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[lpAgent] ${path} error: ${e.message}`);
    return null;
  }
}

// ─── Pool Discovery Cache ─────────────────────────────────────────
// Refreshed once per Hunter cycle. Used for enrichPools() with zero extra calls.

let _poolCache = { pools: [], ts: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit

function isCacheStale() {
  return Date.now() - _poolCache.ts > CACHE_TTL_MS;
}

// ─── 1. Pool Discovery ────────────────────────────────────────────
// Panggil sekali per Hunter cycle. Return top pools sorted by fee/TVL ratio.
// Pools di-merge dengan DexScreener results di screen_pools tool.

export async function discoverPools({
  pageSize          = 50,
  sortBy            = 'fee_tvl_ratio',
  sortOrder         = 'desc',
  vol24hMin         = null,   // null = pakai nilai dari config
  organicScoreMin   = null,
  binStepMin        = 1,
  binStepMax        = 250,
  feeTVLInterval    = '1h',
} = {}) {
  const data = await rateLimitedFetch('/pools/discover', {
    type:               'meteora',
    pageSize,
    sortBy,
    sortOrder,
    vol_24h_min:        vol24hMin,
    organic_score_min:  organicScoreMin,
    bin_step_min:       binStepMin,
    bin_step_max:       binStepMax,
    feeTVLInterval,
  });

  if (!data) return [];

  const rows = Array.isArray(data) ? data
    : (data.data ?? data.pools ?? data.results ?? []);

  const pools = rows.map(p => ({
    address:       p.address       ?? p.poolAddress ?? p.pool_address ?? '',
    name:          p.name          ?? p.pairName    ?? '',
    tvl:           parseFloat(p.tvl         ?? p.liquidity ?? 0),
    vol24h:        parseFloat(p.vol_24h     ?? p.volume24h  ?? 0),
    feeTVLRatio:   parseFloat(p.fee_tvl_ratio ?? p.feeTVLRatio ?? 0),
    organicScore:  parseFloat(p.organic_score ?? p.organicScore ?? 0),
    binStep:       parseInt(p.bin_step   ?? p.binStep ?? 0, 10),
    baseFee:       parseFloat(p.base_fee  ?? p.baseFee ?? 0),
    tokenX:        p.tokenX?.address ?? p.token_x ?? '',
    tokenY:        p.tokenY?.address ?? p.token_y ?? '',
    tokenXSymbol:  p.tokenX?.symbol  ?? p.token_x_symbol ?? '',
    tokenYSymbol:  p.tokenY?.symbol  ?? p.token_y_symbol ?? '',
  })).filter(p => p.address);

  // Update cache
  if (pools.length > 0) {
    _poolCache = { pools, ts: Date.now() };
  }

  return pools;
}

// ─── 2. Wallet Positions (PnL Fallback) ──────────────────────────
// Dipanggil di meteora.js hanya saat SDK + Meteora API keduanya gagal.
// Return format mirip getPositionInfo() — compatible dengan Healer.

export async function getWalletPositions(ownerAddress) {
  if (!ownerAddress) return null;

  const data = await rateLimitedFetch('/lp-positions/opening', {
    owner: ownerAddress,
  });

  if (!data) return null;

  const rows = Array.isArray(data) ? data
    : (data.data ?? data.positions ?? data.userPositions ?? []);

  if (!rows.length) return [];

  return rows.map(p => {
    const curVal    = parseFloat(p.currentValue    ?? p.current_value   ?? 0);
    const inputVal  = parseFloat(p.inputValue      ?? p.input_value     ?? 0);
    const feeCollected   = parseFloat(p.collectedFees   ?? p.collected_fees  ?? 0);
    const feeUncollected = parseFloat(p.uncollectedFees ?? p.uncollected_fees ?? 0);
    const pnlPct    = parseFloat(p.pnlPercentage   ?? p.pnl_percentage  ?? p.pnl_pct ?? 0);

    return {
      address:         p.tokenId     ?? p.positionId  ?? p.address ?? '',
      currentValueSol: curVal,        // LP Agent mungkin return USD — flag di bawah
      feeCollectedSol: feeCollected + feeUncollected,
      pnlPct,
      apr:             parseFloat(p.apr ?? 0),
      dpr:             parseFloat(p.dpr ?? 0),
      inRange:         p.inRange      ?? p.is_in_range ?? true,
      lowerBinId:      p.lowerTick   ?? p.lower_bin_id ?? 0,
      upperBinId:      p.upperTick   ?? p.upper_bin_id ?? 0,
      fromLPAgent:     true,
      pnlSource:       'lp_agent',
      // NOTE: unit currentValueSol mungkin USD bukan SOL — Healer harus
      // gunakan pnlPct langsung jika fromLPAgent=true daripada recalc dari value
    };
  });
}

// ─── 3. Pool Enrichment ───────────────────────────────────────────
// Dipakai di screen_pools untuk cross-reference candidate pools.
// Menggunakan cache dari discoverPools() — zero extra API calls.
// Return map: poolAddress → { organicScore, feeTVLRatio, inLPAgentList }
export async function enrichPools(addresses) {
  const map = {};
  if (!_poolCache.pools.length || isCacheStale()) {
    return map;
  }

  const cacheMap = new Map(_poolCache.pools.map(p => [p.address, p]));
  
  for (const addr of addresses) {
    const cached = cacheMap.get(addr);
    map[addr] = {
      inLPAgentList: !!cached,
      organicScore:  cached?.organicScore  ?? 0,
      feeTVLRatioLP: cached?.feeTVLRatio   ?? 0,
      vol24hLP:      cached?.vol24h        ?? 0,
    };
  }
  return map;
}

// ─── 4. Smart Wallet Tracking (Meridian-style) ────────────────────
// Mengambil daftar "Top LPers" (Top 5 berdasarkan fee earned / efficiency)
// untuk pool tertentu agar Healer bisa meniru range mereka.

export async function getTopLPers(poolAddress) {
  if (!poolAddress) return [];

  const data = await rateLimitedFetch('/pools/top-lpers', {
    pool: poolAddress,
    limit: 5,
    sortBy: 'efficiency'
  });

  if (!data) return [];

  const rows = Array.isArray(data) ? data : (data.data || []);
  return rows.map(r => ({
    owner:     r.owner,
    label:     r.label || 'Smart LP',
    efficiency: parseFloat(r.efficiency || 0),
    pnlUsd:    parseFloat(r.pnl_usd || 0),
    lowerTick: r.lower_tick,
    upperTick: r.upper_tick,
    inRange:   r.is_in_range
  }));
}

// ─── 5. Social & Trending Awareness ──────────────────────────────
// Integrasi dengan Meridian Social Signal API atau LP Agent Trending.

export async function getSocialTrending(limit = 10) {
  // LP Agent: Trending pools based on inflow / swap frequency
  const data = await rateLimitedFetch('/pools/trending', { limit });
  if (!data) return [];
  
  const rows = Array.isArray(data) ? data : (data.data || []);
  return rows.map(p => ({
    address: p.address,
    symbol:  p.symbol,
    intensity: p.trend_score || p.velocity || 0,
    reason:   `LP Agent Trending (${p.reason || 'Volume Spike'})`
  }));
}

// ─── 6. Master Intelligence Layer ────────────────────────────────
// Mengintegrasikan banyak sinyal ke dalam satu "Smart Money" digest.

export async function getPoolSmartMoney(poolAddress) {
  const [topLP, trending] = await Promise.all([
    getTopLPers(poolAddress),
    getSocialTrending(20)
  ]);

  const socialMatch = trending.find(t => t.address === poolAddress);

  return {
    smartLpCount: topLP.filter(lp => lp.efficiency > 0.8 && lp.inRange).length,
    avgSmartEfficiency: topLP.length ? topLP.reduce((s, l) => s + l.efficiency, 0) / topLP.length : 0,
    isTrending: !!socialMatch,
    socialIntensity: socialMatch?.intensity || 0,
    consensusRange: topLP.length > 0 ? {
      lower: Math.min(...topLP.map(lp => lp.lowerTick)),
      upper: Math.max(...topLP.map(lp => lp.upperTick))
    } : null
  };
}

// ─── Utility: cek apakah LP Agent aktif ──────────────────────────
export function isLPAgentEnabled() {
  const cfg = getConfig();
  return !!(process.env.LP_AGENT_API_KEY || cfg.lpAgentRelayEnabled);
}
