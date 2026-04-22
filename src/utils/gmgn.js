/**
 * GMGN API Utility — Token Security & Info Screener
 *
 * Endpoint auth (normal routes = token info, security):
 *   Header:     X-APIKEY: {GMGN_API_KEY}
 *   Query:      timestamp={unix_seconds}&client_id={uuid}
 *
 * "Trip Wire" Logic:
 *   → Returns null on any error (timeout, 401, rate limit, etc.)
 *   → Callers must treat null as "no evidence" = proceed
 *   → Only EXPLICIT bad values trigger rejections upstream
 */

import { randomUUID } from 'crypto';
import { setDefaultResultOrder } from 'dns';
import { fetchWithTimeout } from './safeJson.js';

const GMGN_HOST   = 'https://openapi.gmgn.ai';
const GMGN_CHAIN  = 'sol';
const GMGN_MAX_RPS = 2;
const GMGN_MIN_INTERVAL_MS = Math.ceil(1000 / GMGN_MAX_RPS);
const GMGN_CACHE_TTL_MS = 90_000;
const GMGN_DEFAULT_TIMEOUT_MS = 8000;
const GMGN_DEFAULT_MAX_RETRIES = 2;
const GMGN_DEFAULT_REQUEST_DELAY_MS = GMGN_MIN_INTERVAL_MS;

let _gmgnLastRequestAt = 0;
let _gmgnQueue = Promise.resolve();
const _gmgnCache = new Map();
let _dnsIpv4Forced = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheKey(subPath, address) {
  return `${subPath}:${address || ''}`;
}

function getCached(subPath, address) {
  const key = cacheKey(subPath, address);
  const item = _gmgnCache.get(key);
  if (!item) return null;
  if ((Date.now() - item.ts) > GMGN_CACHE_TTL_MS) {
    _gmgnCache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(subPath, address, value) {
  const key = cacheKey(subPath, address);
  _gmgnCache.set(key, { ts: Date.now(), value });
}

function runSerialized(task) {
  const run = _gmgnQueue.then(task, task);
  _gmgnQueue = run.catch(() => {});
  return run;
}

function ensureIpv4First() {
  if (_dnsIpv4Forced) return;
  try {
    setDefaultResultOrder('ipv4first');
    _dnsIpv4Forced = true;
  } catch {
    // best-effort; continue without hard fail
  }
}

// ─── Auth query builder ──────────────────────────────────────────

function buildAuthParams() {
  return {
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: randomUUID(),
  };
}

function buildUrl(subPath, extraParams = {}) {
  const params = new URLSearchParams({
    chain: GMGN_CHAIN,
    ...extraParams,
    ...buildAuthParams(),
  });
  return `${GMGN_HOST}${subPath}?${params.toString()}`;
}

// ─── Core fetch wrapper ──────────────────────────────────────────

async function gmgnFetch(subPath, extraParams = {}) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    // No key configured — skip silently, don't block deployment
    return null;
  }

  ensureIpv4First();

  return runSerialized(async () => {
    const maxRetries = Number.isFinite(Number(process.env.GMGN_MAX_RETRIES))
      ? Math.max(0, Number(process.env.GMGN_MAX_RETRIES))
      : GMGN_DEFAULT_MAX_RETRIES;
    const timeoutMs = Number.isFinite(Number(process.env.GMGN_TIMEOUT_MS))
      ? Math.max(1000, Number(process.env.GMGN_TIMEOUT_MS))
      : GMGN_DEFAULT_TIMEOUT_MS;
    const requestDelayMs = Number.isFinite(Number(process.env.GMGN_REQUEST_DELAY_MS))
      ? Math.max(GMGN_MIN_INTERVAL_MS, Number(process.env.GMGN_REQUEST_DELAY_MS))
      : GMGN_DEFAULT_REQUEST_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const sinceLast = Date.now() - _gmgnLastRequestAt;
      const waitMs = Math.max(0, requestDelayMs - sinceLast);
      if (waitMs > 0) await sleep(waitMs);

      try {
        const url = buildUrl(subPath, extraParams);
        _gmgnLastRequestAt = Date.now();
        const res = await fetchWithTimeout(url, {
          headers: {
            'X-APIKEY': apiKey,
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'AI-Agent-DLMM/1.0',
          },
        }, timeoutMs);

        const raw = await res.text().catch(() => '');
        const openApiIpv6Error = /OpenAPI does not support IPv6/i.test(raw);
        if (openApiIpv6Error) {
          if (attempt < maxRetries) {
            const backoffMs = Math.min(10_000, 1_000 * Math.pow(2, attempt));
            await sleep(backoffMs);
            continue;
          }
          console.warn(`[gmgn] ${subPath} blocked by IPv6-only path after retries — skipping.`);
          return null;
        }
        let json = null;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            if (attempt < maxRetries) {
              const backoffMs = Math.min(6_000, 700 * Math.pow(2, attempt));
              await sleep(backoffMs);
              continue;
            }
            console.warn(`[gmgn] ${subPath} non-JSON response after retries — skipping.`);
            return null;
          }
        }

        if (res.status === 429) {
          if (attempt < maxRetries) {
            const retryAfterSec = Number(res.headers.get('retry-after'));
            const backoffMs = Number.isFinite(retryAfterSec)
              ? retryAfterSec * 1000
              : Math.min(15_000, 1_000 * Math.pow(2, attempt));
            await sleep(backoffMs);
            continue;
          }
          console.warn('[gmgn] Rate limited (429) after retries — skipping.');
          return null;
        }

        if (!res.ok) {
          const isRetryable = res.status >= 500 || res.status === 408;
          if (isRetryable && attempt < maxRetries) {
            const backoffMs = Math.min(10_000, 800 * Math.pow(2, attempt));
            await sleep(backoffMs);
            continue;
          }
          console.warn(`[gmgn] HTTP ${res.status} for ${subPath} — skipping.`);
          return null;
        }

        if (!json) {
          if (attempt < maxRetries) {
            await sleep(Math.min(5_000, 600 * Math.pow(2, attempt)));
            continue;
          }
          console.warn(`[gmgn] Non-JSON response for ${subPath} — skipping.`);
          return null;
        }

        if (json.code !== 0) {
          // Business error: do not spam retries for deterministic failures.
          console.warn(`[gmgn] API error code=${json.code} msg=${json.message || json.error || 'unknown'} path=${subPath}`);
          return null;
        }

        return json.data || null;
      } catch (e) {
        const retryable = /timeout|network|fetch|socket|econn|eai_again|terminated|enotfound|OpenAPI does not support IPv6/i.test(String(e?.message || ''));
        if (retryable && attempt < maxRetries) {
          const backoffMs = Math.min(10_000, 800 * Math.pow(2, attempt));
          await sleep(backoffMs);
          continue;
        }
        console.warn(`[gmgn] ${subPath} failed: ${e.message} — skipping (non-blocking).`);
        return null;
      }
    }
    return null;
  });
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Get GMGN token info (social links, CTO flag, dev info, holder stats).
 *
 * Key fields returned:
 *   link.twitter_username, link.website, link.telegram
 *   dev.cto_flag (1 = CTO coin)
 *   stat.top_10_holder_rate, stat.top_entrapment_trader_percentage
 *
 * Returns null if data unavailable — caller proceeds without GMGN screening.
 */
export async function getGmgnTokenInfo(mint) {
  if (!mint || typeof mint !== 'string') return null;
  const cached = getCached('/v1/token/info', mint);
  if (cached) return cached;
  const data = await gmgnFetch('/v1/token/info', { address: mint });
  if (data) setCached('/v1/token/info', mint, data);
  return data;
}

/**
 * Get GMGN token security metrics.
 *
 * Key fields:
 *   renounced_mint          (SOL) — false = NOT renounced (dangerous)
 *   renounced_freeze_account (SOL) — false = NOT renounced (dangerous)
 *   top_10_holder_rate      — ratio 0-1
 *   creator_balance_rate    — dev supply ratio 0-1
 *   rat_trader_amount_rate  — insider volume ratio 0-1
 *   suspected_insider_hold_rate — suspected insider hold ratio 0-1
 *   bundler_trader_amount_rate  — bundling ratio 0-1
 *   burn_status             — "burn" = burned, "" = not burned
 *   rug_ratio               — rug risk score 0-1
 *
 * Returns null if data unavailable — caller proceeds without GMGN screening.
 */
export async function getGmgnSecurity(mint) {
  if (!mint || typeof mint !== 'string') return null;
  const cached = getCached('/v1/token/security', mint);
  if (cached) return cached;
  const data = await gmgnFetch('/v1/token/security', { address: mint });
  if (data) setCached('/v1/token/security', mint, data);
  return data;
}
