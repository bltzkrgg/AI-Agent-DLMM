/**
 * Coin Filter — SOL_DLMM_COIN_FILTER
 *
 * 7-step filter. GMGN diganti sepenuhnya dengan data sources yang aktif.
 * Kriteria hard rejection dari Meridian research:
 *   - Top-10 concentration >60%, organic score <60
 *   - Harga dump >15% dalam 1h, holder count <200
 *   - Honeypot, high risk (OKX), nama politik/celebrity/CTO
 *
 * Steps:
 *   1. basic_validation   — logo + socials (DexScreener)
 *   2. narrative_filter   — political / celebrity / justice / viral / CTO
 *   3. price_health       — 1h dump, min liquidity, pair age (DexScreener)
 *   4. holder_check       — top-10 concentration, holder count (BirdEye)
 *   5. txn_analysis       — buy/sell ratio, bot activity proxy (DexScreener)
 *   6. token_safety       — honeypot, mintable, pump.fun (OKX + Jupiter)
 *   7. organic_score      — composite score <60 = REJECT
 */

import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';

const DEXSCREENER_BASE   = 'https://api.dexscreener.com';
const JUPITER_TOKEN_BASE = 'https://tokens.jup.ag';
const JUPITER_PRICE_BASE = 'https://api.jup.ag';
const OKX_BASE           = 'https://www.okx.com/api/v5';

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
const VIRAL_ANIMAL_PATTERNS = [
  /\bmoo deng\b/i, /\bpeanut\b/i, /\btiktok\b/i,
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
    const txns1h  = best.txns?.h1  || {};
    const txns24h = best.txns?.h24 || {};
    return {
      name:           best.baseToken?.name   || '',
      symbol:         best.baseToken?.symbol || '',
      hasImage:       !!(best.info?.imageUrl),
      hasSocials:     !!(best.info?.socials?.length > 0 || best.info?.websites?.length > 0),
      liquidity:      safeNum(best.liquidity?.usd),
      fdv:            safeNum(best.fdv),
      priceChange1h:  safeNum(best.priceChange?.h1),
      priceChange6h:  safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      volume24h:      safeNum(best.volume?.h24),
      buys1h:         safeNum(txns1h.buys),
      sells1h:        safeNum(txns1h.sells),
      buys24h:        safeNum(txns24h.buys),
      sells24h:       safeNum(txns24h.sells),
      pairCreatedAt:  best.pairCreatedAt || null, // ms timestamp
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
      found:      !!tokenData,
      name:       tokenData?.name,
      symbol:     tokenData?.symbol,
      tags:       tokenData?.tags || [],
      isStrict:   !!(tokenData?.tags?.includes('strict')),
      isVerified: !!(tokenData?.extensions?.coingeckoId || tokenData?.tags?.includes('verified')),
      isPumpFun:  !!(tokenData?.tags?.includes('pump-fun') || tokenData?.tags?.includes('pumpfun')),
      priceUsd:   priceInfo?.price || null,
    };
  } catch { return null; }
}

async function getHolderData(tokenMint) {
  if (!process.env.HELIUS_API_KEY) return null;
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  const rpcPost = (method, params) => fetchWithTimeout(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 8000);

  try {
    const [largestRes, supplyRes] = await Promise.allSettled([
      rpcPost('getTokenLargestAccounts', [tokenMint]),
      rpcPost('getTokenSupply',          [tokenMint]),
    ]);

    const largest = largestRes.status === 'fulfilled' && largestRes.value.ok
      ? (await largestRes.value.json().catch(() => ({}))).result?.value || [] : [];
    const supply  = supplyRes.status  === 'fulfilled' && supplyRes.value.ok
      ? (await supplyRes.value.json().catch(() => ({}))).result?.value : null;

    if (!largest.length || !supply) return null;

    const totalSupply  = safeNum(supply.uiAmount || 0);
    if (totalSupply === 0) return null;

    const top10Amount  = largest.slice(0, 10).reduce((s, h) => s + safeNum(h.uiAmount || 0), 0);
    const top10Pct     = (top10Amount / totalSupply) * 100;

    return {
      available:      true,
      holderCount:    null, // tidak tersedia via free RPC — step4 handle gracefully
      top10HolderPct: parseFloat(top10Pct.toFixed(2)),
    };
  } catch { return null; }
}

async function getOKXSafety(tokenMint) {
  if (!process.env.OKX_API_KEY) return null;
  const headers = { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'Content-Type': 'application/json' };
  try {
    const res = await fetchWithTimeout(
      `${OKX_BASE}/dex/security/token?chainId=501&tokenContractAddress=${tokenMint}`,
      { headers }, 8000
    );
    if (!res.ok) return null;
    const sec = (await res.json().catch(() => ({}))).data?.[0] || {};
    return {
      available:          true,
      isHoneypot:         sec.isHoneypot         ?? false,
      isMintable:         sec.isMintable          ?? false,
      ownershipRenounced: sec.ownershipRenounced  ?? null,
      riskLevel:          sec.riskLevel           ?? null,
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
  if (!dex.hasImage)   rejects.push({ rule: 'NO_LOGO',         msg: 'Token tidak punya logo — REJECT' });
  if (!dex.hasSocials) rejects.push({ rule: 'NO_SOCIAL_LINKS', msg: 'Token tidak punya social links — REJECT' });
  if (jup && !jup.found)
    warnings.push({ rule: 'NOT_ON_JUPITER', msg: 'Token belum terdaftar di Jupiter — likuiditas terbatas' });
  return { rejects, warnings };
}

function step2_narrativeFilter(name, symbol) {
  const rejects = [];
  const text = `${name} ${symbol}`.toLowerCase();
  for (const p of POLITICAL_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'POLITICAL_FIGURE', msg: `Political coin: "${name}" — slow rug pattern` }); break; }
  for (const p of CELEBRITY_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'CELEBRITY_COIN',   msg: `Celebrity coin: "${name}" — dev bisa dump kapan saja` }); break; }
  for (const p of JUSTICE_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'JUSTICE_NARRATIVE', msg: `"Justice/save" narrative: "${name}" — classic rug` }); break; }
  for (const p of VIRAL_ANIMAL_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'VIRAL_ANIMAL', msg: `Viral animal/TikTok meme: "${name}" — hype-driven, rug cepat` }); break; }
  for (const p of CTO_PATTERNS)
    if (p.test(text)) { rejects.push({ rule: 'CTO_COIN', msg: `CTO coin: "${name}" — new dev farm fees dan dump` }); break; }
  return rejects;
}

function step3_priceHealth(dex) {
  const rejects = [];
  const warnings = [];
  if (!dex) return { rejects, warnings };

  // Hard reject: dump >15% dalam 1h (Meridian criteria)
  if (dex.priceChange1h < -15)
    rejects.push({ rule: 'PRICE_DUMP_1H', msg: `Harga turun ${dex.priceChange1h}% dalam 1h — dump aktif` });

  // Minimum liquidity
  if (dex.liquidity < 5000)
    rejects.push({ rule: 'LOW_LIQUIDITY', msg: `Liquidity $${dex.liquidity.toFixed(0)} (<$5k) — pool terlalu kecil` });
  else if (dex.liquidity < 15000)
    warnings.push({ rule: 'THIN_LIQUIDITY', msg: `Liquidity $${dex.liquidity.toFixed(0)} ($5k-$15k) — tipis, slippage tinggi` });

  // Pair age
  if (dex.pairCreatedAt) {
    const ageHours = (Date.now() - dex.pairCreatedAt) / 3600000;
    if (ageHours < 6)
      rejects.push({ rule: 'TOO_NEW', msg: `Pair baru ${ageHours.toFixed(1)}h — belum terbukti, rug risk tinggi` });
    else if (ageHours < 24)
      warnings.push({ rule: 'NEWLY_CREATED', msg: `Pair baru ${ageHours.toFixed(1)}h — monitor ketat` });
  }

  // Low volume
  if (dex.volume24h < 10000)
    warnings.push({ rule: 'LOW_VOLUME', msg: `Volume 24h $${dex.volume24h.toFixed(0)} (<$10k) — kurang aktif untuk DLMM` });

  return { rejects, warnings };
}

function step4_holderCheck(holders) {
  const rejects = [];
  const warnings = [];
  if (!holders?.available) return { rejects, warnings };

  // Hard reject: top-10 >60% (Meridian criteria)
  if (holders.top10HolderPct > 60)
    rejects.push({ rule: 'HIGH_CONCENTRATION', msg: `Top-10 holders: ${holders.top10HolderPct}% (>60%) — whale dump risk ekstrem` });
  else if (holders.top10HolderPct > 40)
    warnings.push({ rule: 'MODERATE_CONCENTRATION', msg: `Top-10 holders: ${holders.top10HolderPct}% (>40%) — monitor whale` });

  // Hard reject: holder count <200 (Meridian criteria)
  if (holders.holderCount > 0 && holders.holderCount < 200)
    rejects.push({ rule: 'LOW_HOLDER_COUNT', msg: `Hanya ${holders.holderCount} holders (<200) — distribusi buruk` });
  else if (holders.holderCount > 0 && holders.holderCount < 500)
    warnings.push({ rule: 'FEW_HOLDERS', msg: `${holders.holderCount} holders (<500) — distribusi terbatas` });

  return { rejects, warnings };
}

function step5_txnAnalysis(dex) {
  const rejects = [];
  const warnings = [];
  if (!dex) return { rejects, warnings };

  const total1h = dex.buys1h + dex.sells1h;

  // Heavy sell bias dalam 1h = dump sedang terjadi
  if (total1h > 10) {
    const sellRatio = dex.sells1h / total1h;
    if (sellRatio > 0.80)
      rejects.push({ rule: 'HEAVY_SELLING_1H', msg: `${(sellRatio*100).toFixed(0)}% txn 1h adalah SELL — dump aktif` });
    else if (sellRatio > 0.65)
      warnings.push({ rule: 'SELL_BIAS_1H', msg: `${(sellRatio*100).toFixed(0)}% txn 1h adalah SELL — bearish pressure` });
  }

  // Bot activity proxy: txn count tinggi dengan avg value sangat kecil = wash trading
  const total24h = dex.buys24h + dex.sells24h;
  if (total24h > 2000 && dex.volume24h > 0) {
    const avgTxValue = dex.volume24h / total24h;
    if (avgTxValue < 30)
      warnings.push({ rule: 'BOT_ACTIVITY_SUSPECTED', msg: `Avg tx $${avgTxValue.toFixed(1)} dengan ${total24h} txns/24h — kemungkinan wash trading` });
  }

  return { rejects, warnings };
}

function step6_tokenSafety(okx, jup) {
  const rejects = [];
  const warnings = [];

  if (okx?.available) {
    if (okx.isHoneypot)
      rejects.push({ rule: 'HONEYPOT', msg: 'Honeypot terdeteksi (OKX) — tidak bisa jual token' });
    if (okx.riskLevel === 'high' || okx.riskLevel === 'HIGH')
      rejects.push({ rule: 'HIGH_RISK_OKX', msg: `OKX risk level: HIGH` });
    if (okx.isMintable)
      warnings.push({ rule: 'MINTABLE', msg: 'Token mintable — supply bisa inflate kapan saja' });
  }

  if (jup?.isPumpFun)
    warnings.push({ rule: 'PUMP_FUN', msg: 'Token dari pump.fun — high-risk launchpad' });

  return { rejects, warnings };
}

// Step 7: Organic score composite — Meridian: <60 = hard reject
function step7_organicScore(dex, jup, holders) {
  const rejects = [];
  const warnings = [];
  let score = 0;

  // Presence & verification (max 35)
  if (dex?.hasImage)        score += 10;
  if (dex?.hasSocials)      score += 10;
  if (jup?.isStrict)        score += 15;
  else if (jup?.isVerified) score += 10;
  else if (jup?.found)      score += 5;

  // Holder distribution (max 25)
  if (holders?.available) {
    if      (holders.holderCount >= 1000) score += 15;
    else if (holders.holderCount >= 500)  score += 10;
    else if (holders.holderCount >= 200)  score += 5;
    if      (holders.top10HolderPct < 30) score += 10;
    else if (holders.top10HolderPct < 50) score += 5;
  } else {
    score += 10; // neutral — no data, don't punish
  }

  // Volume & activity (max 20)
  if (dex) {
    if      (dex.volume24h >= 100000) score += 15;
    else if (dex.volume24h >= 50000)  score += 10;
    else if (dex.volume24h >= 10000)  score += 5;
    if ((dex.buys24h + dex.sells24h) >= 100) score += 5;
  }

  // Price stability (max 20)
  if (dex) {
    if (dex.priceChange1h >= -10 && dex.priceChange1h <= 50) score += 10;
    if (Math.abs(dex.priceChange24h) < 30)                   score += 10;
  }

  score = Math.min(100, score);

  if (score < 60)
    rejects.push({ rule: 'LOW_ORGANIC_SCORE', msg: `Organic score: ${score}/100 (<60) — tidak cukup organik` });
  else if (score < 70)
    warnings.push({ rule: 'BORDERLINE_ORGANIC', msg: `Organic score: ${score}/100 (borderline)` });

  return { rejects, warnings, score };
}

// ─── Main filter function ────────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '') {
  const [dexResult, jupResult, holderResult, okxResult] = await Promise.allSettled([
    getDexScreenerInfo(tokenMint),
    getJupiterData(tokenMint),
    getHolderData(tokenMint),
    getOKXSafety(tokenMint),
  ]);

  const dex     = dexResult.status    === 'fulfilled' ? dexResult.value    : null;
  const jup     = jupResult.status    === 'fulfilled' ? jupResult.value    : null;
  const holders = holderResult.status === 'fulfilled' ? holderResult.value : null;
  const okx     = okxResult.status    === 'fulfilled' ? okxResult.value    : null;

  const name   = tokenName   || dex?.name   || jup?.name   || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  const s1 = step1_basicValidation(dex, jup);
  const s2 = step2_narrativeFilter(name, symbol);
  const s3 = step3_priceHealth(dex);
  const s4 = step4_holderCheck(holders);
  const s5 = step5_txnAnalysis(dex);
  const s6 = step6_tokenSafety(okx, jup);
  const s7 = step7_organicScore(dex, jup, holders);

  const allRejects = [
    ...s1.rejects, ...s2,
    ...s3.rejects, ...s4.rejects,
    ...s5.rejects, ...s6.rejects,
    ...s7.rejects,
  ];
  const allWarnings = [
    ...s1.warnings,
    ...s3.warnings, ...s4.warnings,
    ...s5.warnings, ...s6.warnings,
    ...s7.warnings,
  ];

  let verdict;
  if      (allRejects.length > 0)       verdict = 'AVOID';
  else if (allWarnings.length >= 1)      verdict = 'CAUTION';
  else                                   verdict = 'PASS';

  const eligible = allRejects.length === 0;

  return {
    tokenMint,
    name,
    symbol,
    verdict,
    eligible,
    highFlags:    allRejects,
    mediumFlags:  allWarnings,
    allFlags:     [...allRejects, ...allWarnings],
    organicScore: s7.score,
    steps:        { s1, s2, s3, s4, s5, s6, s7 },
    jupiterData:  jup,
    gmgnAvailable: false,
    sources: {
      dexscreener: !!dex,
      jupiter:     !!(jup?.found),
      helius:      !!(holders?.available),
      okx:         !!(okx?.available),
    },
  };
}

// ─── Format for Telegram ─────────────────────────────────────────

export function formatScreenResult(result) {
  const emoji = { AVOID: '🚫', CAUTION: '👀', PASS: '✅' }[result.verdict] || '❓';
  const label = result.eligible ? result.verdict + ' — ELIGIBLE FOR DLMM' : 'AVOID';

  let text = `${emoji} *${result.name || result.symbol || result.tokenMint.slice(0, 8)}* — ${label}\n`;
  text += `\`${result.tokenMint.slice(0, 16)}...\`\n`;
  text += `📊 Organic score: *${result.organicScore ?? 'N/A'}/100*\n\n`;

  if (result.jupiterData?.found) {
    const jupStatus = result.jupiterData.isStrict ? '✅ Strict'
      : result.jupiterData.isVerified ? '✓ Verified' : '⚠️ Unverified';
    text += `🪐 Jupiter: ${jupStatus}`;
    if (result.jupiterData.priceUsd) text += ` | $${parseFloat(result.jupiterData.priceUsd).toFixed(6)}`;
    text += '\n';
  }

  if (result.highFlags.length > 0) {
    text += `\n🔴 *Ditolak (${result.highFlags.length}):*\n`;
    result.highFlags.forEach(f => text += `• ${f.msg}\n`);
  }
  if (result.mediumFlags.length > 0) {
    text += `\n🟡 *Peringatan (${result.mediumFlags.length}):*\n`;
    result.mediumFlags.forEach(f => text += `• ${f.msg}\n`);
  }
  if (result.eligible) text += `\n✅ Lolos filter — Eligible for DLMM.`;

  const srcList = Object.entries(result.sources).filter(([, v]) => v).map(([k]) => k).join(', ');
  text += `\n\n_Sources: ${srcList}_`;
  return text;
}
