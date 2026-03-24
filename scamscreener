/**
 * Scam Screener
 * 
 * Combines:
 * 1. RugCheck API — on-chain risk scoring
 * 2. GMGN API — total fees, top holders, bundling, insiders
 * 3. DexScreener — has image, has socials, coin category
 * 4. Article rules — patterns from experienced LPer
 */

const RUGCHECK_BASE = 'https://api.rugcheck.xyz';
const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';

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
    const res = await fetch(
      `${RUGCHECK_BASE}/v1/tokens/${tokenMint}/report/summary`,
      {
        headers: {
          'Authorization': process.env.RUGCHECK_API_KEY
            ? `Bearer ${process.env.RUGCHECK_API_KEY}`
            : '',
        },
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── GMGN API ────────────────────────────────────────────────────

async function getGMGNData(tokenMint) {
  try {
    const res = await fetch(
      `${GMGN_BASE}/token/sol/${tokenMint}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GMGN_API_KEY || ''}`,
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch {
    return null;
  }
}

// ─── DexScreener check ───────────────────────────────────────────

async function getDexScreenerInfo(tokenMint) {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`);
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

function detectGMGNFlags(gmgnData) {
  const flags = [];
  if (!gmgnData) return flags;

  // Rule: Total fees indicator (dari artikel)
  const totalFees = gmgnData.total_fees || gmgnData.fees_24h || 0;
  if (totalFees < 20) {
    flags.push({ rule: 'LOW_FEES', severity: 'HIGH', msg: `Total fees ${totalFees} < 20 — sangat berisiko rug` });
  } else if (totalFees < 50) {
    flags.push({ rule: 'MEDIUM_FEES', severity: 'MEDIUM', msg: `Total fees ${totalFees} (20-50) — perlu cek chart lebih detail` });
  }

  // Rule: Top 10 holders
  const top10 = gmgnData.top10_holder_rate || gmgnData.holder_percentage?.top10 || 0;
  if (top10 > 30) {
    flags.push({ rule: 'HIGH_TOP10', severity: 'HIGH', msg: `Top 10 holders: ${top10}% (>30%) — whale bisa dump kapan saja` });
  }

  // Rule: Dev holdings
  const devHolding = gmgnData.dev_holding || 0;
  if (devHolding > 5) {
    flags.push({ rule: 'HIGH_DEV', severity: 'HIGH', msg: `Dev holding: ${devHolding}% (>5%) — red flag` });
  } else if (devHolding > 1) {
    flags.push({ rule: 'DEV_HAS_SUPPLY', severity: 'MEDIUM', msg: `Dev masih pegang ${devHolding}% supply — bisa dump kapan saja` });
  }

  // Rule: Insiders
  const insiders = gmgnData.insider_rate || 0;
  if (insiders > 0) {
    flags.push({ rule: 'HAS_INSIDERS', severity: 'HIGH', msg: `Insider rate: ${insiders}% (>0%) — ada wallet yang coordinated` });
  }

  // Rule: Phishing
  const phishing = gmgnData.phishing_rate || 0;
  if (phishing > 30) {
    flags.push({ rule: 'HIGH_PHISHING', severity: 'HIGH', msg: `Phishing rate: ${phishing}% (>30%) — sangat berbahaya` });
  }

  // Rule: Bundling
  const bundling = gmgnData.bundled_rate || 0;
  if (bundling > 60) {
    flags.push({ rule: 'HIGH_BUNDLING', severity: 'MEDIUM', msg: `Bundling: ${bundling}% (>60%) — mungkin alpha group call, bisa dump serentak` });
  }

  // Rule: Liquidity not burnt
  if (gmgnData.liquidity_burnt === false || gmgnData.renounced === false) {
    flags.push({ rule: 'LP_NOT_BURNT', severity: 'HIGH', msg: 'Initial liquidity tidak diburn — dev bisa tarik likuiditas kapan saja' });
  }

  // Rule: Vampire coin
  if (gmgnData.is_vampire || gmgnData.vampire) {
    flags.push({ rule: 'VAMPIRE_COIN', severity: 'HIGH', msg: 'Vampire coin terdeteksi — hanya untuk ekstrak likuiditas dari coin utama, hindari!' });
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
  // Fetch semua data parallel
  const [rugReport, gmgnData, dexInfo] = await Promise.allSettled([
    getRugCheckReport(tokenMint),
    getGMGNData(tokenMint),
    getDexScreenerInfo(tokenMint),
  ]);

  const rug = rugReport.status === 'fulfilled' ? rugReport.value : null;
  const gmgn = gmgnData.status === 'fulfilled' ? gmgnData.value : null;
  const dex = dexInfo.status === 'fulfilled' ? dexInfo.value : null;

  // Use name from DexScreener if not provided
  const name = tokenName || dex?.name || tokenSymbol || '';
  const symbol = tokenSymbol || dex?.symbol || '';

  // Collect all flags
  const allFlags = [
    ...detectScamPatterns(name, symbol, dex),
    ...detectGMGNFlags(gmgn),
    ...detectRugCheckFlags(rug),
  ];

  const highFlags = allFlags.filter(f => f.severity === 'HIGH');
  const mediumFlags = allFlags.filter(f => f.severity === 'MEDIUM');

  // Final verdict
  let verdict;
  let safe = false;

  if (highFlags.length >= 3) {
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
    rugScore: rug?.score_normalised || null,
    lpLockedPct: rug?.lpLockedPct || null,
    sources: {
      rugcheck: !!rug,
      gmgn: !!gmgn,
      dexscreener: !!dex,
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
