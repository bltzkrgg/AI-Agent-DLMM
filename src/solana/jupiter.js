/**
 * Jupiter Swap Integration
 *
 * Swap any SPL token → SOL via Jupiter V6 API.
 * Digunakan setelah claim fees atau close posisi untuk convert profit ke SOL.
 */

import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getConnection, getWallet } from './wallet.js';
import { fetchWithTimeout } from '../utils/safeJson.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { isDryRun } from '../config.js';

export const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

// ─── Get token balance for a specific mint ────────────────────────

export async function getTokenBalance(walletPublicKey, tokenMint) {
  if (tokenMint === SOL_MINT) {
    const connection = getConnection();
    const balance = await connection.getBalance(walletPublicKey);
    return balance; // in lamports
  }
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(tokenMint);
    const accounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
      mint: mintPubkey,
    });
    if (!accounts.value.length) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.amount; // raw amount string
  } catch {
    return 0;
  }
}

// ─── Get Jupiter quote ────────────────────────────────────────────

export async function getJupiterQuote(inputMint, outputMint, amountRaw, slippageBps = 100) {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Jupiter quote failed: ${err}`);
  }
  return await res.json();
}

// ─── Swap token → SOL ─────────────────────────────────────────────

export async function swapToSOL(inputMint, amountRaw, slippageBps = 100) {
  if (!inputMint || inputMint === SOL_MINT) {
    return { skipped: true, reason: 'Already SOL or no mint provided' };
  }
  if (!amountRaw || parseInt(amountRaw) <= 0) {
    return { skipped: true, reason: 'Amount is zero' };
  }
  if (isDryRun()) {
    console.log(`[DRY RUN] swapToSOL skipped: mint=${inputMint} amount=${amountRaw}`);
    return { dryRun: true, skipped: true, reason: 'Dry run mode — TX not executed' };
  }

  const wallet = getWallet();
  const connection = getConnection();

  // 1. Get quote
  const quote = await getJupiterQuote(inputMint, SOL_MINT, amountRaw, slippageBps);
  const outSol = parseInt(quote.outAmount) / 1e9;

  // 2. Get Helius priority fee recommendation (best-effort)
  let priorityFeeLamports = 50000; // default 0.00005 SOL
  try {
    priorityFeeLamports = await getRecommendedPriorityFee([inputMint, SOL_MINT]);
  } catch { /* pakai default */ }

  // 3. Get swap transaction
  const swapRes = await fetchWithTimeout(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports,
    }),
  }, 15000);

  if (!swapRes.ok) {
    const err = await swapRes.text().catch(() => swapRes.status);
    throw new Error(`Jupiter swap TX failed: ${err}`);
  }

  const { swapTransaction } = await swapRes.json();

  // 3. Deserialize → sign → send
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Pakai polling confirm (sama dengan meteora.js) — lebih reliable dari websocket confirmTransaction
  // yang sering timeout di public RPC tanpa berarti TX gagal.
  const start = Date.now();
  const maxWaitMs = 60000;
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: false });
      const val = status?.value;
      if (val?.err) throw new Error(`Swap TX gagal on-chain: ${JSON.stringify(val.err)}`);
      if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') break;
    } catch (e) {
      if (e.message?.startsWith('Swap TX gagal')) throw e;
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  return {
    success: true,
    txHash,
    inputMint,
    outputMint: SOL_MINT,
    inAmount:   amountRaw,
    outAmountLamports: quote.outAmount,
    outSol:     parseFloat(outSol.toFixed(6)),
    priceImpactPct: quote.priceImpactPct || 0,
  };
}

// ─── Swap all non-SOL balance of a token to SOL ───────────────────

export async function swapAllToSOL(tokenMint, slippageBps = 100) {
  const wallet = getWallet();
  const balance = await getTokenBalance(wallet.publicKey, tokenMint);
  const amount  = typeof balance === 'string' ? balance : balance.toString();
  if (!amount || amount === '0') {
    return { skipped: true, reason: `No balance for ${tokenMint.slice(0, 8)}...` };
  }
  return swapToSOL(tokenMint, amount, slippageBps);
}
