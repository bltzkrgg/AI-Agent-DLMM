/**
 * src/utils/relayFetch.js — LP Agent Relay Fetch Wrapper
 *
 * Jika config.lpAgentRelayEnabled === true, semua request Jupiter/Meteora
 * dikirim melalui Meridian LP Agent Relay untuk bypass ISP blocking.
 *
 * Request Flow (Relay ON):
 *   GET  /swap/v2/quote?...  →  POST relay/proxy {url, method, headers, body}
 *   POST /swap/v2/swap       →  POST relay/proxy {url, method, headers, body}
 *
 * Request Flow (Relay OFF):
 *   Langsung ke endpoint Jupiter V2 dengan User-Agent uniform.
 *
 * Exponential Backoff:
 *   Retry otomatis: 3x dengan base delay 1000ms (max 8000ms)
 *
 * Headers:
 *   JUPITER_UA disertakan secara default di semua request agar konsisten
 *   dan menghindari blokir di level header dari CDN Jupiter.
 */

import { getConfig }        from '../config.js';
import { fetchWithTimeout } from './safeJson.js';

const MAX_RETRIES  = 3;
const BASE_DELAY   = 1000;   // ms
const MAX_DELAY    = 8000;   // ms
const TIMEOUT_MS   = 12000;  // per attempt

// User-Agent uniform — sama dengan yang dipakai coinfilter.js
// Konsisten di semua modul → menghindari blokir level CDN
export const JUPITER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Default headers yang selalu disertakan ke setiap Jupiter request
const JUPITER_DEFAULT_HEADERS = {
  'User-Agent':      JUPITER_UA,
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
};

// ── Exponential backoff helper ─────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function computeDelay(attempt) {
  const jitter = Math.random() * 200;
  return Math.min(BASE_DELAY * 2 ** attempt + jitter, MAX_DELAY);
}

// ── relayFetch ─────────────────────────────────────────────────────
// Drop-in replacement untuk fetchWithTimeout saat relay aktif.
// Signature: relayFetch(url, options, timeoutMs)
//
// Selalu menyertakan JUPITER_DEFAULT_HEADERS pada:
//   - Mode langsung: di request ke Jupiter
//   - Mode relay: di dalam relayBody.headers yang diteruskan proxy

export async function relayFetch(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const cfg      = getConfig();
  const useRelay = cfg.lpAgentRelayEnabled === true;
  const apiBase  = cfg.agentMeridianApiUrl || 'https://api.agentmeridian.xyz/api';
  const apiKey   = cfg.publicApiKey || '';

  // Gabung caller headers dengan default Jupiter headers
  // Caller dapat override (misalnya x-api-key untuk authenticated endpoints)
  const mergedHeaders = {
    ...JUPITER_DEFAULT_HEADERS,
    ...(options.headers || {}),
  };

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = computeDelay(attempt - 1);
        console.log(`[relayFetch] Retry ${attempt}/${MAX_RETRIES - 1} dalam ${Math.round(delay)}ms...`);
        await sleep(delay);
      }

      if (!useRelay) {
        // ── Mode Langsung: pass-through ke Jupiter dengan UA uniform ──
        return await fetchWithTimeout(url, {
          ...options,
          headers: mergedHeaders,
        }, timeoutMs);
      }

      // ── Mode Relay: kirim ke Meridian proxy ──────────────────────
      // Teruskan mergedHeaders ke dalam relayBody agar proxy server
      // meneruskan UA yang benar ke Jupiter endpoint
      const relayUrl  = `${apiBase}/relay/proxy`;
      const relayBody = {
        url,
        method:  options.method || 'GET',
        headers: mergedHeaders,             // ← UA uniform ke proxy
        body:    options.body   || null,
      };

      const relayOpts = {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    apiKey,           // ← auth ke Meridian relay
          'Accept':       'application/json',
        },
        body: JSON.stringify(relayBody),
      };

      const res = await fetchWithTimeout(relayUrl, relayOpts, timeoutMs);

      // Relay membungkus response asli — unwrap jika perlu
      if (!res.ok) {
        const errText = await res.text().catch(() => res.status);
        throw new Error(`[relay] HTTP ${res.status}: ${errText}`);
      }

      // Tangani relay wrapper {status, body} atau direct JSON response
      const contentType = res.headers?.get?.('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        if (json && typeof json.body !== 'undefined') {
          return new RelayResponse(json);          // relay wrapper format
        }
        return new RelayResponse({ status: res.status, body: json, _raw: true });
      }

      return res; // Binary / non-JSON: kembalikan as-is

    } catch (e) {
      lastError = e;
      // Jangan retry untuk error klien (4xx) — server sudah memberi jawaban pasti
      if (e.message?.includes('HTTP 4')) break;
      console.warn(`[relayFetch] Attempt ${attempt + 1} gagal: ${e.message}`);
    }
  }

  throw lastError || new Error('[relayFetch] Semua retry habis');
}

// ── RelayResponse ─────────────────────────────────────────────────
// Wrapper tipis agar relayFetch transparan seperti fetch() native.

class RelayResponse {
  constructor({ status = 200, body, _raw = false }) {
    this.status = status;
    this.ok     = status >= 200 && status < 300;
    this._body  = body;
    this._raw   = _raw;
  }

  async json() {
    return this._body;
  }

  async text() {
    return typeof this._body === 'string' ? this._body : JSON.stringify(this._body);
  }
}

// ── isRelayActive ─────────────────────────────────────────────────

export function isRelayActive() {
  return getConfig().lpAgentRelayEnabled === true;
}
