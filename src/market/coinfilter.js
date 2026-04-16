import { fetchWithTimeout, safeNum, withExponentialBackoff } from '../utils/safeJson.js';
import { getConfig } from '../config.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { getGmgnTokenInfo, getGmgnSecurity } from '../utils/gmgn.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const JUPITER_TOKEN_BASE = 'https://tokens.jup.ag';
const JUPITER_PRICE_BASE = 'https://api.jup.ag';

// ─── Narrative patterns ──────────────────────────────────────────

const POLITICAL_PATTERNS = [
  /\btrump\b/i, /\belon\b/i, /\bbaron\b/i, /\bmelania\b/i, /\bbiden\b/i,
  /\bmaga\b/i, /\bkamala\b/i, /\bpolitical\b/i,
];
const CELEBRITY_PATTERNS = [
  /\bkanye\b/i, /\btaylor swift\b/i, /\bkardashian\b/i,
];
const JUSTICE_PATTERNS = [
  /justice for/i, /save the/i, /\brip\b/i, /remember /i,
];
const CTO_PATTERNS = [
  /\bcto\b/i, /community takeover/i,
];

// ─── Data fetchers ───────────────────────────────────────────────

async function getDexScreenerInfo(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) =>
      safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd)
    )[0];
    const txns1h = best.txns?.h1 || {};
    const txns24h = best.txns?.h24 || {};
    return {
      name: best.baseToken?.name || '',
      symbol: best.baseToken?.symbol || '',
      hasImage: !!(best.info?.imageUrl),
      hasSocials: !!(best.info?.socials?.length > 0 || best.info?.websites?.length > 0),
      liquidity: safeNum(best.liquidity?.usd),
      fdv: safeNum(best.fdv),
      priceChangeM5: safeNum(best.priceChange?.m5),
      priceChange1h: safeNum(best.priceChange?.h1),
      priceChange6h: safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      volume24h: safeNum(best.volume?.h24),
      priceUsd: safeNum(best.priceUsd),
      buys1h: safeNum(txns1h.buys),
      sells1h: safeNum(txns1h.sells),
      buys24h: safeNum(txns24h.buys),
      sells24h: safeNum(txns24h.sells),
      pairCreatedAt: best.pairCreatedAt || null, // ms timestamp
    };
  } catch { return null; }
}

async function getJupiterData(tokenMint) {
  try {
    const [tokenRes, priceRes] = await Promise.allSettled([
      fetchWithTimeout(`${JUPITER_TOKEN_BASE}/token/${tokenMint}`, {}, 8000),
      fetchWithTimeout(`${JUPITER_PRICE_BASE}/price/v2?ids=${tokenMint}`, {}, 8000),
    ]);
    const tokenData = tokenRes.status === 'fulfilled' && tokenRes.value.ok
      ? await tokenRes.value.json().catch(() => null) : null;
    const priceData = priceRes.status === 'fulfilled' && priceRes.value.ok
      ? await priceRes.value.json().catch(() => null) : null;
    const priceInfo = priceData?.data?.[tokenMint];
    return {
      found: !!tokenData,
      name: tokenData?.name,
      symbol: tokenData?.symbol,
      tags: tokenData?.tags || [],
      isStrict: !!(tokenData?.tags?.includes('strict')),
      isVerified: !!(tokenData?.tags?.includes('verified')),
      isPumpFun: !!(tokenData?.tags?.includes('pump-fun') || tokenData?.tags?.includes('pumpfun')),
      priceUsd: safeNum(priceInfo?.price),
    };
  } catch { return null; }
}

// ─── Step functions ──────────────────────────────────────────────

function step1_basicValidation(dex, jup) {
  const rejects = [];
  const warnings = [];
  if (!dex) {
    rejects.push({ rule: 'NO_DEXSCREENER_DATA', msg: 'Token tidak ditemukan di DexScreener' });
    return { rejects, warnings };
  }
  if (!dex.hasImage) rejects.push({ rule: 'NO_LOGO', msg: 'Token tidak punya logo — REJECT' });
  if (!dex.hasSocials) warnings.push({ rule: 'NO_SOCIAL_LINKS', msg: 'Token tidak punya social links — perlu verifikasi manual' });
  return { rejects, warnings };
}

function step2_narrativeFilter(name, symbol) {
  const rejects = [];
  const text = `${name} ${symbol}`.toLowerCase();
  for (const p of POLITICAL_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'POLITICAL_FIGURE', msg: `Political coin: "${name}" — slow rug pattern` }); break; }
  for (const p of CELEBRITY_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'CELEBRITY_COIN', msg: `Celebrity coin: "${name}" — dev bisa dump kapan saja` }); break; }
  for (const p of JUSTICE_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'JUSTICE_NARRATIVE', msg: `"Justice/save" narrative: "${name}" — classic rug` }); break; }
  for (const p of CTO_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'CTO_COIN', msg: `CTO coin: "${name}" — new dev farm fees dan dump` }); break; }
  return rejects;
}

function step3_priceHealth(dex, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  if (!dex) return { rejects, warnings };

  if (dex.priceChange1h < -20)
    warnings.push({ rule: 'HEAVY_DUMP_1H', msg: `Harga turun ${dex.priceChange1h}% (1h) — Risiko tinggi, tapi peluang serok buat Panda` });
  else if (dex.priceChange1h < -10)
    warnings.push({ rule: 'PRICE_CORRECTION', msg: `Harga terkoreksi ${dex.priceChange1h}% (1h) — Monitor area support` });

  if (dex.liquidity < 10000)
    rejects.push({ rule: 'LOW_LIQUIDITY', msg: `Liquidity $${dex.liquidity.toFixed(0)} (<$10k) — pool terlalu kecil, risiko slippage ekstrem` });
  else if (dex.liquidity < 20000)
    warnings.push({ rule: 'THIN_LIQUIDITY', msg: `Liquidity $${dex.liquidity.toFixed(0)} ($10k-$20k) — tipis, perhatikan slippage` });

  if (dex.priceChange24h > 250)
    warnings.push({ rule: 'BUBBLE_DETECTED', msg: `Harga naik ${dex.priceChange24h.toFixed(0)}% dalam 24h — Volatilitas masif, siap meraup fee` });

  return { rejects, warnings };
}

// ─── Step 4: Token Minimum Age ──────────────────────────────────
// Reject tokens that are too new — early minutes have extreme dump risk from
// bundlers/insiders who bought before launch. Wait for initial distribution to settle.
function step4_tokenAge(dex, minAgeMinutes = 60) {
  const rejects = [];
  if (!dex?.pairCreatedAt) return { rejects }; // Data tidak tersedia → skip

  const ageMs = Date.now() - dex.pairCreatedAt;
  const ageMinutes = Math.floor(ageMs / (1000 * 60));

  // Format tampilan yang mudah dibaca (jam + menit)
  const fmtDuration = (mins) => {
    if (mins < 60) return `${mins} menit`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} jam ${m} menit` : `${h} jam`;
  };

  if (ageMinutes < minAgeMinutes) {
    rejects.push({
      rule: 'TOKEN_TOO_NEW',
      msg: `Token baru ${fmtDuration(ageMinutes)} sejak launch — minimal ${fmtDuration(minAgeMinutes)} setelah launch`,
    });
  }

  return { rejects, ageMinutes };
}

function step5_txnAnalysis(dex) {
  const rejects = [];
  const warnings = [];
  if (!dex) return { rejects, warnings };

  const total1h = dex.buys1h + dex.sells1h;
  if (total1h > 10) {
    const sellRatio = dex.sells1h / total1h;
    // Sniper Hardening: Ubah jadi Warning biar Panda bisa deteksi capitulation
    if (sellRatio > 0.70)
      warnings.push({ rule: 'EXTREME_SELLING_1H', msg: `${(sellRatio * 100).toFixed(0)}% txn h1 adalah SELL — Potensi capitulation/serok bawah` });
    else if (sellRatio > 0.60)
      warnings.push({ rule: 'HEAVY_SELLING_1H', msg: `${(sellRatio * 100).toFixed(0)}% txn h1 adalah SELL` });
  }

  // Anti-Wash Trading Guard (Volume : TVL Ratio)
  if (dex.volume24h && dex.liquidity && dex.liquidity > 0) {
    const volTvlRatio = dex.volume24h / dex.liquidity;
    if (volTvlRatio >= 100) {
      rejects.push({ rule: 'WASH_TRADING_DETECTED', msg: `Rasio Vol/TVL tidak wajar (${volTvlRatio.toFixed(1)}x) — Indikasi kuat bot wash trading / thin liquidity trap` });
    }
  }

  // Final Spike Protection: Berubah ke warning agar bisa jaring koin liar
  if (dex.priceChangeM5 > 15)
    warnings.push({ rule: 'PRICE_SPIKE_M5', msg: `Harga meledak ${dex.priceChangeM5.toFixed(1)}% dlm 5 menit — Momentum kuat, siap tangkap volatilitas` });

  return { rejects, warnings };
}

function step6_tokenSafety(jup) {
  const rejects = [];
  const warnings = [];
  if (jup?.isPumpFun)
    warnings.push({ rule: 'PUMP_FUN', msg: 'Token dari pump.fun — high-risk launchpad' });
  if (jup && !jup.isStrict && !jup.isVerified)
    warnings.push({ rule: 'UNVERIFIED', msg: 'Token belum masuk Jupiter Strict List' });
  return { rejects, warnings };
}

function step7_organicScore(dex, jup, thresholds) {
  const rejects = [];
  const warnings = [];
  const minOrganic = thresholds.minOrganic;
  let score = 0;

  if (dex?.hasImage) score += 10;
  if (dex?.hasSocials) score += 10;
  if (jup?.isStrict) score += 15;

  if (dex) {
    if (dex.volume24h >= 1000000) score += 30; // Volume Sultan
    else if (dex.volume24h >= 100000) score += 20;
    else if (dex.volume24h >= 50000) score += 10;

    if ((dex.buys24h + dex.sells24h) >= 500) score += 20; // Pool super aktif
    else if ((dex.buys24h + dex.sells24h) >= 100) score += 10;

    // --- UPGRADE: Volume-to-TVL Ratio Penalty (Anti-Wash Trading) ---
    if (dex.volume24h > 0 && dex.liquidityUsd > 0) {
      const ratio = dex.volume24h / dex.liquidityUsd;
      const maxRatio = thresholds.maxVolumeTvlRatio || 70;
      if (ratio > maxRatio) {
        score -= 50; // Penalti berat jika sudah lewat batas aman
      } else if (ratio > (maxRatio / 2)) {
        score -= 25; // Penalti menengah jika rasio mulai tidak wajar
      }
    }
  }

  if (dex) {
    if (dex.priceChange1h >= -10) score += 15;
  }

  score = Math.max(0, Math.min(100, score));

  if (score < minOrganic)
    rejects.push({ rule: 'LOW_ORGANIC_SCORE', msg: `Organic score: ${score}/100 (<${minOrganic})` });

  return { rejects, warnings, score };
}

function step9_mcapFilter(dexFdv, thresholds) {
  const rejects = [];
  const minMcap = thresholds.minMcap;
  const maxMcap = thresholds.maxMcap;
  const mcap = dexFdv || null;

  if (mcap === null) {
    rejects.push({ rule: 'MISSING_MCAP', msg: 'Data Market Cap tidak tersedia (Kosong) — Risiko dev belum revoke mint atau data on-chain cacat' });
    return { rejects, mcap: null, skipped: false };
  }

  if (minMcap > 0 && mcap < minMcap)
    rejects.push({ rule: 'BELOW_MIN_MCAP', msg: `Mcap $${mcap.toLocaleString()} < min $${minMcap.toLocaleString()}` });
  if (maxMcap > 0 && mcap > maxMcap)
    rejects.push({ rule: 'ABOVE_MAX_MCAP', msg: `Mcap $${mcap.toLocaleString()} > max $${maxMcap.toLocaleString()}` });

  return { rejects, mcap, skipped: false };
}

// ─── Main filter function ────────────────────────────────────────

async function getOnChainAuthority(tokenMint) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    console.warn('⚠️ Helius API Key missing. Skipping authority checks (failing-safe).');
    return { mutable: true, mintAuthority: true, freezeAuthority: true };
  }

  try {
    const res = await fetchWithTimeout(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'auth-check',
          method: 'getAccountInfo',
          params: [tokenMint, { encoding: 'jsonParsed' }]
        })
      },
      8000
    );

    if (!res.ok) {
      console.error(`❌ Helius RPC Error: ${res.status} ${res.statusText}`);
      return { mutable: true, mintAuthority: true, freezeAuthority: true };
    }

    const data = await res.json();
    const parsed = data.result?.value?.data?.parsed?.info;

    if (!parsed) {
      console.warn(`⚠️ Helius: Account info not found for ${tokenMint.slice(0, 8)}. Likely burned or wrong mint.`);
      return { mutable: true, mintAuthority: true, freezeAuthority: true };
    }

    return {
      mintAuthority: !!parsed.mintAuthority,
      freezeAuthority: !!parsed.freezeAuthority,
      isInitialized: !!parsed.isInitialized,
      supply: safeNum(parsed.supply),
      decimals: safeNum(parsed.decimals)
    };
  } catch (e) {
    console.error(`❌ getOnChainAuthority failed for ${tokenMint.slice(0, 8)}:`, e.message);
    return { mutable: true, mintAuthority: true, freezeAuthority: true };
  }
}

async function getSlippageSimulation(tokenMint, amountSol) {
  try {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const amountLamports = Math.floor(amountSol * 1_000_000_000);

    // --- 1. Simulation Beli (SOL -> Token) ---
    const buyData = await withExponentialBackoff(async () => {
      try {
        const res = await fetchWithTimeout(
          `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL}&outputMint=${tokenMint}&amount=${amountLamports}&slippageBps=100`,
          {}, 15000
        );
        if (!res.ok) throw new Error(`BUY_HTTP_${res.status}`);
        return await res.json();
      } catch (e) {
        if (e.message.includes('ENOTFOUND') || e.message.includes('ETIMEDOUT')) {
          throw new Error('NETWORK_ERROR');
        }
        throw e;
      }
    }, { maxRetries: 2, baseDelay: 1000 });

    // --- 2. Simulation Jual (Token -> SOL) - Honeypot Check ---
    const sellData = await withExponentialBackoff(async () => {
      try {
        const res = await fetchWithTimeout(
          `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=${WSOL}&amount=${buyData.outAmount}&slippageBps=100`,
          {}, 15000
        );
        if (!res.ok) {
          if (res.status === 400) return { error: 'Honeypot/No-Liquidity-Back' };
          throw new Error(`SELL_HTTP_${res.status}`);
        }
        return await res.json();
      } catch (e) {
        if (e.message.includes('ENOTFOUND') || e.message.includes('ETIMEDOUT')) {
          throw new Error('NETWORK_ERROR');
        }
        throw e;
      }
    }, { maxRetries: 1, baseDelay: 1000 }).catch(err => ({ error: err.message }));

    return {
      priceImpactBuy: parseFloat(buyData.priceImpactPct || 0),
      priceImpactSell: parseFloat(sellData?.priceImpactPct || 0),
      sellError: sellData?.error,
      isSimFailure: (sellData?.error === 'NETWORK_ERROR'),
      networkError: (sellData?.error === 'NETWORK_ERROR')
    };
  } catch (e) {
    if (e.message === 'NETWORK_ERROR') {
      console.warn(`🌐 Jupiter API unreachable (ENOTFOUND) for ${tokenMint.slice(0, 8)}. Skipping slippage check.`);
      return {
        priceImpactBuy: 0,
        priceImpactSell: 0,
        networkError: true,
        isSimFailure: true
      };
    }
    console.error(`❌ getSlippageSimulation failed for ${tokenMint.slice(0, 8)}:`, e.message);
    return {
      priceImpactBuy: 0,
      priceImpactSell: 0,
      simError: true,
      isSimFailure: true
    };
  }
}

// ─── Step functions ──────────────────────────────────────────────

function step10_authorityCheck(auth) {
  const rejects = [];
  if (auth.mintAuthority) rejects.push({ rule: 'MINT_AUTH_ACTIVE', msg: 'Mint authority masih aktif — dev bisa cetak token baru' });
  if (auth.freezeAuthority) rejects.push({ rule: 'FREEZE_AUTH_ACTIVE', msg: 'Freeze authority masih aktif — wallet bisa di-lock' });
  return rejects;
}

function step11_slippageCheck(sim, maxImpact = 2.5) {
  const rejects = [];
  const warnings = [];
  if (!sim) {
    warnings.push({ rule: 'SIM_FAILED', msg: 'Gagal simulasi slippage — proceed with caution' });
    return { rejects, warnings };
  }

  if (sim.sellError && !sim.isSimFailure) {
    rejects.push({ rule: 'HONEYPOT_DETECTED', msg: `Honeypot risk! Simulasi jual gagal: ${sim.sellError}` });
  } else if (sim.isSimFailure) {
    warnings.push({ rule: 'SIM_SELL_FAILED', msg: 'Gagal simulasi jual (Network/Timeout) — Honeypot check tidak konklusif' });
  }

  if (sim.priceImpactBuy > maxImpact) {
    rejects.push({ rule: 'HIGH_PRICE_IMPACT_BUY', msg: `Price impact beli ${sim.priceImpactBuy.toFixed(2)}% > ${maxImpact}% — likuiditas terlalu tipis` });
  }

  if (sim.priceImpactSell > Math.max(10, maxImpact * 10)) {
    rejects.push({ rule: 'HIGH_PRICE_IMPACT_SELL', msg: `Price impact jual ${sim.priceImpactSell.toFixed(2)}% — indikasi pajak jual tinggi atau likuiditas satu arah` });
  }

  return { rejects, warnings };
}

function step13_volumeTurnoverRatio(dex, thresholds) {
  const rejects = [];
  const maxRatio = thresholds.maxVolumeTvlRatio || 150; // Increased from 70 to 150 for Hyper-Active pools

  if (dex && dex.volume24h && dex.liquidityUsd > 0) {
    const ratio = dex.volume24h / dex.liquidityUsd;
    if (ratio > maxRatio) {
      rejects.push({
        rule: 'VOLUME_TO_TVL_ANOMALY',
        msg: `Rasio Vol/TVL tidak wajar (${ratio.toFixed(1)}x > ${maxRatio}x) — Indikasi kuat bot wash trading / thin liquidity trap`
      });
    }
  }
  return rejects;
}

function step14_feeIntegrity(dex, solPrice, thresholds) {
  const rejects = [];
  const minFeesSol = thresholds.minTokenFeesSol || 0;

  if (minFeesSol > 0 && dex && dex.fees24h && solPrice > 0) {
    const feesSol = dex.fees24h / solPrice;
    if (feesSol < minFeesSol) {
      rejects.push({
        rule: 'FEE_VOLUME_INSUFFICIENT',
        msg: `Total Fee 24 jam rendah (${feesSol.toFixed(2)} SOL < ${minFeesSol} SOL) — Volume terdeteksi kurang organik`
      });
    }
  }
  return rejects;
}

// ─── Step 12: GMGN On-Chain Security ─────────────────────────────
// "Trip Wire" logic: rejects only when GMGN CONFIRMS a bad signal.
// null values = data unavailable = proceed (no blocking on absence of evidence).

function step12_gmgnSecurity(info, sec) {
  const rejects = [];
  const warnings = [];

  // No data from either endpoint → skip entirely
  if (!info && !sec) return { rejects, warnings };

  // ─── From token info ─────────────────────────────────────────
  if (info) {
    // CTO Coin (Community Takeover) — original dev abandoned, risky in early phase
    if (info.dev?.cto_flag === 1) {
      rejects.push({ rule: 'GMGN_CTO_COIN', msg: 'CTO Coin (dev.cto_flag=1) — dev original kabur, risiko manipulasi oleh komunitas/dev baru' });
    }

    // Phishing / Entrapment trader pattern
    const entrapment = info.stat?.top_entrapment_trader_percentage;
    if (entrapment != null && entrapment > 0.30) {
      rejects.push({ rule: 'GMGN_PHISHING_RISK', msg: `Entrapment traders ${(entrapment * 100).toFixed(1)}% > 30% — pola jebakan terorganisir` });
    }

    // Top 10 concentration
    const top10 = info.stat?.top_10_holder_rate;
    if (top10 != null && top10 > 0.35) {
      rejects.push({ rule: 'GMGN_TOP10_CONCENTRATED', msg: `Top 10 holders ${(top10 * 100).toFixed(1)}% > 35% — risiko whale dump` });
    }
  }

  // ─── From token security ──────────────────────────────────────
  if (sec) {
    // Mint authority not renounced (GMGN Signal)
    if (sec.renounced_mint === false) {
      rejects.push({ rule: 'GMGN_MINT_NOT_RENOUNCED', msg: 'Mint authority aktif (Honeypot Risk) — dev bisa cetak supply baru' });
    }

    // Freeze authority not renounced (GMGN Signal)
    if (sec.renounced_freeze_account === false) {
      rejects.push({ rule: 'GMGN_FREEZE_NOT_RENOUNCED', msg: 'Freeze authority aktif (Honeytrap Risk) — wallet bisa di-lock dev' });
    }

    // Shadow Wallets / Suspected Insiders (HARD REJECT L6)
    const suspectedInsider = sec.suspected_insider_hold_rate;
    if (suspectedInsider != null && suspectedInsider > 0.15) {
      rejects.push({ rule: 'GMGN_SHADOW_WALLETS', msg: `Shadow Wallets (Insiders) memegang ${(suspectedInsider * 100).toFixed(1)}% supply — REJECT` });
    }

    // Rat Traders / Insider Front-running (HARD REJECT L6)
    const insiderRate = sec.rat_trader_amount_rate;
    if (insiderRate != null && insiderRate > 0) {
      rejects.push({ rule: 'GMGN_INSIDER_DETECTED', msg: `Insider/rat trader terdeteksi di volume (${(insiderRate * 100).toFixed(1)}%) — REJECT` });
    }

    // Bundling (Tighter threshold 50%)
    const bundlerRate = sec.bundler_trader_amount_rate;
    if (bundlerRate != null && bundlerRate > 0.50) {
      rejects.push({ rule: 'GMGN_BUNDLED', msg: `Bundling ${(bundlerRate * 100).toFixed(1)}% > 50% — dominasi gerombolan tertentu` });
    }

    // LP burn status
    if (sec.burn_status != null && sec.burn_status !== '' && sec.burn_status !== 'burn') {
      rejects.push({ rule: 'GMGN_LP_NOT_BURNED', msg: `LP tidak dibakar (status: "${sec.burn_status}") — risiko tarik likuiditas (Rug)` });
    }

    // Rug risk score
    const rugRatio = sec.rug_ratio;
    if (rugRatio != null && rugRatio > 0.30) {
      rejects.push({ rule: 'GMGN_RUG_HISTORY', msg: `Rug risk score ${rugRatio.toFixed(2)} > 0.30 — deployer mencurigakan` });
    }

    // 🎭 METADATA SECURITY: Anti-Bunglon (Hard Reject)
    if (sec.is_mutable_metadata === true) {
      rejects.push({ rule: 'GMGN_MUTABLE_METADATA', msg: 'Metadata koin masih bisa diubah (Mutable) — risiko ganti nama/logo/symbol di tengah jalan' });
    }

    // 💸 ZERO TAX SHIELD: Anti-Pajak Siluman (Irit Mode Level Max)
    const buyTax = parseFloat(sec.buy_tax || 0);
    const sellTax = parseFloat(sec.sell_tax || 0);
    if (buyTax > 0 || sellTax > 0) {
      rejects.push({ rule: 'GMGN_TAX_DETECTED', msg: `Pajak terdeteksi (Beli: ${buyTax}%, Jual: ${sellTax}%) — Gak Irit, skip!` });
    }

    // 🍯 HONEYPOT GUARD: Anti-Jebakan (Hard Reject)
    if (sec.is_honeypot === true) {
      rejects.push({ rule: 'GMGN_HONEYPOT', msg: 'Honeypot terdeteksi! Koin tidak bisa dijual — REJECT' });
    }

    // 🎭 WASH-TRADE GUARD: Anti-Volume Palsu
    const washRate = parseFloat(sec.wash_trading_percentage || 0);
    if (washRate > 35) {
      rejects.push({ rule: 'GMGN_WASH_TRADE', msg: `Wash trading tinggi (${washRate.toFixed(1)}%) — manipulasi volume oleh dev` });
    }
  }

  return { rejects, warnings };
}

// ─── Main filter function ────────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '', opts = {}) {
  const cfg = getConfig();
  const thresholds = {
    minMcap: cfg.minMcap,
    maxMcap: cfg.maxMcap,
    minVolume24h: cfg.minVolume24h,
    minOrganic: cfg.minOrganic,
    maxImpact: cfg.maxPriceImpactPct,
    maxVolumeTvlRatio: cfg.maxVolumeTvlRatio,
    minTokenFeesSol: cfg.minTokenFeesSol,
  };

  const deployAmount = cfg.deployAmountSol || 0.1;

  const [dexResult, jupResult, authResult, simResult, gmgnInfoResult, gmgnSecResult, solPriceResult] = await Promise.allSettled([
    getDexScreenerInfo(tokenMint),
    getJupiterData(tokenMint),
    getOnChainAuthority(tokenMint),
    getSlippageSimulation(tokenMint, deployAmount),
    getGmgnTokenInfo(tokenMint),
    getGmgnSecurity(tokenMint),
    getJupiterPrice('So11111111111111111111111111111111111111112'),
  ]);

  const dex  = dexResult.status  === 'fulfilled' ? dexResult.value  : null;
  const jup  = jupResult.status  === 'fulfilled' ? jupResult.value  : null;
  const auth = authResult.status === 'fulfilled' ? authResult.value : { mintAuthority: true, freezeAuthority: true };
  const sim  = simResult.status  === 'fulfilled' ? simResult.value  : null;
  const solPrice = solPriceResult.status === 'fulfilled' ? solPriceResult.value : 0;

  // ─── GMGN API Health Logic ────────────────────────────────────
  const hasGmgnKey = !!process.env.GMGN_API_KEY;
  let gmgnStatus = 'ACTIVE';

  if (!hasGmgnKey) {
    gmgnStatus = 'DISABLED';
  } else if (gmgnInfoResult.status === 'rejected' || gmgnSecResult.status === 'rejected') {
    gmgnStatus = 'ERROR';
  } else if (!gmgnInfoResult.value && !gmgnSecResult.value) {
    gmgnStatus = 'UNKNOWN';
  }

  const gmgnInfo = gmgnInfoResult.status === 'fulfilled' ? gmgnInfoResult.value : null;
  const gmgnSec  = gmgnSecResult.status  === 'fulfilled' ? gmgnSecResult.value  : null;

  const name   = tokenName   || dex?.name   || jup?.name   || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  const s1  = step1_basicValidation(dex, jup);
  const s2  = step2_narrativeFilter(name, symbol);
  const s3  = step3_priceHealth(dex, thresholds);
  const s4  = step4_tokenAge(dex, cfg.minTokenAgeMinutes || 60);
  const s5  = step5_txnAnalysis(dex);
  const s6  = step6_tokenSafety(jup);
  const s7  = step7_organicScore(dex, jup, thresholds);
  const s12 = step12_gmgnSecurity(gmgnInfo, gmgnSec);
  const s13 = step13_volumeTurnoverRatio(dex, thresholds);
  const s14 = step14_feeIntegrity(dex, solPrice, thresholds);

  // Obelisk Handle: Manual MCAP calculation if DexScreener is lagging
  let mcap = dex?.fdv || null;
  if (!mcap && auth?.supply && auth?.decimals) {
    const rawPrice = dex?.priceUsd || (jup?.found ? await getJupiterPrice(tokenMint) : 0);
    if (rawPrice > 0) {
      const supplyFixed = auth.supply / Math.pow(10, auth.decimals);
      mcap = rawPrice * supplyFixed;
    }
  }

  const s9  = step9_mcapFilter(mcap, thresholds);
  const s10 = step10_authorityCheck(auth);
  const s11 = step11_slippageCheck(sim, thresholds.maxImpact);

  const allRejects = [
    ...s1.rejects,  // Logo filter REINSTATED as Hard Reject
    ...s2,          
    ...s3.rejects,  
    ...s4.rejects,
    ...s5.rejects,  
    ...s6.rejects,  
    ...s7.rejects,  
    ...s9.rejects,
    ...s10,         
    ...s11.rejects, 
    // ...s12.rejects, <-- GMGN Security stays as Warning (Fees = Security)
    ...s13, 
    ...s14, // minTokenFeesSol Gate
  ];
  const allWarnings = [
    ...s1.warnings, 
    ...s3.warnings, 
    ...s5.warnings, 
    ...s6.warnings, 
    ...s11.warnings, 
    ...s12.warnings, 
    ...s12.rejects,  // GMGN security stays here
  ];

  let verdict = allRejects.length > 0 ? 'AVOID' : (allWarnings.length > 0 ? 'CAUTION' : 'PASS');

  return {
    tokenMint, name, symbol, verdict, eligible: allRejects.length === 0,
    highFlags: allRejects, mediumFlags: allWarnings,
    organicScore: s7.score, mcap: s9.mcap,
    tokenAgeMinutes: s4.ageMinutes ?? null,
    priceImpact: sim?.priceImpactBuy,
    priceImpactSell: sim?.priceImpactSell,
    devAddress: gmgnInfo?.dev?.creator_address || gmgnInfo?.creator_address || null,
    gmgnStatus, // ACTIVE, DISABLED, ERROR, UNKNOWN
    gmgnRejects: s12.rejects,
    gmgnWarnings: s12.warnings,
    sources: {
      dexscreener: !!dex,
      jupiter: !!(jup?.found),
      helius: (authResult.status === 'fulfilled'),
      gmgn: (gmgnStatus === 'ACTIVE'),
    },
  };
}

export function formatScreenResult(result) {
  const fmtDuration = (mins) => {
    if (mins == null) return 'N/A';
    if (mins < 60) return `${mins} menit`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} jam ${m} menit` : `${h} jam`;
  };

  const emoji = { AVOID: '🚫', CAUTION: '👀', PASS: '✅' }[result.verdict] || '❓';
  let text = `${emoji} *${result.name}* (${result.symbol}) — ${result.eligible ? 'ELIGIBLE' : 'AVOID'}\n`;
  text += `📊 Organic score: *${result.organicScore}/100*\n`;
  if (result.mcap) text += `💰 Mcap: $${result.mcap.toLocaleString()}\n`;
  if (result.tokenAgeMinutes != null) text += `⏱ Usia token: ${fmtDuration(result.tokenAgeMinutes)}\n`;

  // ─── GMGN Security Block ──────────────────────────────────────
  if (result.gmgnStatus === 'DISABLED') {
    text += `\n🛡️ *GMGN Security: 🔌 Disabled*\n`;
    text += `_API key tidak ditemukan. Set GMGN_API_KEY di .env._\n`;
  } else if (result.gmgnStatus === 'ERROR') {
    text += `\n🛡️ *GMGN Security: ⚠️ API Error*\n`;
    text += `_Request ke GMGN gagal (timeout/down)._\n`;
  } else if (result.gmgnStatus === 'UNKNOWN') {
    text += `\n🛡️ *GMGN Security: ❓ Unknown*\n`;
    text += `_Koin tidak ditemukan di database GMGN._\n`;
  } else if (result.gmgnRejects?.length > 0) {
    text += `\n🛡️ *GMGN Security: ⛔ Ditolak (${result.gmgnRejects.length} masalah):*\n`;
    result.gmgnRejects.forEach(f => text += `• ${f.msg}\n`);
    if (result.gmgnWarnings?.length > 0) {
      text += `🛡️ *GMGN Peringatan:*\n`;
      result.gmgnWarnings.forEach(f => text += `• ${f.msg}\n`);
    }
  } else if (result.gmgnWarnings?.length > 0) {
    text += `\n🛡️ *GMGN Security: ⚠️ Peringatan (${result.gmgnWarnings.length}):*\n`;
    result.gmgnWarnings.forEach(f => text += `• ${f.msg}\n`);
  } else {
    text += `\n🛡️ *GMGN Security: 🛡️ Active (Clean)*\n`;
  }

  // ─── Reject & Warning Flags (non-GMGN) ───────────────────────
  const nonGmgnRejects = (result.highFlags || []).filter(f => !f.rule?.startsWith('GMGN_'));
  const nonGmgnWarnings = (result.mediumFlags || []).filter(f => !f.rule?.startsWith('GMGN_'));

  if (nonGmgnRejects.length > 0) {
    text += `\n🔴 *Ditolak (${nonGmgnRejects.length}):*\n`;
    nonGmgnRejects.forEach(f => text += `• ${f.msg}\n`);
  }
  if (nonGmgnWarnings.length > 0) {
    text += `\n🟡 *Peringatan (${nonGmgnWarnings.length}):*\n`;
    nonGmgnWarnings.forEach(f => text += `• ${f.msg}\n`);
  }

  if (result.eligible) text += `\n✅ Lolos semua filter — Eligible for DLMM.`;

  if (result.sources) {
    const srcList = Object.entries(result.sources).filter(([, v]) => v).map(([k]) => k).join(', ');
    text += `\n\n_Sources: ${srcList}_`;
  }
  return text;
}
