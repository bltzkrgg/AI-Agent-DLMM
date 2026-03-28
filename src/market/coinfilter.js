/**
 * Coin Filter — SOL_DLMM_COIN_FILTER
 *
 * 7-step sequential filter before entering DLMM positions.
 * Principle: Filter aggressively. Ignore hype. Focus on structure.
 *
 * Steps:
 *   1. basic_validation      — logo + socials
 *   2. narrative_filter      — political / celebrity / justice / viral / cto
 *   3. gmgn_total_fees       — fees < 20 → REJECT, 20-50 → REVIEW, >50 → PASS
 *   4. gmgn_metrics          — holders, dev, insiders, phishing, bundling, LP
 *   5. vamped_coins          — vampire coin detection
 *   6. cto_coins             — CTO / community takeover
 *   7. bubblemaps_analysis   — virus cluster (wallet clustering)
 */

import { fetchWithTimeout } from '../utils/safeJson.js';

const GMGN_BASE        = 'https://gmgn.ai/defi/quotation/v1';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const JUPITER_TOKEN_BASE = 'https://tokens.jup.ag';
const JUPITER_PRICE_BASE = 'https://api.jup.ag';
const RUGCHECK_BASE    = 'https://api.rugcheck.xyz';

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
    if (pairs.length === 0) return null;
    const best = pairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];
    return {
      name:         best.baseToken?.name || '',
      symbol:       best.baseToken?.symbol || '',
      hasImage:     !!(best.info?.imageUrl),
      hasSocials:   !!(best.info?.socials?.length > 0 || best.info?.websites?.length > 0),
      liquidity:    best.liquidity?.usd || 0,
      fdv:          best.fdv || 0,
      priceChange24h: best.priceChange?.h24 || 0,
    };
  } catch { return null; }
}

async function getGMGNData(tokenMint) {
  const endpoints = [
    `${GMGN_BASE}/tokens/sol/${tokenMint}`,
    `${GMGN_BASE}/token/sol/${tokenMint}`,
  ];
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://gmgn.ai/',
    'Origin': 'https://gmgn.ai',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(process.env.GMGN_API_KEY ? { 'Authorization': `Bearer ${process.env.GMGN_API_KEY}` } : {}),
  };
  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, { headers }, 8000);
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.data || data;
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    } catch { /* try next */ }
  }
  return null;
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
      priceUsd:   priceInfo?.price || null,
    };
  } catch { return null; }
}

async function getRugCheckReport(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${RUGCHECK_BASE}/v1/tokens/${tokenMint}/report/summary`,
      {
        headers: {
          ...(process.env.RUGCHECK_API_KEY
            ? { 'Authorization': `Bearer ${process.env.RUGCHECK_API_KEY}` } : {}),
        },
      },
      8000
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── 7-Step Filter Logic ─────────────────────────────────────────

function step1_basicValidation(dex) {
  const rejects = [];
  if (!dex) {
    rejects.push({ rule: 'NO_DEXSCREENER_DATA', msg: 'Token tidak ditemukan di DexScreener' });
    return rejects;
  }
  if (!dex.hasImage)   rejects.push({ rule: 'NO_LOGO',         msg: 'Token tidak punya logo — REJECT' });
  if (!dex.hasSocials) rejects.push({ rule: 'NO_SOCIAL_LINKS', msg: 'Token tidak punya social links — REJECT' });
  return rejects;
}

function step2_narrativeFilter(name, symbol, gmgn) {
  const rejects = [];
  const text = `${name} ${symbol}`.toLowerCase();

  for (const p of POLITICAL_PATTERNS) {
    if (p.test(text)) { rejects.push({ rule: 'POLITICAL_FIGURE', msg: `Political coin terdeteksi: "${name}" — slow rug pattern` }); break; }
  }
  for (const p of CELEBRITY_PATTERNS) {
    if (p.test(text)) { rejects.push({ rule: 'CELEBRITY_COIN', msg: `Celebrity coin: "${name}" — dev bisa dump kapan saja` }); break; }
  }
  for (const p of JUSTICE_PATTERNS) {
    if (p.test(text)) { rejects.push({ rule: 'JUSTICE_NARRATIVE', msg: `"Justice/save" narrative: "${name}" — classic rug` }); break; }
  }
  for (const p of VIRAL_ANIMAL_PATTERNS) {
    if (p.test(text)) { rejects.push({ rule: 'VIRAL_ANIMAL', msg: `Viral animal / TikTok meme: "${name}" — hype-driven, rug cepat` }); break; }
  }

  // Dev activity check via GMGN
  if (gmgn) {
    const devActive = gmgn.dev_active ?? gmgn.creator_active ?? null;
    if (devActive === false) {
      rejects.push({ rule: 'DEV_INACTIVE', msg: 'Dev tidak aktif — REJECT' });
    }
  }

  return rejects;
}

function step3_gmgnTotalFees(gmgn) {
  const rejects = [];
  const warnings = [];
  if (!gmgn) {
    warnings.push({ rule: 'GMGN_UNAVAILABLE', msg: 'GMGN data tidak tersedia — fees tidak bisa diverifikasi' });
    return { rejects, warnings };
  }
  const fees = gmgn.total_fees ?? gmgn.fees_24h ?? gmgn.total_fee ?? 0;
  if (fees < 20) {
    rejects.push({ rule: 'FEES_TOO_LOW', msg: `Total fees: ${fees} (<20) — kemungkinan scam/rug` });
  } else if (fees <= 50) {
    warnings.push({ rule: 'FEES_BORDERLINE', msg: `Total fees: ${fees} (20-50) — perlu cek chart lebih detail` });
  }
  // fees > 50 = PASS, good for DLMM (no flag)
  return { rejects, warnings };
}

function step4_gmgnMetrics(gmgn) {
  const rejects = [];
  const warnings = [];
  if (!gmgn) return { rejects, warnings };

  const top10      = gmgn.top10_holder_rate   ?? gmgn.holder_percentage?.top10 ?? 0;
  const devHolding = gmgn.dev_holding         ?? 0;
  const insiders   = gmgn.insider_rate        ?? 0;
  const phishing   = gmgn.phishing_rate       ?? 0;
  const bundling   = gmgn.bundled_rate        ?? 0;
  const lpBurnt    = gmgn.liquidity_burnt     ?? gmgn.renounced ?? null;
  const rugHistory = gmgn.dev_rug_history     ?? gmgn.creator_rug ?? false;

  if (top10 > 30)
    rejects.push({ rule: 'HIGH_TOP10_HOLDERS', msg: `Top 10 holders: ${top10}% (>30%) — whale dump risk` });

  if (devHolding > 5)
    rejects.push({ rule: 'DEV_HOLDING_HIGH', msg: `Dev holding: ${devHolding}% (>5%) — red flag` });
  else if (devHolding > 1)
    warnings.push({ rule: 'DEV_HAS_SUPPLY', msg: `Dev masih pegang ${devHolding}% (>1%) — bisa dump` });

  if (insiders > 0)
    rejects.push({ rule: 'HAS_INSIDERS', msg: `Insider rate: ${insiders}% (>0%) — coordinated wallets terdeteksi` });

  if (phishing > 30)
    rejects.push({ rule: 'HIGH_PHISHING', msg: `Phishing rate: ${phishing}% (>30%) — sangat berbahaya` });

  if (bundling > 60)
    rejects.push({ rule: 'HIGH_BUNDLING', msg: `Bundling: ${bundling}% (>60%) — bisa dump serentak` });

  if (lpBurnt === false)
    rejects.push({ rule: 'LP_NOT_BURNT', msg: 'Liquidity tidak di-burn — dev bisa tarik LP kapan saja' });

  if (rugHistory === true)
    rejects.push({ rule: 'DEV_RUG_HISTORY', msg: 'Dev pernah rug — REJECT' });

  return { rejects, warnings };
}

function step5_vampedCoins(gmgn) {
  const rejects = [];
  if (!gmgn) return rejects;
  if (gmgn.is_vampire || gmgn.vampire) {
    rejects.push({ rule: 'VAMPIRE_COIN', msg: 'Vampire coin — ekstrak likuiditas dari coin utama, hindari!' });
  }
  return rejects;
}

function step6_ctoCoins(name, symbol, gmgn) {
  const rejects = [];
  const text = `${name} ${symbol}`.toLowerCase();
  const isCto = CTO_PATTERNS.some(p => p.test(text)) ||
    gmgn?.is_cto === true || gmgn?.community_takeover === true;
  if (isCto) {
    rejects.push({ rule: 'CTO_COIN', msg: 'CTO coin — new dev farm fees dan dump, bukan rebuild' });
  }
  return rejects;
}

function step7_bubblemaps(rugReport) {
  const rejects = [];
  const warnings = [];
  if (!rugReport) {
    warnings.push({ rule: 'BUBBLEMAPS_UNAVAILABLE', msg: 'Bubblemaps / cluster data tidak tersedia — skip step 7' });
    return { rejects, warnings };
  }
  // Map rug check cluster/insider risks to virus_cluster_detected
  const risks = rugReport.risks || [];
  const hasVirusCluster = risks.some(r =>
    r.level === 'danger' && /cluster|insider|concentrated|linked/i.test(r.name || '')
  );
  if (hasVirusCluster) {
    rejects.push({ rule: 'VIRUS_CLUSTER_DETECTED', msg: 'Clustered wallets terdeteksi — insider control, REJECT' });
  }
  // Also check LP lock
  const lpLocked = rugReport.lpLockedPct || 0;
  if (lpLocked < 80) {
    rejects.push({ rule: 'LP_NOT_LOCKED', msg: `LP hanya ${lpLocked}% locked — dev bisa tarik likuiditas` });
  }
  return { rejects, warnings };
}

// ─── Main filter function ────────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '') {
  const [dexResult, gmgnResult, jupResult, rugResult] = await Promise.allSettled([
    getDexScreenerInfo(tokenMint),
    getGMGNData(tokenMint),
    getJupiterData(tokenMint),
    getRugCheckReport(tokenMint),
  ]);

  const dex = dexResult.status === 'fulfilled' ? dexResult.value : null;
  const gmgn = gmgnResult.status === 'fulfilled' ? gmgnResult.value : null;
  const jup  = jupResult.status === 'fulfilled'  ? jupResult.value  : null;
  const rug  = rugResult.status === 'fulfilled'  ? rugResult.value  : null;

  const name   = tokenName   || dex?.name   || jup?.name   || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  // Run all 7 steps
  const s1 = step1_basicValidation(dex);
  const s2 = step2_narrativeFilter(name, symbol, gmgn);
  const s3 = step3_gmgnTotalFees(gmgn);
  const s4 = step4_gmgnMetrics(gmgn);
  const s5 = step5_vampedCoins(gmgn);
  const s6 = step6_ctoCoins(name, symbol, gmgn);
  const s7 = step7_bubblemaps(rug);

  const allRejects = [
    ...s1,
    ...s2,
    ...s3.rejects,
    ...s4.rejects,
    ...s5,
    ...s6,
    ...s7.rejects,
  ];

  const allWarnings = [
    ...s3.warnings,
    ...s4.warnings,
    ...s7.warnings,
  ];

  // Verdict: any reject = AVOID, warnings only = CAUTION, clean = PASS
  let verdict;
  let safe = false;
  let eligible = false;

  if (allRejects.length > 0) {
    verdict = 'AVOID';
  } else if (allWarnings.length >= 2) {
    verdict = 'CAUTION';
  } else if (allWarnings.length === 1) {
    verdict = 'CAUTION';
  } else {
    verdict = 'PASS';
    safe = true;
    eligible = true;
  }

  return {
    tokenMint,
    name,
    symbol,
    verdict,           // AVOID | CAUTION | PASS
    safe,
    eligible,          // true = ELIGIBLE_FOR_DLMM
    highFlags:  allRejects,
    mediumFlags: allWarnings,
    allFlags:   [...allRejects, ...allWarnings],
    steps: { s1, s2, s3, s4, s5, s6, s7 },
    jupiterData: jup,
    rugScore:    rug?.score_normalised || null,
    lpLockedPct: rug?.lpLockedPct || null,
    sources: {
      dexscreener: !!dex,
      gmgn:        !!gmgn,
      jupiter:     !!(jup?.found),
      rugcheck:    !!rug,
    },
  };
}

// ─── Format for Telegram ─────────────────────────────────────────

export function formatScreenResult(result) {
  const emoji = {
    AVOID:   '🚫',
    CAUTION: '👀',
    PASS:    '✅',
  }[result.verdict] || '❓';

  const verdict_label = result.eligible ? 'ELIGIBLE FOR DLMM' : result.verdict;

  let text = `${emoji} *${result.name || result.symbol || result.tokenMint.slice(0, 8)}* — ${verdict_label}\n`;
  text += `\`${result.tokenMint.slice(0, 16)}...\`\n\n`;

  if (result.rugScore !== null)   text += `📊 RugCheck score: ${result.rugScore}/1000\n`;
  if (result.lpLockedPct !== null) text += `🔒 LP Locked: ${result.lpLockedPct}%\n`;
  if (result.jupiterData?.found) {
    const jupStatus = result.jupiterData.isStrict ? '✅ Strict'
      : result.jupiterData.isVerified ? '✓ Verified' : '⚠️ Unverified';
    text += `🪐 Jupiter: ${jupStatus}`;
    if (result.jupiterData.priceUsd) text += ` | $${parseFloat(result.jupiterData.priceUsd).toFixed(6)}`;
    text += '\n';
  }
  if (!result.sources.gmgn) {
    text += `⚠️ GMGN: tidak tersedia — screening tidak lengkap\n`;
  }

  if (result.highFlags.length > 0) {
    text += `\n🔴 *Rejected (${result.highFlags.length}):*\n`;
    result.highFlags.forEach(f => text += `• ${f.msg}\n`);
  }
  if (result.mediumFlags.length > 0) {
    text += `\n🟡 *Warnings (${result.mediumFlags.length}):*\n`;
    result.mediumFlags.forEach(f => text += `• ${f.msg}\n`);
  }

  if (result.eligible) {
    text += `\n✅ Lolos semua 7 filter. Eligible for DLMM.`;
  }

  const srcList = Object.entries(result.sources).filter(([, v]) => v).map(([k]) => k).join(', ');
  text += `\n\n_Sources: ${srcList}_`;
  return text;
}
