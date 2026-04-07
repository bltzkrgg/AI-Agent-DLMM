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

const LP_AGENT_BASE = 'https://api.lpagent.io/open-api/v1';
const MIN_INTERVAL_MS = 13000; // conservative ~4.6 RPM (under 5 RPM limit)

// ─── Rate limiter (sequential, simple) ───────────────────────────

let _lastCallTs = 0;

async function rateLimitedFetch(path, params = {}) {
  const apiKey = process.env.LP_AGENT_API_KEY;
  if (!apiKey) return null; // API key not configured — skip silently

  const now  = Date.now();
  const wait = Math.max(0, _lastCallTs + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTs = Date.now();

  try {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString();
    const url = `${LP_AGENT_BASE}${path}${query ? '?' + query : ''}`;

    const res = await fetchWithTimeout(url, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
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

export async function enrichPools(poolAddresses = []) {
  // Refresh cache jika stale — 1 API call
  if (isCacheStale()) {
    await discoverPools({ pageSize: 100 });
  }

  const map = {};
  for (const addr of poolAddresses) {
    const found = _poolCache.pools.find(p => p.address === addr);
    map[addr] = found
      ? {
          inLPAgentList:    true,
          organicScore:     found.organicScore,
          feeTVLRatioLP:    found.feeTVLRatio,
          vol24hLP:         found.vol24h,
          lpAgentName:      found.name,
        }
      : { inLPAgentList: false };
  }
  return map;
}

// ─── Utility: cek apakah LP Agent aktif ──────────────────────────
export function isLPAgentEnabled() {
  return !!process.env.LP_AGENT_API_KEY;
}
