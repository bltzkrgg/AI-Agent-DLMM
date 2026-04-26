/**
 * src/utils/jupiter.js — Jupiter Swap Utility
 *
 * Base URL: Jupiter V2 API (https://api.jup.ag/swap/v2/)
 *
 * Relay Mode: Jika config.lpAgentRelayEnabled === true, semua request
 * dikirim via Meridian LP Agent Relay (bypass ISP blocking).
 * Relay diaktifkan via relayFetch() yang transparan.
 */

import { stringify }             from './safeJson.js';
import { relayFetch }            from './relayFetch.js';
import { getWallet }             from '../solana/wallet.js';
import { getConfig }             from '../config.js';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

// ── Jupiter V2 Endpoints ──────────────────────────────────────────
const JUP_BASE       = 'https://api.jup.ag/swap/v2';
const JUP_QUOTE_URL  = `${JUP_BASE}/quote`;
const JUP_SWAP_URL   = `${JUP_BASE}/swap`;
const JUP_PRICE_URL  = 'https://api.jup.ag/price/v2';

// ── getJupiterQuote ───────────────────────────────────────────────

async function getJupiterQuote(tokenMint, outMint, amount, slippage) {
  const params = new URLSearchParams({
    inputMint:    tokenMint,
    outputMint:   outMint,
    amount:       String(amount),
    slippageBps:  String(slippage),
  });

  const quoteRes = await relayFetch(
    `${JUP_QUOTE_URL}?${params.toString()}`,
    {},
    8000
  );
  if (!quoteRes.ok) throw new Error(`Jupiter Quote Failed: ${quoteRes.status}`);
  return await quoteRes.json();
}

// ── getSwapQuoteToSol ─────────────────────────────────────────────

export async function getSwapQuoteToSol(tokenMint, amount, overrideSlippageBps = null) {
  const cfg     = getConfig();
  const WSOL    = 'So11111111111111111111111111111111111111112';
  const slippage = overrideSlippageBps || cfg.slippageBps || 100;
  return getJupiterQuote(tokenMint, WSOL, amount, slippage);
}

// ── swapToSol ─────────────────────────────────────────────────────
// Jupiter V2 Swap — dengan JIT price stability check

export async function swapToSol(tokenMint, amount, overrideSlippageBps = null) {
  const wallet  = getWallet();
  const cfg     = getConfig();
  const WSOL    = 'So11111111111111111111111111111111111111112';

  try {
    // 1. Quote A — baseline
    const slippage = overrideSlippageBps || cfg.slippageBps || 100;
    const quoteA   = await getJupiterQuote(tokenMint, WSOL, amount, slippage);
    const outA     = parseInt(quoteA.outAmount);

    // 2. JIT Verification — tunggu 800ms untuk stabilitas harga
    console.log(`[jupiter] JIT Verification: Menunggu 800ms untuk stabilitas harga...`);
    await new Promise(r => setTimeout(r, 800));

    // 3. Quote B — second opinion
    const quoteB   = await getJupiterQuote(tokenMint, WSOL, amount, slippage);
    const outB     = parseInt(quoteB.outAmount);

    // 4. Price Stability Check (maks deviasi 1.0%)
    const priceShift = (outB - outA) / outA;
    if (priceShift < -0.01) {
      console.warn(`[jupiter] ABORT: Harga tidak stabil! Shift: ${(priceShift * 100).toFixed(2)}%`);
      return { success: false, reason: 'PRICE_UNSTABLE', shift: priceShift };
    }

    console.log(`[jupiter] Verification STABLE (Shift: ${(priceShift * 100).toFixed(2)}%). Swap...`);

    // 5. Get Swap Transaction via V2
    const swapRes = await relayFetch(JUP_SWAP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    stringify({
        quoteResponse:              quoteB,
        userPublicKey:              wallet.publicKey.toString(),
        wrapAndUnwrapSol:           true,
        dynamicComputeUnitLimit:    true,
        prioritizationFeeLamports:  'auto',
      }),
    }, 10000);

    if (!swapRes.ok) throw new Error(`Jupiter Swap V2 Failed: ${swapRes.status}`);
    const { swapTransaction } = await swapRes.json();

    return {
      swapTransaction,
      outAmount:       quoteB.outAmount,
      priceImpactPct:  quoteB.priceImpactPct,
    };
  } catch (e) {
    console.error(`[jupiter] swapToSol failed for ${tokenMint.slice(0,8)}:`, e.message);
    return null;
  }
}

// ── swapAllToSOL ──────────────────────────────────────────────────

export async function swapAllToSOL(tokenMint, overrideSlippageBps = null) {
  try {
    const { getTokenBalance } = await import('../solana/wallet.js');
    const balanceInfo = await getTokenBalance(tokenMint);

    if (!balanceInfo || !balanceInfo.amount || parseFloat(balanceInfo.amount) <= 0) {
      return { success: false, reason: 'ZERO_BALANCE' };
    }

    const swapRes = await swapToSol(tokenMint, balanceInfo.amount, overrideSlippageBps);

    if (swapRes && swapRes.swapTransaction) {
      const outSol = parseFloat(swapRes.outAmount) / 1e9;
      return { success: true, outSol };
    }

    return {
      success: false,
      reason:  swapRes?.reason || 'SWAP_FAILED',
      shift:   swapRes?.shift,
    };
  } catch (e) {
    console.error(`[jupiter] swapAllToSOL failed for ${tokenMint}:`, e.message);
    return { success: false, error: e.message };
  }
}

// ── getJupiterPrice ───────────────────────────────────────────────
// Gunakan relayFetch agar price check juga melewati relay jika aktif

export async function getJupiterPrice(tokenMint) {
  try {
    const res = await relayFetch(
      `${JUP_PRICE_URL}?ids=${tokenMint}`,
      {},
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
