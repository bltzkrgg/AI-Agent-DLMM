/**
 * Scam Screener
 *
 * Combines:
 * 1. RugCheck API — on-chain risk scoring
 * 2. DexScreener — has image, has socials, coin category
 * 3. Article rules — patterns from experienced LPer
 */

import { fetchWithTimeout } from '../utils/safeJson.js';

const RUGCHECK_BASE = 'https://api.rugcheck.xyz';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const JUPITER_TOKEN_BASE = 'https://tokens.jup.ag';
const JUPITER_PRICE_BASE = 'https://api.jup.ag';

// ─── Red flag keywords dari artikel ─────────────────────────────
const SCAM_KEYWORDS = [
  'trump', 'elon', 'baron', 'melania', 'maga',
  'kanye', 'taylor', 'celebrity',
  'justice for', 'save ',
  'moo deng', 'peanut', 'tiktok',
  'cto', 'community takeover',
];

const POLITICAL_PATTERNS = [
  /trump/i, /elon/i, /baron/i, /melania/i, /biden/i,
  /maga/i, /kamala/i, /political/i,
];

const CELEBRITY_PATTERNS = [
  /kanye/i, /taylor swift/i, /kardashian/i, /justin/i,
];

const JUSTICE_PATTERNS = [
  /justice for/i, /save the/i, /rip /i, /remember /i,
];

// ─── RugCheck API ────────────────────────────────────────────────

async function getRugCheckReport(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${RUGCHECK_BASE}/v1/tokens/${tokenMint}/report/summary`,
      {
        headers: {
          'Authorization': process.env.RUGCHECK_API_KEY
            ? `Bearer ${process.env.RUGCHECK_API_KEY}`
            : '',
        },
      },
      8000
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── DexScreener check ───────────────────────────────────────────

async function getDexScreenerInfo(tokenMint) {
  try {
    const res = await fetchWithTimeout(`${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;

    const best = pairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      name: best.baseToken?.name || '',
      symbol: best.baseToken?.symbol || '',
      hasImage: !!(best.info?.imageUrl),
      hasSocials: !!(best.info?.socials?.length > 0 || best.info?.websites?.length > 0),
      websites: best.info?.websites || [],
      socials: best.info?.socials || [],
      liquidity: best.liquidity?.usd || 0,
      fdv: best.fdv || 0,
      priceChange24h: best.priceChange?.h24 || 0,
    };
  } catch {
    return null;
  }
}

// ─── Jupiter API ─────────────────────────────────────────────────

async function getJupiterData(tokenMint) {
  try {
    const [tokenRes, priceRes] = await Promise.allSettled([
      fetchWithTimeout(`${JUPITER_TOKEN_BASE}/token/${tokenMint}`, {}, 8000),
      fetchWithTimeout(`${JUPITER_PRICE_BASE}/price/v2?ids=${tokenMint}`, {}, 8000),
    ]);

    const tokenData = tokenRes.status === 'fulfilled' && tokenRes.value.ok
      ? await tokenRes.value.json().catch(() => null)
      : null;
    const priceData = priceRes.status === 'fulfilled' && priceRes.value.ok
      ? await priceRes.value.json().catch(() => null)
      : null;

    const priceInfo = priceData?.data?.[tokenMint];

    return {
      found: !!tokenData,
      name: tokenData?.name,
      symbol: tokenData?.symbol,
      tags: tokenData?.tags || [],
      isStrict: !!(tokenData?.tags?.includes('strict')),
      isVerified: !!(tokenData?.extensions?.coingeckoId || tokenData?.tags?.includes('verified')),
      launchpad: tokenData?.extensions?.launchpad || null,
      priceUsd: priceInfo?.price || null,
    };
  } catch {
    return null;
  }
}

function detectJupiterFlags(jupData) {
  const flags = [];

  if (!jupData || !jupData.found) {
    flags.push({ rule: 'NOT_ON_JUPITER', severity: 'MEDIUM', msg: 'Token tidak terdaftar di Jupiter — belum listed atau sangat baru' });
    return flags;
  }

  if (!jupData.isStrict && !jupData.isVerified) {
    flags.push({ rule: 'NOT_JUPITER_STRICT', severity: 'MEDIUM', msg: 'Token tidak masuk Jupiter strict list — belum diverifikasi komunitas' });
  }

  return flags;
}

// ─── Article-based pattern detection ────────────────────────────

function detectScamPatterns(tokenName, tokenSymbol, dexInfo) {
  const flags = [];
  const nameToCheck = `${tokenName} ${tokenSymbol}`.toLowerCase();

  // Rule 1: No image or socials
  if (dexInfo && !dexInfo.hasImage) {
    flags.push({ rule: 'NO_IMAGE', severity: 'HIGH', msg: 'Token tidak punya logo di DexScreener' });
  }
  if (dexInfo && !dexInfo.hasSocials) {
    flags.push({ rule: 'NO_SOCIALS', severity: 'HIGH', msg: 'Token tidak punya social links' });
  }

  // Rule 2: Political coins
  for (const pattern of POLITICAL_PATTERNS) {
    if (pattern.test(nameToCheck)) {
      flags.push({ rule: 'POLITICAL_COIN', severity: 'HIGH', msg: `Terdeteksi political coin: "${tokenName}" — biasanya rug cepat` });
      break;
    }
  }

  // Rule 3: Celebrity coins
  for (const pattern of CELEBRITY_PATTERNS) {
    if (pattern.test(nameToCheck)) {
      flags.push({ rule: 'CELEBRITY_COIN', severity: 'HIGH', msg: `Terdeteksi celebrity coin: "${tokenName}" — dev bisa dump kapan saja` });
      break;
    }
  }

  // Rule 4: Justice/victim coins
  for (const pattern of JUSTICE_PATTERNS) {
    if (pattern.test(nameToCheck)) {
      flags.push({ rule: 'JUSTICE_COIN', severity: 'HIGH', msg: `Terdeteksi "justice/save" coin: "${tokenName}" — classic rug pattern` });
      break;
    }
  }

  // Rule 5: CTO coins
  if (/\bcto\b/i.test(nameToCheck) || /community takeover/i.test(nameToCheck)) {
    flags.push({ rule: 'CTO_COIN', severity: 'MEDIUM', msg: 'CTO coin — new dev mungkin hanya ambil creator fees tanpa pump' });
  }

  return flags;
}

function detectRugCheckFlags(rugReport) {
  const flags = [];
  if (!rugReport) return flags;

  const score = rugReport.score_normalised || rugReport.score || 0;
  const risks = rugReport.risks || [];

  // High risk score
  if (score < 300) {
    flags.push({ rule: 'HIGH_RUG_SCORE', severity: 'HIGH', msg: `RugCheck score: ${score}/1000 — sangat berisiko` });
  } else if (score < 500) {
    flags.push({ rule: 'MEDIUM_RUG_SCORE', severity: 'MEDIUM', msg: `RugCheck score: ${score}/1000 — perlu hati-hati` });
  }

  // LP not locked
  const lpLocked = rugReport.lpLockedPct || 0;
  if (lpLocked < 80) {
    flags.push({ rule: 'LP_NOT_LOCKED', severity: 'HIGH', msg: `LP hanya ${lpLocked}% locked — dev bisa tarik likuiditas` });
  }

  // Specific risks from RugCheck
  for (const risk of risks) {
    if (risk.level === 'danger') {
      flags.push({
        rule: `RUGCHECK_${risk.name?.toUpperCase().replace(/\s/g, '_')}`,
        severity: 'HIGH',
        msg: `RugCheck: ${risk.name} — ${risk.description}`,
      });
    } else if (risk.level === 'warn') {
      flags.push({
        rule: `RUGCHECK_WARN_${risk.name?.toUpperCase().replace(/\s/g, '_')}`,
        severity: 'MEDIUM',
        msg: `RugCheck warning: ${risk.name}`,
      });
    }
  }

  return flags;
}

// ─── Main screener function ──────────────────────────────────────

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '') {
  // Fetch all data parallel — RugCheck + DexScreener + Jupiter
  const [rugReport, dexInfo, jupData] = await Promise.allSettled([
    getRugCheckReport(tokenMint),
    getDexScreenerInfo(tokenMint),
    getJupiterData(tokenMint),
  ]);

  const rug = rugReport.status === 'fulfilled' ? rugReport.value : null;
  const dex = dexInfo.status   === 'fulfilled' ? dexInfo.value   : null;
  const jup = jupData.status   === 'fulfilled' ? jupData.value   : null;

  const name   = tokenName   || dex?.name   || jup?.name   || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || jup?.symbol || '';

  const allFlags = [
    ...detectScamPatterns(name, symbol, dex),
    ...detectRugCheckFlags(rug),
    ...detectJupiterFlags(jup),
  ];

  const highFlags   = allFlags.filter(f => f.severity === 'HIGH');
  const mediumFlags = allFlags.filter(f => f.severity === 'MEDIUM');

  let verdict;
  let safe = false;

  if (highFlags.length >= 2) {
    verdict = 'AVOID';
  } else if (highFlags.length >= 1) {
    verdict = 'RISKY';
  } else if (mediumFlags.length >= 2) {
    verdict = 'CAUTION';
  } else {
    verdict = 'PASS';
    safe = true;
  }

  return {
    tokenMint,
    name,
    symbol,
    verdict,        // AVOID | RISKY | CAUTION | PASS
    safe,
    highFlags,
    mediumFlags,
    allFlags,
    rugScore:    rug?.score_normalised || null,
    lpLockedPct: rug?.lpLockedPct     || null,
    jupiterData: jup,
    sources: {
      rugcheck:    !!rug,
      dexscreener: !!dex,
      jupiter:     !!(jup?.found),
    },
  };
}

// ─── Format result for Telegram ──────────────────────────────────

export function formatScreenResult(result) {
  const emoji = {
    AVOID: '🚫',
    RISKY: '⚠️',
    CAUTION: '👀',
    PASS: '✅',
  }[result.verdict];

  let text = `${emoji} *${result.name || result.symbol || result.tokenMint.slice(0, 8)}* — ${result.verdict}\n`;
  text += `\`${result.tokenMint.slice(0, 16)}...\`\n\n`;

  if (result.rugScore !== null) {
    text += `📊 RugCheck score: ${result.rugScore}/1000\n`;
  }
  if (result.lpLockedPct !== null) {
    text += `🔒 LP Locked: ${result.lpLockedPct}%\n`;
  }
  if (result.jupiterData?.found) {
    const jupStatus = result.jupiterData.isStrict ? '✅ Strict'
      : result.jupiterData.isVerified ? '✓ Verified'
      : '⚠️ Unverified';
    text += `🪐 Jupiter: ${jupStatus}`;
    if (result.jupiterData.priceUsd) text += ` | $${parseFloat(result.jupiterData.priceUsd).toFixed(6)}`;
    text += '\n';
  }
  if (result.highFlags.length > 0) {
    text += `\n🔴 *Red Flags (${result.highFlags.length}):*\n`;
    result.highFlags.forEach(f => text += `• ${f.msg}\n`);
  }

  if (result.mediumFlags.length > 0) {
    text += `\n🟡 *Warnings (${result.mediumFlags.length}):*\n`;
    result.mediumFlags.forEach(f => text += `• ${f.msg}\n`);
  }

  if (result.safe) {
    text += `\n✅ Lolos semua screening. Lanjut cek chart.`;
  }

  text += `\n\n_Sources: ${Object.entries(result.sources).filter(([,v]) => v).map(([k]) => k).join(', ')}_`;
  return text;
}
