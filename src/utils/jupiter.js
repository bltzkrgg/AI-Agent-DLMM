import { fetchWithTimeout } from './safeJson.js';
import { getWallet } from '../solana/wallet.js';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API  = 'https://quote-api.jup.ag/v6/swap';

/**
 * Jupiter V6 Swap Utility — Zero Dust liquidity management
 */
export async function swapToSol(tokenMint, amount) {
  const wallet = getWallet();
  const WSOL   = 'So11111111111111111111111111111111111111112';

  if (!amount || amount <= 0) return null;

  try {
    // 1. Get Quote
    const quoteRes = await fetchWithTimeout(
      `${JUPITER_QUOTE_API}?inputMint=${tokenMint}&outputMint=${WSOL}&amount=${amount}&slippageBps=100`, // 1% slippage
      {},
      8000
    );
    if (!quoteRes.ok) throw new Error(`Jupiter Quote Failed: ${quoteRes.status}`);
    const quoteResponse = await quoteRes.json();

    // 2. Get Swap Transaction
    const swapRes = await fetchWithTimeout(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

export async function getJupiterPrice(tokenMint) {
  try {
    const res = await fetchWithTimeout(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {}, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    return safeNum(data.data[tokenMint]?.price);
  } catch {
    return null;
  }
}
