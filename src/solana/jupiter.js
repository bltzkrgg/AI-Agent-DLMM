/**
 * Jupiter Swap Integration
 *
 * Swap any SPL token → SOL via Jupiter V2 API (direct, tanpa relay proxy).
 * Fallback: lite-api.jup.ag jika api.jup.ag tidak dapat dijangkau.
 */

import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getConnection, getWallet } from './wallet.js';
import { fetchWithTimeout, withRetry, withExponentialBackoff, stringify } from '../utils/safeJson.js';
import { checkCooldown, setCooldown } from '../utils/jupiterCooldown.js';
import { getRecommendedPriorityFee } from '../utils/helius.js';
import { isDryRun } from '../config.js';
import {
  checkAndConsumePriorityFeeBudget,
  estimatePriorityFeeSol,
  recordTxFailure,
  recordTxSuccess,
} from '../safety/gasGuard.js';

export const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '';

export function getJupiterBaseUrls() {
  if (JUPITER_API_KEY) return ['https://api.jup.ag'];
  return ['https://lite-api.jup.ag', 'https://api.jup.ag'];
}

// User-Agent uniform agar tidak diblokir CDN Jupiter
const JUPITER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getJupiterHeaders(extra = {}) {
  const headers = { ...extra };
  if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;
  return headers;
}

async function fetchJupiter(path, options = {}, timeoutMs = 15000) {
  let lastError;

  // Periksa shared cooldown sebelum request (sync dengan coinfilter.js)
  checkCooldown();

  for (const baseUrl of getJupiterBaseUrls()) {
    const url = `${baseUrl}${path}`;
    try {
      return await withExponentialBackoff(
        async () => {
          const res = await fetchWithTimeout(url, {
            ...options,
            headers: {
              'User-Agent':      JUPITER_UA,
              'Accept':          'application/json',
              ...getJupiterHeaders(options.headers || {}),
            },
          }, timeoutMs);

          if (!res.ok) {
            const status = res.status;
            // 429 → set shared cooldown (sync dengan coinfilter.js)
            if (status === 429) {
              const retryAfter = parseInt(res.headers?.get?.('retry-after') || '0', 10);
              setCooldown(retryAfter);
              throw new Error(`HTTP_429_COOLDOWN`);
            }
            // 401/403 tanpa API key di primary → coba provider berikutnya
            if ((status === 401 || status === 403) && baseUrl === 'https://api.jup.ag' && !JUPITER_API_KEY) {
              throw new Error('UNAUTHORIZED_PROVIDER');
            }
            // 5xx → retry dengan backoff
            if (status >= 500) throw new Error(`HTTP_${status}`);
          }
          return res;
        },
        { maxRetries: 3, baseDelay: 1500 }
      );
    } catch (e) {
      if (e.message === 'UNAUTHORIZED_PROVIDER') continue;
      lastError = e;
    }
  }

  throw lastError || new Error(`Jupiter request failed for ${path}`);
}

function toBigIntAmount(value) {
  try {
    return BigInt(String(value || 0));
  } catch {
    return 0n;
  }
}

async function detectLikelySwapSuccess({ connection, wallet, inputMint, amountRaw, txHash, quotedOutSol = 0 }) {
  await new Promise(r => setTimeout(r, 4000));

  let finalStatus = null;
  if (txHash) {
    try {
      finalStatus = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      const err = finalStatus?.value?.err;
      if (err) throw new Error(`Swap TX gagal on-chain: ${JSON.stringify(err)}`);
      const confirmation = finalStatus?.value?.confirmationStatus;
      if (confirmation === 'confirmed' || confirmation === 'finalized') {
        return {
          success: true,
          txHash,
          assumedSuccess: false,
          confirmedLate: true,
          outSol: parseFloat(Number(quotedOutSol || 0).toFixed(6)),
        };
      }
    } catch (e) {
      if (e.message?.startsWith('Swap TX gagal')) throw e;
    }
  }

  const remaining = await getTokenBalance(wallet.publicKey, inputMint).catch(() => amountRaw);
  const remainingRaw = toBigIntAmount(remaining);
  const originalRaw = toBigIntAmount(amountRaw);
  const mostlyDrained = originalRaw > 0n && (remainingRaw === 0n || remainingRaw * 100n <= originalRaw * 5n);

  if (mostlyDrained) {
    return {
      success: true,
      txHash,
      assumedSuccess: true,
      confirmationStatus: finalStatus?.value?.confirmationStatus || 'unknown',
      outSol: parseFloat(Number(quotedOutSol || 0).toFixed(6)),
    };
  }

  return null;
}

// ─── Get token balance for a specific mint ────────────────────────

export async function getTokenBalance(walletPublicKey, tokenMint) {
  const connection = getConnection();
  if (tokenMint === SOL_MINT) {
    const balance = await connection.getBalance(walletPublicKey);
    return balance; // in lamports
  }
  try {
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
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true',
  });
  // Periksa shared cooldown sebelum hit endpoint
  checkCooldown();
  const res = await fetchJupiter(`/swap/v1/quote?${quoteParams.toString()}`, {}, 10000);
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Jupiter quote failed: ${err}`);
  }
  return await res.json();
}

// ─── Swap token → SOL ─────────────────────────────────────────────

export async function swapToSOL(inputMint, amountRaw, slippageBps = 100, options = {}) {
  const { isUrgent = false } = options;
  const effectiveSlippage = isUrgent ? 500 : slippageBps;

  if (!inputMint || inputMint === SOL_MINT) {
    return { skipped: true, reason: 'Already SOL or no mint provided' };
  }
  if (!amountRaw || parseInt(amountRaw) <= 0) {
    return { skipped: true, reason: 'Amount is zero' };
  }
  if (isDryRun()) {
    console.log(`[DRY RUN] swapToSOL skipped: mint=${inputMint} amount=${amountRaw} urgent=${isUrgent}`);
    return { dryRun: true, skipped: true, reason: 'Dry run mode — TX not executed' };
  }

  const wallet = getWallet();
  const connection = getConnection();

  // 1. Get quote
  const quote = await getJupiterQuote(inputMint, SOL_MINT, amountRaw, effectiveSlippage);
  const outSol = parseInt(quote.outAmount) / 1e9;
  
  // 🛡️ SURGICAL IMPACT GUARD: Pelindung Modal dari Liquiditas Ampas
  const impact = parseFloat(quote.priceImpactPct || 0);
  const maxAllowedImpact = isUrgent ? 10.0 : 5.0; // Pelit mode: 5% normal, 10% darurat
  
  if (impact > maxAllowedImpact) {
    const errorMsg = `LIQUIDITY_TRAP: Price impact too high (${impact.toFixed(2)}% > ${maxAllowedImpact}%). ` +
                     `Swap aborted to protect capital. Manual intervention required.`;
    console.warn(`🛑 [jupiter] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  if (outSol < 0.0001) {
    return { skipped: true, reason: `Dust amount: expected return ${outSol.toFixed(7)} SOL is too small` };
  }

  // 2. Get Helius priority fee recommendation (best-effort)
  let priorityFeeLamports = isUrgent ? 250000 : 50000;
  try {
    const recommended = await getRecommendedPriorityFee([inputMint, SOL_MINT]);
    priorityFeeLamports = Math.max(priorityFeeLamports, Math.round(recommended * 1.5));
  } catch { /* pakai default */ }

  // 3. Get swap transaction
  const swapRes = await fetchJupiter('/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stringify({
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

  // 4. Deserialize → (optional Jito) → sign → send
  let finalTx;
  try {
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);
    
    if (isUrgent) {
      const tipAmount = 1000000; // 0.001 SOL Jito Tip
      const tipAddr = JITO_TIP_ADDRESSES[Math.floor(Math.random() * JITO_TIP_ADDRESSES.length)];
      
      const tipIx = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tipAddr),
        lamports: tipAmount,
      });

      const addressLookupTableAccounts = await Promise.all(
        versionedTx.message.addressTableLookups.map(async (lookup) => {
          return (await connection.getAddressLookupTable(lookup.accountKey)).value;
        })
      );

      const message = TransactionMessage.decompile(versionedTx.message, {
        addressLookupTableAccounts,
      });

      message.instructions.push(tipIx);
      versionedTx.message = message.compileToV0Message(addressLookupTableAccounts);
      console.log(`🛡️ Jito Anti-MEV Enabled: Tip ${tipAmount/1e9} SOL added to ${tipAddr.slice(0, 8)}...`);
    }

    versionedTx.sign([wallet]);
    finalTx = versionedTx;
  } catch (err) {
    console.warn(`⚠️ Gagal menyuntikkan Jito Tip, lanjut tanpa tip: ${err.message}`);
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const fallbackTx = VersionedTransaction.deserialize(txBuf);
    fallbackTx.sign([wallet]);
    finalTx = fallbackTx;
  }

  let txHash = null;
  try {
    const estFeeSol = estimatePriorityFeeSol({ priorityFeeLamports });
    const budgetCheck = checkAndConsumePriorityFeeBudget({
      estimatedSol: estFeeSol,
      context: 'jupiter.swap',
    });
    if (!budgetCheck.allowed) {
      throw new Error(`TX_GUARD_BLOCKED: ${budgetCheck.reason}`);
    }

    txHash = await connection.sendRawTransaction(finalTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const start = Date.now();
    const maxWaitMs = 60000;
    while (Date.now() - start < maxWaitMs) {
      try {
        const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
        const val = status?.value;
        if (val?.err) throw new Error(`Swap TX gagal on-chain: ${JSON.stringify(val.err)}`);
        if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') break;
      } catch (e) {
        if (e.message?.startsWith('Swap TX gagal')) throw e;
      }
      await new Promise(r => setTimeout(r, 2500));
    }

    recordTxSuccess({ context: 'jupiter.swap' });
    return {
      success: true,
      txHash,
      inputMint,
      outputMint: SOL_MINT,
      inAmount:   amountRaw,
      outAmountLamports: quote.outAmount,
      outSol:     parseFloat(outSol.toFixed(6)),
      priceImpactPct: quote.priceImpactPct || 0,
      urgent:     isUrgent
    };
  } catch (error) {
    const likelySuccess = await detectLikelySwapSuccess({
      connection: getConnection(),
      wallet,
      inputMint,
      amountRaw,
      txHash,
      quotedOutSol: outSol,
    });
    if (likelySuccess) {
      recordTxSuccess({ context: 'jupiter.swap.assumed_success' });
      return {
        ...likelySuccess,
        inputMint,
        outputMint: SOL_MINT,
        inAmount: amountRaw,
        outAmountLamports: quote.outAmount,
        priceImpactPct: quote.priceImpactPct || 0,
        urgent: isUrgent
      };
    }
    recordTxFailure({ context: 'jupiter.swap', error });
    throw error;
  }
}

// ─── Swap all non-SOL balance of a token to SOL ───────────────────

export async function swapAllToSOL(tokenMint, slippageBps = 100, options = {}) {
  const wallet = getWallet();
  const balance = await getTokenBalance(wallet.publicKey, tokenMint);
  const amount  = typeof balance === 'string' ? balance : balance.toString();
  if (!amount || amount === '0') {
    return { skipped: true, reason: `No balance for ${tokenMint.slice(0, 8)}...` };
  }
  return swapToSOL(tokenMint, amount, slippageBps, options);
}
