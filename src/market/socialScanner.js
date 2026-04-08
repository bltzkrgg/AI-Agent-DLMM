import { fetchWithTimeout } from '../utils/safeJson.js';
import { getConfig } from '../config.js';

const MERIDIAN_SIGNAL_API = 'https://api.agentmeridian.xyz/api/signals/discord/candidates';

/**
 * Social Scanner — Infiltrasi sinyal komunitas (Meridian-style)
 * Mengambil kandidat token yang sedang trending di Discord/KOL channels.
 */
export async function getSocialSignals() {
  const cfg = getConfig();
  if (!cfg.useSocialSignals) return [];

  try {
    const res = await fetchWithTimeout(MERIDIAN_SIGNAL_API, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AI-Agent-DLMM/1.0'
      }
    }, 8000);

    if (!res.ok) {
      console.warn(`⚠️ Social Scanner: API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    // Expected format from Meridian API: { signals: [{ mint: '...', intensity: 8.5, reason: '...' }] }
    return (data.signals || []).map(s => ({
      mint:      s.mint,
      intensity: s.intensity || 5,
      reason:    s.reason    || 'Direct social signal',
      source:    'meridian_social'
    }));
  } catch (err) {
    console.warn(`⚠️ Social Scanner error: ${err.message}`);
    return [];
  }
}

/**
 * Mendapatkan signal untuk token spesifik
 */
export async function getTokenSocialScore(tokenMint) {
  const all = await getSocialSignals();
  const match = all.find(s => s.mint === tokenMint);
  return match || null;
}
