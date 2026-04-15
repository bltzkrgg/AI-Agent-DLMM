import { fetchWithTimeout, stringify } from './safeJson.js';
import { getWallet } from '../solana/wallet.js';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

import { getConfig } from '../config.js';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API  = 'https://quote-api.jup.ag/v6/swap';

/**
 * Mendapatkan Quote dari Jupiter dengan penanganan error terpusat.
 */
async function getJupiterQuote(tokenMint, outMint, amount, slippage) {
  const quoteRes = await fetchWithTimeout(
    `${JUPITER_QUOTE_API}?inputMint=${tokenMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippage}`,
    {},
    8000
  );
  if (!quoteRes.ok) throw new Error(`Jupiter Quote Failed: ${quoteRes.status}`);
  return await quoteRes.json();
}

/**
 * Jupiter V6 Swap Utility — Zero Dust liquidity management
 */
export async function swapToSol(tokenMint, amount, overrideSlippageBps = null) {
  const wallet = getWallet();
  const cfg    = getConfig();
  const WSOL   = 'So11111111111111111111111111111111111111112';

  try {
    // 1. Get Quote A (Baseline)
    const slippage = overrideSlippageBps || cfg.slippageBps || 100;
    const quoteA = await getJupiterQuote(tokenMint, WSOL, amount, slippage);
    const outAmountA = parseInt(quoteA.outAmount);

    // 2. THE ANTI-ARBITRAGE WAIT (JIT Verification)
    // Sesuai filosofi Evil Panda: Lebih baik nunggu sejenak daripada hajar harga 'pucuk'.
    console.log(`[jupiter] JIT Verification: Menunggu 800ms untuk stabilitas harga...`);
    await new Promise(r => setTimeout(r, 800));

    // 3. Get Quote B (Second Opinion)
    const quoteB = await getJupiterQuote(tokenMint, WSOL, amount, slippage);
    const outAmountB = parseInt(quoteB.outAmount);

    // 4. Stabiliity Check (Deviasi maksimal 1.0%)
    const priceShift = (outAmountB - outAmountA) / outAmountA;
    const threshold = -0.01; // -1.0%
    
    if (priceShift < threshold) {
      console.warn(`[jupiter] ABORT: Harga tidak stabil! Shift: ${(priceShift * 100).toFixed(2)}% (Max 1%).`);
      return { success: false, reason: 'PRICE_UNSTABLE', shift: priceShift };
    }

    console.log(`[jupiter] Verification: STABLE (Shift: ${(priceShift * 100).toFixed(2)}%). Melanjutkan swap...`);
    const quoteResponse = quoteB;

    // 2. Get Swap Transaction
    const swapRes = await fetchWithTimeout(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      })
    }, 10000);

    if (!swapRes.ok) throw new Error(`Jupiter Swap API Failed: ${swapRes.status}`);
    const { swapTransaction } = await swapRes.json();

    return {
      swapTransaction,
      outAmount: quoteResponse.outAmount,
      priceImpactPct: quoteResponse.priceImpactPct
    };
  } catch (e) {
    console.error(`[jupiter] swapToSol failed for ${tokenMint}:`, e.message);
    return null;
  }
}

export async function swapAllToSOL(tokenMint, overrideSlippageBps = null) {
  try {
    const { getTokenBalance } = await import('../solana/wallet.js');
    const balanceInfo = await getTokenBalance(tokenMint);
    
    // balanceInfo format: { amount: "1000000", decimals: 6, uiAmount: 1.0 }
    if (!balanceInfo || !balanceInfo.amount || parseFloat(balanceInfo.amount) <= 0) {
      return { success: false, reason: 'ZERO_BALANCE' };
    }

    const swapRes = await swapToSol(tokenMint, balanceInfo.amount, overrideSlippageBps);
    
    // Sukses jika swapRes ada DAN punya swapTransaction
    if (swapRes && swapRes.swapTransaction) {
      const outSol = parseFloat(swapRes.outAmount) / 1e9;
      return { success: true, outSol };
    }

    // Jika gagal, teruskan alasannya (misal: PRICE_UNSTABLE)
    return { 
      success: false, 
      reason: swapRes?.reason || 'SWAP_FAILED',
      shift: swapRes?.shift
    };
  } catch (e) {
    console.error(`[jupiter] swapAllToSOL failed for ${tokenMint}:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function getJupiterPrice(tokenMint) {
  try {
    const res = await fetchWithTimeout(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {}, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    const rawPrice = data.data[tokenMint]?.price;
    return rawPrice ? parseFloat(rawPrice) : null;
  } catch {
    return null;
  }
}
