/**
 * Safe utilities — used across all modules
 */

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
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms): ${url}`);
    const cause = e?.cause?.code || e?.cause?.message || e?.message || 'unknown fetch error';
    throw new Error(`Fetch failed for ${url}: ${cause}`);
  }
}

/**
 * Retry wrapper for flaky network calls
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
 */
export function safeNum(val, def = 0) {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
}
