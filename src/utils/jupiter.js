/**
 * src/utils/jupiter.js — Jupiter Swap Utility
 *
 * Base URL: Jupiter V2 API (https://api.jup.ag/swap/v1/) — direct, tanpa relay.
 * Fallback: https://lite-api.jup.ag/swap/v1/ jika primary gagal.
 */

import { fetchWithTimeout, stringify }  from './safeJson.js';
import { getTokenBalanceRaw }           from '../solana/wallet.js';
import { getConfig }                    from '../config.js';
import { swapToSOL as executeSwapToSOL } from '../solana/jupiter.js';

// ── Jupiter V2 Endpoints (direct) ───────────────────────────────────
const JUP_BASE      = 'https://api.jup.ag/swap/v1';
const JUP_QUOTE_URL = `${JUP_BASE}/quote`;
const JUP_SWAP_URL  = `${JUP_BASE}/swap`;
const JUP_PRICE_URL = 'https://api.jup.ag/price/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '';

// User-Agent uniform agar tidak diblokir CDN Jupiter
const JUPITER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const JUPITER_HEADERS = {
  'User-Agent':      JUPITER_UA,
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
  ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}),
};

// ── getJupiterQuote ─────────────────────────────────────────────────

async function getJupiterQuote(tokenMint, outMint, amount, slippage) {
  const params = new URLSearchParams({
    inputMint:   tokenMint,
    outputMint:  outMint,
    amount:      String(amount),
    slippageBps: String(slippage),
  });

  const quoteRes = await fetchWithTimeout(
    `${JUP_QUOTE_URL}?${params.toString()}`,
    { headers: JUPITER_HEADERS },
    8000
  );
  if (!quoteRes.ok) throw new Error(`Jupiter Quote Failed: ${quoteRes.status}`);
  return await quoteRes.json();
}

// ── getSwapQuoteToSol ────────────────────────────────────────────────

export async function getSwapQuoteToSol(tokenMint, amount, overrideSlippageBps = null) {
  const cfg     = getConfig();
  const WSOL    = 'So11111111111111111111111111111111111111112';
  const slippage = overrideSlippageBps || cfg.slippageBps || 250;
  return getJupiterQuote(tokenMint, WSOL, amount, slippage);
}

// ── swapToSol ────────────────────────────────────────────────────────
// Jupiter V2 Swap — wrapper eksekusi langsung via on-chain Jupiter

function isZeroLikeAmount(amount) {
  return String(amount || '0').trim() === '0';
}

export async function swapToSol(tokenMint, amount, overrideSlippageBps = null, options = {}) {
  try {
    let rawAmount = amount;
    if (isZeroLikeAmount(rawAmount)) {
      rawAmount = await getTokenBalanceRaw(tokenMint);
    }

    if (!rawAmount || String(rawAmount) === '0') {
      return { success: false, reason: 'ZERO_BALANCE' };
    }

    return await executeSwapToSOL(
      tokenMint,
      rawAmount,
      overrideSlippageBps || getConfig().slippageBps || 250,
      options,
    );
  } catch (e) {
    console.error(`[jupiter] swapToSol failed for ${tokenMint.slice(0, 8)}:`, e.message);
    return null;
  }
}

// ── swapAllToSOL ─────────────────────────────────────────────────────

export async function swapAllToSOL(tokenMint, overrideSlippageBps = null) {
  try {
    const balanceRaw = await getTokenBalanceRaw(tokenMint);

    if (!balanceRaw || String(balanceRaw) === '0') {
      return { success: false, reason: 'ZERO_BALANCE' };
    }

    return await swapToSol(tokenMint, balanceRaw, overrideSlippageBps);
  } catch (e) {
    console.error(`[jupiter] swapAllToSOL failed for ${tokenMint}:`, e.message);
    return { success: false, error: e.message };
  }
}

// ── getJupiterPrice ──────────────────────────────────────────────────

export async function getJupiterPrice(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${JUP_PRICE_URL}?ids=${tokenMint}`,
      { headers: JUPITER_HEADERS },
      5000
    );
    if (!res.ok) return null;
    const data     = await res.json();
    const rawPrice = data.data?.[tokenMint]?.price;
    return rawPrice ? parseFloat(rawPrice) : null;
  } catch {
    return null;
  }
}
