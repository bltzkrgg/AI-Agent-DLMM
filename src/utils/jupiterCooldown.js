/**
 * src/utils/jupiterCooldown.js — Shared Jupiter Rate Limit Cooldown
 *
 * State 429 global yang dibagi antara coinfilter.js dan solana/jupiter.js.
 * Mencegah request berikutnya membombardir endpoint selama masa pendinginan.
 *
 * Usage:
 *   import { checkCooldown, setCooldown, clearCooldown } from './jupiterCooldown.js';
 *
 *   // Sebelum request:
 *   checkCooldown();               // throw jika cooldown aktif
 *
 *   // Saat dapat 429:
 *   setCooldown(retryAfterSec);    // set cooldown dari header retry-after
 */

// ── Shared mutable state (module-level singleton) ─────────────────
let _cooldownUntil = 0;

/**
 * Periksa cooldown global.
 * Throw JUPITER_IN_COOLDOWN_Xs jika masih dalam masa pendinginan.
 */
export function checkCooldown() {
  const now = Date.now();
  if (_cooldownUntil > now) {
    const remainSec = Math.ceil((_cooldownUntil - now) / 1000);
    throw new Error(`JUPITER_IN_COOLDOWN_${remainSec}s`);
  }
}

/**
 * Set cooldown dari response 429.
 * @param {number} retryAfterSec - nilai dari header retry-after (0 = pakai default 60s)
 */
export function setCooldown(retryAfterSec = 0) {
  const bufferMs  = 5000; // +5 detik buffer di atas nilai server
  const cooldownMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 60000) + bufferMs;
  _cooldownUntil = Date.now() + cooldownMs;
  console.warn(`[JupiterCooldown] HTTP 429 — cooldown ${Math.round(cooldownMs / 1000)}s (retry-after=${retryAfterSec || 'N/A'})`);
}

/**
 * Reset cooldown manual (untuk testing atau admin command).
 */
export function clearCooldown() {
  _cooldownUntil = 0;
}

/**
 * Baca sisa cooldown dalam detik (0 = tidak aktif).
 */
export function getCooldownRemainSec() {
  const remain = _cooldownUntil - Date.now();
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}
