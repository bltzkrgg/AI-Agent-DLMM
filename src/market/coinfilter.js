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

// Helius — real-time top-10 concentration + activity (centralized client)
async function getHolderData(tokenMint) {
  const { getTokenHolderData } = await import('../utils/helius.js');
  const result = await getTokenHolderData(tokenMint);
  if (!result) return null;
  return {
    available:      true,
    holderCount:    null, // Helius tidak expose total count secara efisien; pakai DexScreener
    top10HolderPct: result.top10HolderPct,
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

    // Danger + warn risk counts
    const dangerCount = risks.filter(r => r.level === 'danger').length;
    const warnCount   = risks.filter(r => r.level === 'warn').length;
    const phishingPct = data.rugged ? 100 : Math.min(dangerCount * 15, 90);

    return {
      available:      true,
      source:         'rugcheck',
      top10Pct,
      insidersPct:    insiderPct,
      bundlingPct,
      phishingPct,
      rugged:         data.rugged || false,
      rugCheckScore:  safeNum(data.score || 0),
      scoreNorm:      safeNum(data.score_normalised || 0), // 0–100, lower = safer
      dangerRisks:    dangerCount,
      warnRisks:      warnCount,
      risks:          risks.filter(r => r.level === 'danger').map(r => r.name),
      warnRiskNames:  risks.filter(r => r.level === 'warn').map(r => r.name),
    };
  } catch { return null; }
}

async function getSecurityData(tokenMint) {
  return getRugCheckSecurity(tokenMint);
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

// ─── GeckoTerminal — mcap + 30-day ATH approximation ────────────

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

async function getGeckoTokenData(tokenMint) {
  try {
    // Get top pool for this token (by volume) to find pool address for OHLCV
    const poolRes = await fetchWithTimeout(
      `${GECKO_BASE}/networks/solana/tokens/${tokenMint}/pools?page=1&sort=h24_volume_usd_desc`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!poolRes.ok) return null;
    const poolData = await poolRes.json().catch(() => null);
    const pools = poolData?.data || [];
    if (!pools.length) return null;

    const topPool = pools[0];
    const poolAddress = topPool.attributes?.address;
    const marketCapUsd = safeNum(topPool.attributes?.market_cap_usd || 0) ||
                         safeNum(topPool.attributes?.fdv_usd || 0);

    return { poolAddress, marketCapUsd };
  } catch { return null; }
}

async function getTokenATHApprox(tokenMint, lookbackDays = 30) {
  // Approximates ATH as highest daily candle high over lookback window
  try {
    // First get pool address
    const geckoData = await getGeckoTokenData(tokenMint);
    if (!geckoData?.poolAddress) return null;

    const res = await fetchWithTimeout(
      `${GECKO_BASE}/networks/solana/pools/${geckoData.poolAddress}/ohlcv/day?aggregate=1&limit=${lookbackDays}&currency=usd`,
      { headers: { Accept: 'application/json' } },
      10000
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const ohlcv = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcv) || !ohlcv.length) return null;

    // Each item: [timestamp, open, high, low, close, volume]
    const athPrice = Math.max(...ohlcv.map(c => safeNum(c[2])));
    const currentPrice = safeNum(ohlcv[ohlcv.length - 1][4]); // last close

    return { athPrice, currentPrice, lookbackDays };
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

// Step 8: RugCheck Security — warn+danger risks → REJECT
// Replaces GMGN entirely. Uses RugCheck risks[].level field directly.
function step8_rugCheckFilter(rc) {
  const rejects = [];
  const warnings = [];
  if (!rc?.available) return { rejects, warnings, available: false };

  // Immediate reject: token is confirmed rugged
  if (rc.rugged)
    rejects.push({ rule: 'RUGCHECK_RUGGED', msg: 'Token ini sudah RUGGED (RugCheck confirmed)' });

  // Both warn AND danger risks → REJECT (locked decision)
  const dangerRisks = (rc.risks || []).filter(r =>
    typeof r === 'string' ? false : false // rc.risks already filtered to names
  );
  // Use raw counts from the data
  if (rc.dangerRisks > 0)
    rejects.push({ rule: 'RUGCHECK_DANGER', msg: `RugCheck: ${rc.dangerRisks} danger risk(s) — ${(rc.risks || []).slice(0, 3).join(', ')}` });

  // Warn-level risks also → REJECT (locked: both warn+danger reject)
  if (rc.warnRisks > 0)
    rejects.push({ rule: 'RUGCHECK_WARN', msg: `RugCheck: ${rc.warnRisks} warn risk(s) — ${(rc.warnRiskNames || []).slice(0, 3).join(', ')}` });

  // High risk score as additional signal
  if (rc.scoreNorm >= 60 && !rc.rugged)
    rejects.push({ rule: 'RUGCHECK_HIGH_SCORE', msg: `RugCheck risk score: ${rc.scoreNorm}/100 (≥60 = high risk)` });
  else if (rc.scoreNorm >= 35 && rc.dangerRisks === 0 && (rc.warnRisks || 0) === 0)
    warnings.push({ rule: 'RUGCHECK_MEDIUM_SCORE', msg: `RugCheck risk score: ${rc.scoreNorm}/100 (borderline)` });

  return { rejects, warnings, available: true };
}

// Step 9: Mcap filter — GeckoTerminal primary, DexScreener FDV fallback
// null mcap data → skip (not reject)
function step9_mcapFilter(geckoMcap, dexFdv, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  const minMcap = thresholds.minMcap || 0;
  const maxMcap = thresholds.maxMcap || 0;

  // Determine best mcap value
  const mcap = geckoMcap > 0 ? geckoMcap : (dexFdv > 0 ? dexFdv : null);

  if (mcap === null) {
    // null → skip (no reject, no warning — data unavailable)
    return { rejects, warnings, mcap: null, skipped: true };
  }

  if (minMcap > 0 && mcap < minMcap)
    rejects.push({ rule: 'BELOW_MIN_MCAP', msg: `Mcap $${mcap.toLocaleString()} < min $${minMcap.toLocaleString()}` });

  if (maxMcap > 0 && mcap > maxMcap)
    rejects.push({ rule: 'ABOVE_MAX_MCAP', msg: `Mcap $${mcap.toLocaleString()} > max $${maxMcap.toLocaleString()}` });

  return { rejects, warnings, mcap, skipped: false };
}

// Step 10: ATH drawdown filter
// Override if smart wallet active OR OKX smart money buying
function step10_athFilter(athData, thresholds = {}, overrideActive = false) {
  const rejects = [];
  const warnings = [];
  if (!athData || overrideActive) return { rejects, warnings, skipped: overrideActive };

  const filterPct = thresholds.athFilterPct ?? -75; // e.g. -75 means reject if >75% below ATH
  const { athPrice, currentPrice } = athData;

  if (!athPrice || !currentPrice || athPrice <= 0) return { rejects, warnings, skipped: true };

  const drawdownPct = ((currentPrice - athPrice) / athPrice) * 100;

  if (drawdownPct <= filterPct)
    rejects.push({
      rule: 'ATH_DRAWDOWN',
      msg: `Harga ${drawdownPct.toFixed(1)}% dari ${athData.lookbackDays}d high ($${athPrice.toFixed(6)}) — di bawah threshold ${filterPct}%`,
    });
  else if (drawdownPct <= filterPct + 15)
    warnings.push({
      rule: 'ATH_DRAWDOWN_WARN',
      msg: `Harga ${drawdownPct.toFixed(1)}% dari ${athData.lookbackDays}d high — mendekati ATH filter`,
    });

  return { rejects, warnings, drawdownPct: parseFloat(drawdownPct.toFixed(2)), skipped: false };
}

// ─── Main filter function ────────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '', opts = {}) {
  const cfg = getConfig();
  const thresholds = {
    minMcap:        cfg.minMcap        ?? 0,
    maxMcap:        cfg.maxMcap        ?? 0,
    minVolume24h:   cfg.minVolume24h   ?? 0,
    minOrganic:     cfg.minOrganic     ?? 65,
    minHolders:     cfg.minHolders     ?? 500,
    athFilterPct:   cfg.athFilterPct   ?? -75,
    athLookbackDays: cfg.athLookbackDays ?? 30,
  };

  // opts.overrideATH = true jika smart wallet aktif di pool atau OKX smart money buying
  const overrideATH = opts.overrideATH === true;

  const [dexResult, jupResult, holderResult, okxResult, rcResult, geckoResult, athResult] = await Promise.allSettled([
    getDexScreenerInfo(tokenMint),
    getJupiterData(tokenMint),
    getHolderData(tokenMint),
    getOKXSafety(tokenMint),
    getSecurityData(tokenMint),
    getGeckoTokenData(tokenMint),
    getTokenATHApprox(tokenMint, thresholds.athLookbackDays),
  ]);

  const dex    = dexResult.status    === 'fulfilled' ? dexResult.value    : null;
  const jup    = jupResult.status    === 'fulfilled' ? jupResult.value    : null;
  const holders = holderResult.status === 'fulfilled' ? holderResult.value : null;
  const okx    = okxResult.status    === 'fulfilled' ? okxResult.value    : null;
  const rc     = rcResult.status     === 'fulfilled' ? rcResult.value     : null;
  const gecko  = geckoResult.status  === 'fulfilled' ? geckoResult.value  : null;
  const ath    = athResult.status    === 'fulfilled' ? athResult.value    : null;

  const name   = tokenName   || dex?.name   || jup?.name   || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  const geckoMcap = gecko?.marketCapUsd ?? 0;
  const dexFdv    = dex?.fdv ?? 0;

  const s1  = step1_basicValidation(dex, jup);
  const s2  = step2_narrativeFilter(name, symbol);
  const s3  = step3_priceHealth(dex, thresholds);
  const s4  = step4_holderCheck(holders, thresholds);
  const s5  = step5_txnAnalysis(dex);
  const s6  = step6_tokenSafety(okx, jup);
  const s7  = step7_organicScore(dex, jup, holders, thresholds);
  const s8  = step8_rugCheckFilter(rc);
  const s9  = step9_mcapFilter(geckoMcap, dexFdv, thresholds);
  const s10 = step10_athFilter(ath, thresholds, overrideATH);

  const allRejects = [
    ...s1.rejects, ...s2,
    ...s3.rejects, ...s4.rejects,
    ...s5.rejects, ...s6.rejects,
    ...s7.rejects, ...s8.rejects,
    ...s9.rejects, ...s10.rejects,
  ];
  const allWarnings = [
    ...s1.warnings,
    ...s3.warnings, ...s4.warnings,
    ...s5.warnings, ...s6.warnings,
    ...s7.warnings, ...s8.warnings,
    ...s9.warnings, ...s10.warnings,
  ];

  let verdict;
  if      (allRejects.length > 0)  verdict = 'AVOID';
  else if (allWarnings.length >= 1) verdict = 'CAUTION';
  else                              verdict = 'PASS';

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
    mcap:         s9.mcap ?? null,
    drawdownPct:  s10.drawdownPct ?? null,
    rugCheckData: rc,
    steps:        { s1, s2, s3, s4, s5, s6, s7, s8, s9, s10 },
    jupiterData:  jup,
    sources: {
      dexscreener: !!dex,
      jupiter:     !!(jup?.found),
      helius:      !!(holders?.available),
      okx:         !!(okx?.available),
      rugcheck:    !!(rc?.available),
      gecko:       !!(gecko?.marketCapUsd),
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

  if (result.mcap != null) {
    text += `💰 Mcap: $${result.mcap.toLocaleString()}\n`;
  }
  if (result.drawdownPct != null) {
    text += `📉 vs ${result.steps?.s10?.skipped ? '(ATH filter skipped)' : `30d high: ${result.drawdownPct > 0 ? '+' : ''}${result.drawdownPct}%`}\n`;
  }

  if (result.rugCheckData?.available) {
    const rc = result.rugCheckData;
    const parts = [];
    if (rc.dangerRisks > 0) parts.push(`${rc.dangerRisks} danger`);
    if (rc.warnRisks   > 0) parts.push(`${rc.warnRisks} warn`);
    if (rc.scoreNorm   > 0) parts.push(`score: ${rc.scoreNorm}/100`);
    if (rc.rugged) text += `☠️ *RUGGED TOKEN* — AVOID\n`;
    else if (parts.length) text += `🔍 RugCheck: ${parts.join(' | ')}\n`;
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

  if (result.sources) {
    const srcList = Object.entries(result.sources).filter(([, v]) => v).map(([k]) => k).join(', ');
    text += `\n\n_Sources: ${srcList}_`;
  }
  return text;
}
