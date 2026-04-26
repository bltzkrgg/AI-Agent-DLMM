/**
 * src/market/atrGuard.js — Volatility-Based Dynamic Stop Loss
 *
 * Mengambil ATR (Average True Range) dari Meridian chart-indicators API.
 * Jika ATR tinggi → perlebar stopLossPct secara otomatis agar tidak
 * terkena noise volatilitas normal.
 *
 * Formula:
 *   atrPct     = (ATR / currentPrice) * 100
 *   dynamicSL  = max(baseSl, atrPct * config.atrMultiplier)
 *   dynamicSL  = clamp(dynamicSL, baseSl, config.maxDynamicSl)
 *
 * Fail-open: jika API Meridian tidak tersedia, return baseSl (dari config).
 */

import { getConfig }        from '../config.js';
import { fetchWithTimeout } from '../utils/safeJson.js';

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 menit cache per mint
const _cache = new Map();             // mint → { atrPct, ts }

// ── fetchAtr ─────────────────────────────────────────────────────

async function fetchAtr(mint, interval = '15m') {
  const cfg     = getConfig();
  const apiBase = cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api';
  const apiKey  = cfg.publicApiKey || '';

  // Pakai endpoint yang sama dengan Smart Exit di evilPanda.js
  const params = new URLSearchParams({
    interval:     interval,
    rsiLength:    '2',
    atrLength:    '14',
    publicApiKey: apiKey,
  });

  const url = `${apiBase}/chart-indicators/${mint}?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
    }, 8000);

    if (!res.ok) return null;
    const data = await res.json();

    const atr   = data?.indicators?.atr   ?? data?.atr;
    const price = data?.indicators?.close ?? data?.close ?? data?.price;

    if (!atr || !price || price <= 0) return null;
    return (atr / price) * 100;   // ATR sebagai % dari harga
  } catch {
    return null;  // fail-open
  }
}

// ── getDynamicStopLoss ────────────────────────────────────────────
// Utama: panggil ini sebelum deployPosition untuk dapat SL yang akurat

export async function getDynamicStopLoss(mint, interval = '15m') {
  const cfg    = getConfig();
  const baseSl = Number(cfg.stopLossPct) || 10;

  // Jika feature dimatikan
  if (!cfg.atrGuardEnabled) return { stopLossPct: baseSl, source: 'config', atrPct: null };

  // Check cache
  const cached = _cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const atrPct      = await fetchAtr(mint, interval);
  const multiplier  = Number(cfg.atrMultiplier)  || 1.5;
  const maxDynamic  = Number(cfg.maxDynamicSl)   || 20;

  let stopLossPct;
  let source;

  if (atrPct === null) {
    stopLossPct = baseSl;
    source      = 'config_fallback';
  } else {
    const atrBased  = atrPct * multiplier;
    stopLossPct     = Math.min(maxDynamic, Math.max(baseSl, atrBased));
    stopLossPct     = Math.round(stopLossPct * 10) / 10; // 1 desimal
    source          = 'atr_dynamic';
  }

  const result = { stopLossPct, source, atrPct };
  _cache.set(mint, { result, ts: Date.now() });

  console.log(
    `[atrGuard] ${mint.slice(0,8)} — ATR: ${atrPct?.toFixed(2) ?? 'n/a'}% → ` +
    `SL: ${stopLossPct}% (${source})`
  );

  return result;
}

// ── formatAtrNote ────────────────────────────────────────────────
// Format singkat untuk Telegram notification

export function formatAtrNote(atrResult) {
  if (!atrResult) return '';
  const { stopLossPct, source, atrPct } = atrResult;
  if (source === 'config_fallback') return `SL: <code>${stopLossPct}%</code> (ATR N/A)`;
  return (
    `SL: <code>${stopLossPct}%</code> ` +
    `<i>(ATR ${atrPct?.toFixed(2)}% × ${getConfig().atrMultiplier || 1.5})</i>`
  );
}
