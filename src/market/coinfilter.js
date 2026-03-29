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
import { getConfig } from '../config.js';

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

// Solscan public API — free, no key, returns total holder count
async function getSolscanHolderCount(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `https://public-api.solscan.io/token/holders?tokenAddress=${tokenMint}&limit=1&offset=0`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const count = data?.total ?? null;
    return typeof count === 'number' ? count : null;
  } catch { return null; }
}

// Helius RPC — real-time top-10 concentration (requires HELIUS_API_KEY)
async function getHeliusTop10(tokenMint) {
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
    const totalSupply = safeNum(supply.uiAmount || 0);
    if (totalSupply === 0) return null;

    const top10Amount = largest.slice(0, 10).reduce((s, h) => s + safeNum(h.uiAmount || 0), 0);
    return parseFloat(((top10Amount / totalSupply) * 100).toFixed(2));
  } catch { return null; }
}

async function getHolderData(tokenMint) {
  // Run both in parallel — Solscan works without key, Helius adds real-time top10
  const [heliusR, solscanR] = await Promise.allSettled([
    getHeliusTop10(tokenMint),
    getSolscanHolderCount(tokenMint),
  ]);

  const top10HolderPct = heliusR.status === 'fulfilled' ? heliusR.value : null;
  const holderCount    = solscanR.status === 'fulfilled' ? solscanR.value : null;

  if (top10HolderPct === null && holderCount === null) return null;

  return {
    available:      true,
    holderCount,
    top10HolderPct,
  };
}

// ─── RugCheck.xyz — free public API, no key needed ───────────────
// Replaces GMGN (whose endpoints are unreliable/undocumented).
// Maps RugCheck data to same interface so step8 logic stays unchanged.

async function getRugCheckSecurity(tokenMint) {
  try {
    // /report (bukan /report/summary) — berisi topHolders, creator, rugged
    const res = await fetchWithTimeout(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { headers: { Accept: 'application/json' } },
      10000
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;

    // Top-10 holder concentration — topHolders[].pct sudah dalam %
    const holders = Array.isArray(data.topHolders) ? data.topHolders : [];
    const top10Pct = parseFloat(
      holders.slice(0, 10).reduce((s, h) => s + safeNum(h.pct || 0), 0).toFixed(2)
    );

    // Insider % — RugCheck menandai tiap holder dengan insider: true/false
    const insiderPct = parseFloat(
      holders.filter(h => h.insider === true)
             .reduce((s, h) => s + safeNum(h.pct || 0), 0).toFixed(2)
    );

    // Bundled launch dari risks array
    const risks = Array.isArray(data.risks) ? data.risks : [];
    const bundledRisk = risks.find(r =>
      /bundle/i.test(r.name || '') || /bundle/i.test(r.description || '')
    );
    let bundlingPct = 0;
    if (bundledRisk) {
      // Coba extract % dari description, atau gunakan score sebagai proxy
      const pctMatch = /(\d+\.?\d*)%/.exec(bundledRisk.description || '');
      bundlingPct = pctMatch ? parseFloat(pctMatch[1]) : Math.min(bundledRisk.score / 5, 90);
    }

    // Danger risks count — proxy untuk phishing/fraud signals
    const dangerCount = risks.filter(r => r.level === 'danger').length;
    const phishingPct = data.rugged ? 100 : Math.min(dangerCount * 15, 90);

    return {
      available:     true,
      source:        'rugcheck',
      top10Pct,
      insidersPct:   insiderPct,
      bundlingPct,
      phishingPct,
      rugged:        data.rugged || false,
      rugCheckScore: safeNum(data.score || 0),
      scoreNorm:     safeNum(data.score_normalised || 0), // 0–100, lower = safer
      dangerRisks:   dangerCount,
      risks:         risks.filter(r => r.level !== 'info').map(r => r.name),
    };
  } catch { return null; }
}

// Keep GMGN as optional override — if GMGN_API_KEY is set AND RugCheck fails
async function getGMGNSecurityFallback(tokenMint) {
  if (!process.env.GMGN_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `https://gmgn.ai/api/v1/token_security/sol/${tokenMint}`,
      { headers: { 'Authorization': `Bearer ${process.env.GMGN_API_KEY}` } },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const sec = data.data || data;
    return {
      available:    true,
      source:       'gmgn',
      phishingPct:  safeNum(sec.phishing_report_percentage ?? null),
      bundlingPct:  safeNum(sec.bundle_percentage          ?? null),
      insidersPct:  safeNum(sec.insider_percentage         ?? null),
      top10Pct:     safeNum(sec.top10_holder_percentage    ?? null),
    };
  } catch { return null; }
}

async function getSecurityData(tokenMint) {
  const rc = await getRugCheckSecurity(tokenMint);
  if (rc?.available) return rc;
  // Fallback to GMGN if RugCheck fails and GMGN_API_KEY is set
  return getGMGNSecurityFallback(tokenMint);
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

function step3_priceHealth(dex, thresholds = {}) {
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

  // Low volume (general)
  if (dex.volume24h < 10000)
    warnings.push({ rule: 'LOW_VOLUME', msg: `Volume 24h $${dex.volume24h.toFixed(0)} (<$10k) — kurang aktif untuk DLMM` });

  // Evil Panda: min volume threshold (configurable)
  const minVol = thresholds.minVolume24h || 0;
  if (minVol > 0 && dex.volume24h < minVol)
    warnings.push({ rule: 'BELOW_MIN_VOLUME', msg: `Volume 24h $${dex.volume24h.toFixed(0)} < threshold $${minVol.toLocaleString()} — tidak memenuhi kriteria Evil Panda` });

  // Evil Panda: min market cap via FDV proxy (configurable)
  const minMcap = thresholds.minMcap || 0;
  if (minMcap > 0 && dex.fdv > 0 && dex.fdv < minMcap)
    warnings.push({ rule: 'BELOW_MIN_MCAP', msg: `FDV $${dex.fdv.toFixed(0)} < threshold $${minMcap.toLocaleString()} — tidak memenuhi kriteria Evil Panda` });

  return { rejects, warnings };
}

function step4_holderCheck(holders, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  if (!holders?.available) return { rejects, warnings };

  const minHolders = thresholds.minHolders ?? 500;

  // Hard reject: top-10 >60%
  if (holders.top10HolderPct > 60)
    rejects.push({ rule: 'HIGH_CONCENTRATION', msg: `Top-10 holders: ${holders.top10HolderPct}% (>60%) — whale dump risk ekstrem` });
  else if (holders.top10HolderPct > 40)
    warnings.push({ rule: 'MODERATE_CONCENTRATION', msg: `Top-10 holders: ${holders.top10HolderPct}% (>40%) — monitor whale` });

  // Hard reject: holder count <200 (absolute floor)
  if (holders.holderCount > 0 && holders.holderCount < 200)
    rejects.push({ rule: 'LOW_HOLDER_COUNT', msg: `Hanya ${holders.holderCount} holders (<200) — distribusi buruk` });
  else if (holders.holderCount > 0 && holders.holderCount < minHolders)
    warnings.push({ rule: 'FEW_HOLDERS', msg: `${holders.holderCount} holders (<${minHolders}) — distribusi terbatas` });

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

// Step 7: Organic score composite — reject di bawah threshold (default 60, configurable)
function step7_organicScore(dex, jup, holders, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  const minOrganic = thresholds.minOrganic ?? 60;
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

  if (score < minOrganic)
    rejects.push({ rule: 'LOW_ORGANIC_SCORE', msg: `Organic score: ${score}/100 (<${minOrganic}) — tidak cukup organik` });
  else if (score < minOrganic + 10)
    warnings.push({ rule: 'BORDERLINE_ORGANIC', msg: `Organic score: ${score}/100 (borderline)` });

  return { rejects, warnings, score };
}

// Step 8: GMGN Security — Evil Panda criteria (optional, only if GMGN_API_KEY set)
function step8_gmgnFilter(gmgn, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  if (!gmgn?.available) return { rejects, warnings, available: false };

  const maxPhishing = thresholds.gmgnMaxPhishing      ?? 30;
  const maxBundling = thresholds.gmgnMaxBundling       ?? 60;
  const maxInsiders = thresholds.gmgnMaxInsiders       ?? 10;
  const maxTop10    = thresholds.gmgnMaxTop10Holdings  ?? 30;

  if (gmgn.phishingPct !== null && gmgn.phishingPct >= maxPhishing)
    rejects.push({ rule: 'GMGN_PHISHING', msg: `GMGN phishing report ${gmgn.phishingPct}% (≥${maxPhishing}%) — RED FLAG` });

  if (gmgn.bundlingPct !== null && gmgn.bundlingPct >= maxBundling)
    rejects.push({ rule: 'GMGN_BUNDLING', msg: `GMGN bundling ${gmgn.bundlingPct}% (≥${maxBundling}%) — koordinasi mencurigakan` });

  if (gmgn.insidersPct !== null && gmgn.insidersPct >= maxInsiders)
    rejects.push({ rule: 'GMGN_INSIDERS', msg: `GMGN insiders ${gmgn.insidersPct}% (≥${maxInsiders}%) — insider risk tinggi` });

  if (gmgn.top10Pct !== null && gmgn.top10Pct >= maxTop10)
    warnings.push({ rule: 'GMGN_TOP10', msg: `Top-10 holdings ${gmgn.top10Pct}% (≥${maxTop10}%) — konsentrasi tinggi` });

  // RugCheck-specific signals
  if (gmgn.source === 'rugcheck') {
    if (gmgn.rugged)
      rejects.push({ rule: 'RUGCHECK_RUGGED', msg: 'Token ini sudah RUGGED (RugCheck confirmed)' });
    // score_normalised: 0=perfect, 100=very risky
    if (gmgn.scoreNorm >= 60)
      rejects.push({ rule: 'RUGCHECK_HIGH_RISK', msg: `RugCheck risk score: ${gmgn.scoreNorm}/100 (≥60 = high risk)` });
    else if (gmgn.scoreNorm >= 35)
      warnings.push({ rule: 'RUGCHECK_MEDIUM_RISK', msg: `RugCheck risk score: ${gmgn.scoreNorm}/100 (borderline)` });
  }

  return { rejects, warnings, available: true };
}

// ─── Main filter function ────────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '') {
  const cfg = getConfig();
  const thresholds = {
    minMcap:             cfg.minMcap             ?? 0,
    minVolume24h:        cfg.minVolume24h         ?? 0,
    gmgnMaxPhishing:     cfg.gmgnMaxPhishing      ?? 30,
    gmgnMaxBundling:     cfg.gmgnMaxBundling      ?? 60,
    gmgnMaxInsiders:     cfg.gmgnMaxInsiders      ?? 10,
    gmgnMaxTop10Holdings: cfg.gmgnMaxTop10Holdings ?? 30,
  };

  const [dexResult, jupResult, holderResult, okxResult, gmgnResult] = await Promise.allSettled([
    getDexScreenerInfo(tokenMint),
    getJupiterData(tokenMint),
    getHolderData(tokenMint),
    getOKXSafety(tokenMint),
    getSecurityData(tokenMint),
  ]);

  const dex     = dexResult.status    === 'fulfilled' ? dexResult.value    : null;
  const jup     = jupResult.status    === 'fulfilled' ? jupResult.value    : null;
  const holders = holderResult.status === 'fulfilled' ? holderResult.value : null;
  const okx     = okxResult.status    === 'fulfilled' ? okxResult.value    : null;
  const gmgn    = gmgnResult.status   === 'fulfilled' ? gmgnResult.value   : null;

  const name   = tokenName   || dex?.name   || jup?.name   || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  const s1 = step1_basicValidation(dex, jup);
  const s2 = step2_narrativeFilter(name, symbol);
  const s3 = step3_priceHealth(dex, thresholds);
  const s4 = step4_holderCheck(holders, thresholds);
  const s5 = step5_txnAnalysis(dex);
  const s6 = step6_tokenSafety(okx, jup);
  const s7 = step7_organicScore(dex, jup, holders, thresholds);
  const s8 = step8_gmgnFilter(gmgn, thresholds);

  const allRejects = [
    ...s1.rejects, ...s2,
    ...s3.rejects, ...s4.rejects,
    ...s5.rejects, ...s6.rejects,
    ...s7.rejects, ...s8.rejects,
  ];
  const allWarnings = [
    ...s1.warnings,
    ...s3.warnings, ...s4.warnings,
    ...s5.warnings, ...s6.warnings,
    ...s7.warnings, ...s8.warnings,
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
    holderCount:  holders?.holderCount ?? null,
    steps:        { s1, s2, s3, s4, s5, s6, s7, s8 },
    jupiterData:  jup,
    gmgnData:     gmgn,
    gmgnAvailable: !!(gmgn?.available),
    sources: {
      dexscreener: !!dex,
      jupiter:     !!(jup?.found),
      helius:      !!(holders?.available),
      okx:         !!(okx?.available),
      gmgn:        !!(gmgn?.available),
    },
  };
}

// ─── Format for Telegram ─────────────────────────────────────────

export function formatScreenResult(result) {
  const emoji = { AVOID: '🚫', CAUTION: '👀', PASS: '✅' }[result.verdict] || '❓';
  const label = result.eligible ? result.verdict + ' — ELIGIBLE FOR DLMM' : 'AVOID';

  const holderDisplay = result.holderCount != null
    ? ` | 👥 ${result.holderCount.toLocaleString()} holders`
    : '';

  let text = `${emoji} *${result.name || result.symbol || result.tokenMint.slice(0, 8)}* — ${label}\n`;
  text += `\`${result.tokenMint.slice(0, 16)}...\`\n`;
  text += `📊 Organic score: *${result.organicScore ?? 'N/A'}/100*${holderDisplay}\n\n`;

  if (result.jupiterData?.found) {
    const jupStatus = result.jupiterData.isStrict ? '✅ Strict'
      : result.jupiterData.isVerified ? '✓ Verified' : '⚠️ Unverified';
    text += `🪐 Jupiter: ${jupStatus}`;
    if (result.jupiterData.priceUsd) text += ` | $${parseFloat(result.jupiterData.priceUsd).toFixed(6)}`;
    text += '\n';
  }

  if (result.gmgnAvailable && result.gmgnData) {
    const g = result.gmgnData;
    const src = g.source === 'rugcheck' ? '🔍 RugCheck' : '🔐 GMGN';
    const secLine = [
      g.phishingPct !== null ? `Phishing: ${g.phishingPct}%` : null,
      g.bundlingPct !== null ? `Bundle: ${g.bundlingPct}%`   : null,
      g.insidersPct !== null ? `Insiders: ${g.insidersPct}%` : null,
      g.top10Pct    !== null ? `Top10: ${g.top10Pct}%`       : null,
    ].filter(Boolean).join(' | ');
    if (secLine) text += `${src}: ${secLine}\n`;
    if (g.rugged) text += `☠️ *RUGGED TOKEN* — AVOID\n`;
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
