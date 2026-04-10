import { fetchWithTimeout } from './safeJson.js';

const METEORA_DLMM_API = 'https://dlmm-api.meteora.ag';

/**
 * LP Poacher — Melacak Smart Money di Meteora DLMM
 * Menggunakan API top_lpers untuk menganalisa behavior Whale.
 */
export async function getPoolSmartMoney(poolAddress) {
  try {
    const url = `${METEORA_DLMM_API}/position/top_lpers?pool=${poolAddress}&limit=10`;
    const res = await fetchWithTimeout(url, {}, 8000);
    
    if (!res.ok) return null;
    const lpers = await res.json();
    
    if (!Array.isArray(lpers) || lpers.length === 0) return null;

    // Filter LPer yang profitnya signifikan atau volume LP besar
    const smartLpers = lpers.filter(lp => lp.fee_claimed > 0 || lp.total_volume > 1000);
    
    // Hitung rata-rata efisiensi range mereka (jika tersedia)
    const avgEfficiency = smartLpers.reduce((s, lp) => s + (lp.fee_tvl_ratio || 0), 0) / (smartLpers.length || 1);
    
    // Whale Skew Analysis: Cek dominasi LPer terbesar
    // Kita bandingkan total_lp_usd LPer tertinggi dengan total liquidity pool (best-effort estimation)
    const topLpUsd = smartLpers.length > 0 ? Math.max(...smartLpers.map(lp => lp.total_lp_usd || 0)) : 0;
    
    // Konsensus & Trending
    const isTrending = smartLpers.length >= 3;

    return {
      smartLpCount: smartLpers.length,
      avgSmartEfficiency: avgEfficiency,
      topLpUsd,
      isTrending,
      updatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.warn(`[lpPoacher] Gagal fetch data LPer untuk pool ${poolAddress}:`, e.message);
    return null;
  }
}
