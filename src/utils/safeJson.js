/**
 * Safe utilities — used across all modules
 */
const SENSITIVE_PARAMS = ['api-key', 'apiKey', 'token', 'timestamp', 'client_id'];

function maskUrl(url) {
  try {
    const urlObj = new URL(url);
    SENSITIVE_PARAMS.forEach(param => {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, '[REDACTED]');
      }
    });
    return urlObj.toString();
  } catch {
    return url;
  }
}

import { globalRateLimiter } from './rateLimiter.js';
import { safeStringify } from './serializer.js';

/**
 * Safe JSON parse for AI output — handles markdown blocks, extracts JSON from text
 */
export function safeParseAI(text, fallback = null) {
  if (!text || typeof text !== 'string') return fallback;

  let clean = text.trim();
  // Strip markdown code fences
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Direct parse
  try { return JSON.parse(clean); } catch {}

  // Extract JSON object
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }

  // Extract JSON array
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }

  return fallback;
}

/**
 * Fetch with timeout — prevents hanging on slow APIs
 * Includes rate limiting per domain + HTTP 429 backoff
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  // Apply rate limiting ONLY to critical domains with strict rate limits
  // Skip: LLM APIs (handle own limiting), internal APIs, already rate-limiting endpoints
  const hostname = new URL(url).hostname;

  // Domains yang SKIP rate limiting (sudah aman atau tidak critical)
  const skipRateLimiting = [
    'api.openai.com', 'api.anthropic.com', 'openrouter.ai', 'api.openrouter.org', // LLM APIs
    'tokens.jup.ag', 'api.jup.ag', // Jupiter (sudah punya rate limiting sendiri)
    'api.lpagent.io', // LP Agent (sudah punya 13s interval)
    'mainnet.helius-rpc.com', 'solana-mainnet.g.alchemy.com', 'solana-mainnet.quiknode.pro', // RPC (sudah aman)
  ];

  // Domains yang PERLU rate limiting (strict free tier)
  const needsRateLimiting = [
    'api.dexscreener.com',
  ];

  if (needsRateLimiting.includes(hostname) && !skipRateLimiting.includes(hostname)) {
    try {
      await globalRateLimiter.acquire(hostname);
    } catch (e) {
      console.warn(`⚠️ Rate limiter error for ${hostname}: ${e.message}`);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);

    // Handle HTTP 429 (Rate Limited) — log but don't fail, let caller handle
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
      console.warn(`⚠️ HTTP 429 from ${hostname}, retry-after: ${retryAfter}s`);
    }

    return res;
  } catch (e) {
    clearTimeout(timer);
    const masked = maskUrl(url);
    if (e.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms): ${masked}`);
    const cause = e?.cause?.code || e?.cause?.message || e?.message || 'unknown fetch error';
    throw new Error(`Fetch failed for ${masked}: ${cause}`);
  }
}

/**
 * Retry wrapper for flaky network calls with basic linear delay
 */
export async function withRetry(fn, retries = 3, delayMs = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (e) {
      lastError = e;
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * Advanced retry wrapper with exponential backoff.
 * Delay formula: min(baseDelay * 2^attempt, maxDelay) + jitter
 */
export async function withExponentialBackoff(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 10000 } = {}) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        const delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
        const jitter = Math.random() * 200; // random 0-200ms
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }
  }
  throw lastError;
}

/**
 * Parse TVL string like "$1.2M", "$900K", "$1.5B" to number
 */
export function parseTvl(tvlStr) {
  if (typeof tvlStr === 'number') return tvlStr;
  if (!tvlStr) return 0;
  const clean = String(tvlStr).replace(/[$,\s]/g, '').toUpperCase();
  if (clean.endsWith('B')) return parseFloat(clean) * 1e9;
  if (clean.endsWith('M')) return parseFloat(clean) * 1e6;
  if (clean.endsWith('K')) return parseFloat(clean) * 1e3;
  return parseFloat(clean) || 0;
}

/**
 * Safe number — returns default if value is NaN/null/undefined
 * Now handles commas and spaces in financial strings (e.g. "1,234.56")
 */
export function safeNum(val, def = 0) {
  if (val === null || val === undefined) return def;
  if (typeof val === 'number') return Number.isFinite(val) ? val : def;
  
  // Clean string: remove commas, spaces, and currency symbols
  const clean = String(val).replace(/[$,\s]/g, '');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : def;
}
/**
 * Enhanced Serializer for logging/storage
 */
export function stringify(obj, space = 0) {
  return safeStringify(obj, space);
}

/**
 * Logika Slippage Konservatif (Irit Execution)
 * Menyesuaikan toleransi berdasarkan volatilitas market, tapi dibatasi secara ketat.
 * @param {number} volatility24h - Persentase rentang harga 24 jam (0-100+)
 * @returns {number} Slippage dalam BPS (100 = 1%)
 */
export function getConservativeSlippage(volatility24h = 0) {
  const baseSlippage = 100; // 1.0%
  const volFactor = 1.2;
  const dynamic = Math.round((volatility24h || 0) * volFactor);
  
  // Cap ketat di 200 BPS (2.0%) sesuai request user "gak mau kena pajak max 5%"
  const finalSlippage = Math.min(200, baseSlippage + dynamic);
  return finalSlippage;
}

/**
 * Global Text Scrubber — Mencari dan menyensor data sensitif di dalam teks mentah.
 * Berguna untuk membersihkan history chat sebelum dikirim ke AI.
 */
export function scrubSensitiveText(text) {
  if (!text || typeof text !== 'string') return text;
  
  let clean = text;

  // 1. Sensor Mnemonics (12-24 kata umum)
  // Pola sederhana: kata-kata spasi kata-kata (minimal 12 kata)
  const mnemonicPattern = /\b([a-z]{3,}\s){11,}[a-z]{3,}\b/gi;
  clean = clean.replace(mnemonicPattern, '[REDACTED_MNEMONIC]');

  // 2. Sensor Solana Private Keys (Base58, ~88 chars)
  const solPrivKeyPattern = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;
  clean = clean.replace(solPrivKeyPattern, '[REDACTED_PRIVKEY]');

  // 3. Sensor API Keys di URL atau string assignment
  const apiKeyPattern = /(api-key|apiKey|token|secret)=([a-zA-Z0-9_-]+)/gi;
  clean = clean.replace(apiKeyPattern, '$1=[REDACTED]');

  return clean;
}
