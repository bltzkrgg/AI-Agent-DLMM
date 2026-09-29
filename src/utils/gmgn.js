/**
 * GMGN API Utility — Token Security & Info Screener
 *
 * Endpoint auth (normal routes = token info, security):
 *   Header:     X-APIKEY: {GMGN_API_KEY}
 *   Query:      timestamp={unix_seconds}&client_id={uuid}
 *
 * "Trip Wire" Logic:
 *   → Existing screening callers return null on errors and stay non-blocking.
 *   → Token Alerts uses strict mode so source failures remain observable.
 *   → Only EXPLICIT bad values trigger rejections upstream.
 */

import { randomUUID } from 'crypto';
import { setDefaultResultOrder } from 'dns';
import { fetchWithTimeout } from './safeJson.js';

const GMGN_HOST   = 'https://openapi.gmgn.ai';
const GMGN_CHAIN  = 'sol';
const GMGN_MIN_INTERVAL_MS = 1400;
const GMGN_CACHE_TTL_MS = 90_000;
const GMGN_DEFAULT_TIMEOUT_MS = 8000;
const GMGN_DEFAULT_MAX_RETRIES = 2;
const GMGN_DEFAULT_REQUEST_DELAY_MS = GMGN_MIN_INTERVAL_MS;
const GMGN_RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
const GMGN_RATE_LIMIT_BUFFER_MS = 1000;

let _gmgnLastRequestAt = 0;
let _gmgnRateLimitedUntil = 0;
let _gmgnQueue = Promise.resolve();
const _gmgnCache = new Map();
let _dnsIpv4Forced = false;

export class GmgnApiError extends Error {
  constructor(code, message, { status = null, retryAt = null } = {}) {
    super(message);
    this.name = 'GmgnApiError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

function failGmgnRequest(strict, code, message, details) {
  if (strict) throw new GmgnApiError(code, message, details);
  return null;
}

function unwrapGmgnEnvelope(json, subPath, strict) {
  let envelope = json;

  for (let depth = 0; depth < 4; depth++) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return envelope ?? null;
    }

    if (Object.hasOwn(envelope, 'code') && Number(envelope.code) !== 0) {
      const apiCode = String(envelope.code).slice(0, 32);
      const apiMessage = envelope.message || envelope.error || envelope.reason || 'unknown';
      console.warn(`[gmgn] API error code=${apiCode} msg=${apiMessage} path=${subPath}`);
      return failGmgnRequest(
        strict,
        'GMGN_API_ERROR',
        `GMGN rejected the request (API code ${apiCode})`
      );
    }

    if (!Object.hasOwn(envelope, 'data')) {
      return envelope;
    }

    const data = envelope.data;
    const isNestedEnvelope = (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.hasOwn(data, 'code') &&
      Object.hasOwn(data, 'data')
    );
    if (!isNestedEnvelope) return data ?? null;
    envelope = data;
  }

  return failGmgnRequest(
    strict,
    'GMGN_RESPONSE_NESTING_INVALID',
    'GMGN response nesting exceeded the supported depth'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeResetAtMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function parseRetryAfterMs(value, nowMs) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findRateLimitPayload(json) {
  let payload = json;
  for (let depth = 0; depth < 4; depth++) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const error = String(payload.error || payload.reason || '').toUpperCase();
    if (Number(payload.code) === 429 || error.includes('RATE_LIMIT')) return payload;
    payload = payload.data;
  }
  return null;
}

function getRateLimitResetAtMs(res, payload, nowMs = Date.now()) {
  const candidates = [
    normalizeResetAtMs(res.headers.get('x-ratelimit-reset')),
    normalizeResetAtMs(payload?.reset_at),
    parseRetryAfterMs(res.headers.get('retry-after'), nowMs),
  ].filter((value) => Number.isFinite(value) && value > nowMs);
  const resetAt = candidates.length > 0
    ? Math.max(...candidates)
    : nowMs + GMGN_RATE_LIMIT_FALLBACK_MS;
  return resetAt + GMGN_RATE_LIMIT_BUFFER_MS;
}

function cacheKey(subPath, address, chain = GMGN_CHAIN) {
  return `${chain}:${subPath}:${address || ''}`;
}

function getCached(subPath, address, chain = GMGN_CHAIN) {
  const key = cacheKey(subPath, address, chain);
  const item = _gmgnCache.get(key);
  if (!item) return null;
  if ((Date.now() - item.ts) > GMGN_CACHE_TTL_MS) {
    _gmgnCache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(subPath, address, value, chain = GMGN_CHAIN) {
  const key = cacheKey(subPath, address, chain);
  _gmgnCache.set(key, { ts: Date.now(), value });
}

function runSerialized(task) {
  const run = _gmgnQueue.then(task, task);
  _gmgnQueue = run.catch(() => {});
  return run;
}

export function ensureIpv4First() {
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

function buildUrl(subPath, extraParams = {}, chain = GMGN_CHAIN) {
  const params = new URLSearchParams({
    chain,
    ...extraParams,
    ...buildAuthParams(),
  });
  return `${GMGN_HOST}${subPath}?${params.toString()}`;
}

// ─── Core fetch wrapper ──────────────────────────────────────────

async function gmgnFetch(subPath, extraParams = {}, { strict = false, chain = GMGN_CHAIN } = {}) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    return failGmgnRequest(
      strict,
      'GMGN_API_KEY_MISSING',
      'GMGN_API_KEY is not loaded in the running process'
    );
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

    if (Date.now() < _gmgnRateLimitedUntil) {
      const retryAt = new Date(_gmgnRateLimitedUntil).toISOString();
      return failGmgnRequest(
        strict,
        'GMGN_RATE_LIMITED',
        `GMGN rate limit cooldown active until ${retryAt}`,
        { status: 429, retryAt: _gmgnRateLimitedUntil }
      );
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const sinceLast = Date.now() - _gmgnLastRequestAt;
      const waitMs = Math.max(0, requestDelayMs - sinceLast);
      if (waitMs > 0) await sleep(waitMs);

      try {
        const url = buildUrl(subPath, extraParams, chain);
        _gmgnLastRequestAt = Date.now();
        const res = await fetchWithTimeout(url, {
          headers: {
            'X-APIKEY': apiKey,
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
          return failGmgnRequest(
            strict,
            'GMGN_IPV6_UNSUPPORTED',
            'GMGN rejected the current IPv6 network path'
          );
        }
        let json = null;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            if (res.status !== 429) {
              console.warn(`[gmgn] ${subPath} non-JSON response. Status: ${res.status}. Body: ${raw.slice(0, 150)}`);
              if (attempt < maxRetries) {
                const backoffMs = Math.min(6_000, 700 * Math.pow(2, attempt));
                await sleep(backoffMs);
                continue;
              }
              console.warn(`[gmgn] ${subPath} non-JSON response after retries — skipping.`);
              return failGmgnRequest(
                strict,
                'GMGN_NON_JSON_RESPONSE',
                `GMGN returned a non-JSON response (HTTP ${res.status})`,
                { status: res.status }
              );
            }
          }
        }

        const rateLimitPayload = findRateLimitPayload(json);
        if (res.status === 429 || rateLimitPayload) {
          _gmgnRateLimitedUntil = Math.max(
            _gmgnRateLimitedUntil,
            getRateLimitResetAtMs(res, rateLimitPayload || json)
          );
          const retryAt = new Date(_gmgnRateLimitedUntil).toISOString();
          console.warn(`[gmgn] Rate limited; all GMGN requests paused until ${retryAt}.`);
          return failGmgnRequest(
            strict,
            'GMGN_RATE_LIMITED',
            `GMGN rate limit active until ${retryAt}`,
            { status: 429, retryAt: _gmgnRateLimitedUntil }
          );
        }

        if (!res.ok) {
          const isRetryable = res.status >= 500 || res.status === 408;
          if (isRetryable && attempt < maxRetries) {
            const backoffMs = Math.min(10_000, 800 * Math.pow(2, attempt));
            await sleep(backoffMs);
            continue;
          }
          console.warn(`[gmgn] HTTP ${res.status} for ${subPath} — skipping.`);
          return failGmgnRequest(
            strict,
            `GMGN_HTTP_${res.status}`,
            `GMGN request failed with HTTP ${res.status}`,
            { status: res.status }
          );
        }

        if (!json) {
          if (attempt < maxRetries) {
            await sleep(Math.min(5_000, 600 * Math.pow(2, attempt)));
            continue;
          }
          console.warn(`[gmgn] Non-JSON response for ${subPath} — skipping.`);
          return failGmgnRequest(
            strict,
            'GMGN_EMPTY_RESPONSE',
            'GMGN returned an empty response'
          );
        }

        return unwrapGmgnEnvelope(json, subPath, strict);
      } catch (e) {
        if (e instanceof GmgnApiError) throw e;
        const retryable = /timeout|network|fetch|socket|econn|eai_again|terminated|enotfound|OpenAPI does not support IPv6/i.test(String(e?.message || ''));
        if (retryable && attempt < maxRetries) {
          const backoffMs = Math.min(10_000, 800 * Math.pow(2, attempt));
          await sleep(backoffMs);
          continue;
        }
        console.warn(`[gmgn] ${subPath} failed: ${e.message} — skipping (non-blocking).`);
        return failGmgnRequest(
          strict,
          'GMGN_NETWORK_ERROR',
          'GMGN network request failed'
        );
      }
    }
    return failGmgnRequest(
      strict,
      'GMGN_REQUEST_FAILED',
      'GMGN request failed after retries'
    );
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
export async function getGmgnTokenInfo(mint, { strict = false } = {}) {
  if (!mint || typeof mint !== 'string') return null;
  const cached = getCached('/v1/token/info', mint);
  if (cached) return cached;
  const data = await gmgnFetch('/v1/token/info', { address: mint }, { strict });
  if (data) setCached('/v1/token/info', mint, data);
  return data;
}

/**
 * Get fresh GMGN Solana market rank rows.
 *
 * Rank responses intentionally bypass the 90-second address cache because
 * Token Alerts polls a rolling 5-minute window every minute.
 */
export async function getGmgnTrendingTokens({
  interval = '5m',
  limit = 100,
  strict = true,
} = {}) {
  const data = await gmgnFetch('/v1/market/rank', {
    interval,
    order_by: 'volume',
    direction: 'desc',
    limit: String(Math.max(1, Math.min(100, Number(limit) || 100))),
  }, { strict });

  if (Array.isArray(data)) return data;
  const rows = data?.rank || data?.list || data?.items || data?.tokens;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Get GMGN top holder rows for optional Token Alerts enrichment.
 */
export async function getGmgnTopHolders(mint, { limit = 20 } = {}) {
  if (!mint || typeof mint !== 'string') return [];
  const cacheAddress = `${mint}:${Math.max(1, Number(limit) || 20)}`;
  const cached = getCached('/v1/market/token_top_holders', cacheAddress);
  if (cached) return cached;

  const data = await gmgnFetch('/v1/market/token_top_holders', {
    address: mint,
    limit: String(Math.max(1, Math.min(100, Number(limit) || 20))),
    order_by: 'amount_percentage',
    direction: 'desc',
  });
  const rows = Array.isArray(data)
    ? data
    : data?.holders || data?.list || data?.items || data?.data;
  const normalized = Array.isArray(rows) ? rows : [];
  if (normalized.length > 0) {
    setCached('/v1/market/token_top_holders', cacheAddress, normalized);
  }
  return normalized;
}

/**
 * Robinhood Chain variants use the same OpenAPI endpoints with chain=robinhood.
 */
export async function getGmgnRobinhoodTokenInfo(address, { strict = false } = {}) {
  if (!address || typeof address !== 'string') return null;
  const chain = 'robinhood';
  const cached = getCached('/v1/token/info', address, chain);
  if (cached) return cached;
  const data = await gmgnFetch('/v1/token/info', { address }, { strict, chain });
  if (data) setCached('/v1/token/info', address, data, chain);
  return data;
}

export async function getGmgnRobinhoodTrendingTokens({
  interval = '5m',
  limit = 100,
  minVolumeUsd,
  minTotalFeesEth,
  strict = true,
} = {}) {
  const filters = {};
  if (Number.isFinite(Number(minVolumeUsd))) filters.min_volume = String(Number(minVolumeUsd));
  if (Number.isFinite(Number(minTotalFeesEth))) filters.min_total_fee = String(Number(minTotalFeesEth));

  const data = await gmgnFetch('/v1/market/rank', {
    interval,
    order_by: 'volume',
    direction: 'desc',
    limit: String(Math.max(1, Math.min(100, Number(limit) || 100))),
    ...filters,
  }, { strict, chain: 'robinhood' });

  if (Array.isArray(data)) return data;
  const rows = data?.rank || data?.list || data?.items || data?.tokens;
  return Array.isArray(rows) ? rows : [];
}

export async function getGmgnRobinhoodTopHolders(address, { limit = 20 } = {}) {
  if (!address || typeof address !== 'string') return [];
  const chain = 'robinhood';
  const cacheAddress = `${address}:${Math.max(1, Number(limit) || 20)}`;
  const cached = getCached('/v1/market/token_top_holders', cacheAddress, chain);
  if (cached) return cached;

  const data = await gmgnFetch('/v1/market/token_top_holders', {
    address,
    limit: String(Math.max(1, Math.min(100, Number(limit) || 20))),
    order_by: 'amount_percentage',
    direction: 'desc',
  }, { chain });
  const rows = Array.isArray(data)
    ? data
    : data?.holders || data?.list || data?.items || data?.data;
  const normalized = Array.isArray(rows) ? rows : [];
  if (normalized.length > 0) {
    setCached('/v1/market/token_top_holders', cacheAddress, normalized, chain);
  }
  return normalized;
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
