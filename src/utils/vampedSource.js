import { fetchWithTimeout } from './safeJson.js';

const _cache = new Map();

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function pickFirstBoolean(obj, paths = []) {
  for (const path of paths) {
    const raw = getByPath(obj, path);
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') return true;
    if (raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') return false;
  }
  return null;
}

function toCacheKey(url) {
  return String(url || '');
}

function getCache(url, ttlMs) {
  const key = toCacheKey(url);
  const row = _cache.get(key);
  if (!row) return null;
  if ((Date.now() - row.ts) > ttlMs) {
    _cache.delete(key);
    return null;
  }
  return row.value;
}

function setCache(url, value) {
  _cache.set(toCacheKey(url), { ts: Date.now(), value });
}

export async function getExternalVampedStatus(tokenMint, cfg = {}) {
  const enabled = cfg.vampedSourceEnabled === true;
  const template = String(cfg.vampedSourceUrlTemplate || '').trim();
  const timeoutMs = Number(cfg.vampedSourceTimeoutMs || 7000);
  const cacheTtlMs = Math.max(1000, Number(cfg.vampedSourceCacheTtlSec || 300) * 1000);

  if (!enabled) {
    return { status: 'DISABLED', isVamped: null, source: 'external', reason: 'disabled' };
  }
  if (!template || !tokenMint) {
    return { status: 'UNAVAILABLE', isVamped: null, source: 'external', reason: 'missing_url_or_mint' };
  }

  const url = template.includes('{mint}')
    ? template.replaceAll('{mint}', encodeURIComponent(tokenMint))
    : `${template}${template.includes('?') ? '&' : '?'}mint=${encodeURIComponent(tokenMint)}`;

  const cached = getCache(url, cacheTtlMs);
  if (cached) return cached;

  try {
    const headers = {};
    if (cfg.vampedSourceApiKey) headers['X-APIKEY'] = String(cfg.vampedSourceApiKey);
    const res = await fetchWithTimeout(url, { headers }, timeoutMs);
    if (!res.ok) {
      const out = { status: 'ERROR', isVamped: null, source: 'external', reason: `http_${res.status}` };
      setCache(url, out);
      return out;
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') {
      const out = { status: 'ERROR', isVamped: null, source: 'external', reason: 'invalid_json' };
      setCache(url, out);
      return out;
    }

    const isVamped = pickFirstBoolean(json, [
      'isVamped',
      'is_vamped',
      'vamped',
      'data.isVamped',
      'data.is_vamped',
      'data.vamped',
      'result.isVamped',
      'result.is_vamped',
      'result.vamped',
    ]);

    const out = {
      status: isVamped == null ? 'UNKNOWN' : 'OK',
      isVamped,
      source: 'external',
      reason: isVamped == null ? 'field_missing' : 'success',
    };
    setCache(url, out);
    return out;
  } catch (e) {
    const out = { status: 'ERROR', isVamped: null, source: 'external', reason: e?.message || 'request_failed' };
    setCache(url, out);
    return out;
  }
}

