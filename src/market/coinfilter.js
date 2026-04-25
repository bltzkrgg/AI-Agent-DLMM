import { fetchWithTimeout, safeNum, withExponentialBackoff } from '../utils/safeJson.js';
import { getConfig } from '../config.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { ensureIpv4First, getGmgnTokenInfo, getGmgnSecurity } from '../utils/gmgn.js';
import { getExternalVampedStatus } from '../utils/vampedSource.js';

const JUPITER_TOKEN_BASE = 'https://tokens.jup.ag';
const JUPITER_PRICE_BASE = 'https://api.jup.ag';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';


function buildOperatorHints(result) {
  const hints = [];
  const hasRule = (prefix) => (result.highFlags || []).some((f) => String(f.rule || '').startsWith(prefix));
  if (hasRule('GMGN_UNAVAILABLE') || hasRule('GMGN_INFO_MISSING') || hasRule('GMGN_SECURITY_MISSING')) {
    hints.push('GMGN sedang gangguan. Opsi aman: tunggu API pulih. Opsi adaptif: set `gmgnFailClosedCritical=false` sementara.');
  }
  if (hasRule('GMGN_TOTAL_FEES_LOW')) {
    hints.push('Token fee terlalu tipis. Turunkan `gmgnMinTotalFeesSol` kalau ingin lebih agresif.');
  }
  if (hasRule('TOKEN_TOO_NEW')) {
    hints.push('Token terlalu baru. Turunkan `minTokenAgeMinutes` jika mau buru early momentum.');
  }
  if (hasRule('BELOW_MIN_MCAP') || hasRule('MISSING_MCAP')) {
    hints.push('Gate market cap terlalu ketat/kurang data. Tuning `minMcap` sesuai style entry.');
  }
  return hints.slice(0, 2);
}

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function pickFirstNumber(objs, paths = []) {
  for (const path of paths) {
    for (const obj of objs) {
      const raw = getByPath(obj, path);
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function pickFirstBoolean(objs, paths = []) {
  for (const path of paths) {
    for (const obj of objs) {
      const raw = getByPath(obj, path);
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') return true;
      if (raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') return false;
    }
  }
  return null;
}

function pickFirstString(objs, paths = []) {
  for (const path of paths) {
    for (const obj of objs) {
      const raw = getByPath(obj, path);
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
  }
  return null;
}

function toRate(value) {
  const normalized = Number(
    typeof value === 'string'
      ? value.replace(/[%,$\s]/g, '')
      : value
  );
  if (!Number.isFinite(normalized)) return null;
  if (normalized < 0) return null;
  return normalized > 1 ? normalized / 100 : normalized;
}

function formatRatePct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  if (Math.abs(n) < 1e-9) return '0%';
  const pct = n * 100;
  if (Math.abs(pct) < 0.1) return `${pct.toFixed(3)}%`;
  if (Math.abs(pct) < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

function parseSolFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/,/g, '');
  const m = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*SOL\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function extractGmgnTotalFeesSol(info, sec) {
  const objs = [info, sec];
  const total = pickFirstNumber(objs, [
    'stat.total_fees_sol',
    'total_fees_sol',
    'total_fee',
    'stat.total_fee',
    'fees.total_sol',
    'fee.total_sol',
  ]);
  if (Number.isFinite(total) && total >= 0) {
    return { totalFeesSol: total, source: 'gmgn_total_field' };
  }

  const priority = pickFirstNumber(objs, [
    'stat.priority_tip_sol',
    'priority_tip_sol',
    'fees.priority_tip_sol',
    'fee.priority_tip_sol',
  ]);
  const trading = pickFirstNumber(objs, [
    'stat.trading_fees_sol',
    'trading_fees_sol',
    'fees.trading_fees_sol',
    'fee.trading_fees_sol',
  ]);

  if (Number.isFinite(priority) || Number.isFinite(trading)) {
    return {
      totalFeesSol: (Number.isFinite(priority) ? priority : 0) + (Number.isFinite(trading) ? trading : 0),
      source: 'gmgn_priority_plus_trading',
    };
  }

  // UI fallback text parser (contoh: "Prio & Tip & Trading Fees 1,375.74 SOL")
  const feesText = pickFirstString(objs, [
    'stat.total_fees_text',
    'stat.fees_text',
    'fees.text',
    'fee.text',
    'display.total_fees',
    'display.totalFees',
    'tooltip.total_fees',
    'tooltip.totalFees',
  ]);
  const parsedTextFees = parseSolFromText(feesText);
  if (Number.isFinite(parsedTextFees)) {
    return { totalFeesSol: parsedTextFees, source: 'gmgn_text_total_fees' };
  }

  return { totalFeesSol: null, source: 'missing' };
}

function isVampedCoin(info, sec) {
  const flag = pickFirstBoolean([info, sec], [
    'dev.vamped_flag',
    'dev.is_vamped',
    'stat.is_vamped',
    'is_vamped',
    'vamped',
  ]);
  if (flag === true) return true;

  // UI/tag fallback (contoh label: "Vamped by RapidLaunch")
  const vampedLabel = pickFirstString([info, sec], [
    'dev.vamped_label',
    'dev.vamped_text',
    'stat.vamped_text',
    'flags.vamped_text',
    'risk.vamped_text',
    'risk_label',
    'riskLabel',
    'tag_text',
    'tags_text',
  ]);
  if (vampedLabel && /vamped\s+by\s+rapidlaunch/i.test(vampedLabel)) return true;

  const tagCandidates = []
    .concat(Array.isArray(info?.tags) ? info.tags : [])
    .concat(Array.isArray(sec?.tags) ? sec.tags : [])
    .concat(Array.isArray(info?.flags) ? info.flags : [])
    .concat(Array.isArray(sec?.flags) ? sec.flags : [])
    .concat(Array.isArray(info?.risk_tags) ? info.risk_tags : [])
    .concat(Array.isArray(sec?.risk_tags) ? sec.risk_tags : []);
  if (tagCandidates.some((t) => {
    if (typeof t === 'string') return /vamped\s+by\s+rapidlaunch/i.test(t);
    if (t && typeof t === 'object') {
      const label = String(t.label || t.name || t.text || '').toLowerCase();
      return /vamped\s+by\s+rapidlaunch/.test(label);
    }
    return false;
  })) return true;

  const launchpadText = `${String(info?.launchpad || '')} ${String(info?.launchpad_platform || '')} ${String(sec?.launchpad || '')}`.toLowerCase();
  if (/rapidlaunch/.test(launchpadText) && (/\bvamped\b/.test(launchpadText) || /liquidity\s+vampire/.test(launchpadText))) return true;

  return false;
}

// ─── Data fetchers ───────────────────────────────────────────────

async function getBirdeyeMarketInfo(tokenMint) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await withExponentialBackoff(async () => {
      const r = await fetchWithTimeout(
        `${BIRDEYE_BASE}/defi/token_overview?address=${tokenMint}`,
        {
          headers: {
            'X-API-KEY': apiKey,
            'x-chain': 'solana',
            Accept: 'application/json',
          },
        },
        8000,
      );
      if (r.status === 429) throw new Error('BIRDEYE_429');
      if (!r.ok) throw new Error(`BIRDEYE_HTTP_${r.status}`);
      return r;
    }, { maxRetries: 3, baseDelay: 1200 });
    const json = await res.json().catch(() => null);
    const data = json?.data || null;
    if (!data) return null;
    return {
      name: data.name || '',
      symbol: data.symbol || '',
      liquidity: safeNum(data.liquidity),
      fdv: safeNum(data.mc || data.fdv || data.marketCap),
      priceChangeM5: safeNum(data.priceChange5mPercent),
      priceChange1h: safeNum(data.priceChange1hPercent),
      priceChange6h: safeNum(data.priceChange6hPercent),
      priceChange24h: safeNum(data.priceChange24hPercent),
      volume24h: safeNum(data.v24hUSD || data.volume24hUSD),
      priceUsd: safeNum(data.price),
      pairCreatedAt: null,
    };
  } catch {
    return null;
  }
}

function normalizeGmgnMarket(info, sec, birdeye, jup, fallbackName = '', fallbackSymbol = '') {
  if (!info && !sec && !birdeye && !jup) return null;
  const createdRaw = pickFirstNumber([info, sec], [
    'created_timestamp',
    'open_timestamp',
    'pair_created_at',
    'pool.created_timestamp',
    'pool.open_timestamp',
  ]);
  const pairCreatedAt = createdRaw
    ? (createdRaw > 1e12 ? createdRaw : createdRaw * 1000)
    : null;
  const txns1h = pickFirstNumber([info, sec], ['stat.swaps_1h', 'stat.txns_1h', 'swaps_1h']) || 0;
  const sells1h = pickFirstNumber([info, sec], ['stat.sells_1h', 'sells_1h']) || 0;
  const txns24h = pickFirstNumber([info, sec], ['stat.swaps_24h', 'stat.txns_24h', 'swaps_24h']) || 0;
  const sells24h = pickFirstNumber([info, sec], ['stat.sells_24h', 'sells_24h']) || 0;
  const totalFees = extractGmgnTotalFeesSol(info, sec);
  return {
    name: fallbackName || pickFirstString([info, sec], ['name', 'token.name']) || birdeye?.name || jup?.name || '',
    symbol: fallbackSymbol || pickFirstString([info, sec], ['symbol', 'token.symbol']) || birdeye?.symbol || jup?.symbol || '',
    hasImage: Boolean(pickFirstString([info, sec], ['logo', 'logo_url', 'image', 'image_url', 'token.logo'])),
    hasSocials: Boolean(pickFirstString([info, sec], ['twitter', 'telegram', 'website', 'token.twitter', 'token.website'])),
    liquidity: pickFirstNumber([info, sec], ['liquidity', 'pool.liquidity', 'liquidity_usd']) || birdeye?.liquidity || 0,
    fdv: pickFirstNumber([info, sec], ['market_cap', 'fdv', 'usd_market_cap']) || birdeye?.fdv || 0,
    priceChangeM5: pickFirstNumber([info, sec], ['price_change_5m', 'priceChange.m5', 'stat.price_change_5m']) || birdeye?.priceChangeM5 || 0,
    priceChange1h: pickFirstNumber([info, sec], ['price_change_1h', 'priceChange.h1', 'stat.price_change_1h']) || birdeye?.priceChange1h || 0,
    priceChange6h: pickFirstNumber([info, sec], ['price_change_6h', 'priceChange.h6', 'stat.price_change_6h']) || birdeye?.priceChange6h || 0,
    priceChange24h: pickFirstNumber([info, sec], ['price_change_24h', 'priceChange.h24', 'stat.price_change_24h']) || birdeye?.priceChange24h || 0,
    volume24h: pickFirstNumber([info, sec], ['volume_24h', 'volume24h', 'stat.volume_24h']) || birdeye?.volume24h || 0,
    fees24h: Number.isFinite(totalFees.totalFeesSol) ? totalFees.totalFeesSol : 0,
    priceUsd: pickFirstNumber([info, sec], ['price', 'price_usd', 'usd_price']) || birdeye?.priceUsd || jup?.priceUsd || 0,
    buys1h: Math.max(0, txns1h - sells1h),
    sells1h,
    buys24h: Math.max(0, txns24h - sells24h),
    sells24h,
    pairCreatedAt: pairCreatedAt || birdeye?.pairCreatedAt || null,
  };
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

function step1_basicValidation(market, jup) {
  const rejects = [];
  const warnings = [];
  if (!market) {
    rejects.push({ rule: 'NO_MARKET_DATA', msg: 'Data market GMGN/Birdeye tidak tersedia' });
    return { rejects, warnings };
  }
  if (!market.hasImage) warnings.push({ rule: 'NO_LOGO', msg: 'Token tidak punya logo.' });
  if (!market.hasSocials) warnings.push({ rule: 'NO_PROFILE', msg: 'Token tidak punya profile/sosial resmi.' });
  return { rejects, warnings };
}

function step2_narrativeFilter(name, symbol, cfg = {}) {
  const rejects = [];
  const text = `${name} ${symbol}`.toLowerCase();
  const banned = Array.isArray(cfg.bannedNarratives) ? cfg.bannedNarratives : [];
  for (const word of banned) {
    if (!word) continue;
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) {
      rejects.push({ rule: 'BANNED_NARRATIVE', msg: `Banned narrative "${word}": "${name}" — rejected by config` });
      break;
    }
  }
  return rejects;
}

function step3_priceHealth(market, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  if (!market) return { rejects, warnings };

  if (market.priceChange1h < -20)
    warnings.push({ rule: 'HEAVY_DUMP_1H', msg: `Harga turun ${market.priceChange1h}% (1h) — Risiko tinggi, tapi peluang serok buat Panda` });
  else if (market.priceChange1h < -10)
    warnings.push({ rule: 'PRICE_CORRECTION', msg: `Harga terkoreksi ${market.priceChange1h}% (1h) — Monitor area support` });

  if (market.priceChange24h > 250)
    warnings.push({ rule: 'BUBBLE_DETECTED', msg: `Harga naik ${market.priceChange24h.toFixed(0)}% dalam 24h — Volatilitas masif, siap meraup fee` });

  return { rejects, warnings };
}

// ─── Step 4: Token Minimum Age ──────────────────────────────────
// Reject tokens that are too new — early minutes have extreme dump risk from
// bundlers/insiders who bought before launch. Wait for initial distribution to settle.
function step4_tokenAge(market, minAgeMinutes = 60) {
  const rejects = [];
  if (!market?.pairCreatedAt) return { rejects }; // Data tidak tersedia → skip

  const ageMs = Date.now() - market.pairCreatedAt;
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

function step5_txnAnalysis(market) {
  const rejects = [];
  const warnings = [];
  if (!market) return { rejects, warnings };

  const total1h = market.buys1h + market.sells1h;
  if (total1h > 10) {
    const sellRatio = market.sells1h / total1h;
    // Sniper Hardening: Ubah jadi Warning biar Panda bisa deteksi capitulation
    if (sellRatio > 0.70)
      warnings.push({ rule: 'EXTREME_SELLING_1H', msg: `${(sellRatio * 100).toFixed(0)}% txn h1 adalah SELL — Potensi capitulation/serok bawah` });
    else if (sellRatio > 0.60)
      warnings.push({ rule: 'HEAVY_SELLING_1H', msg: `${(sellRatio * 100).toFixed(0)}% txn h1 adalah SELL` });
  }

  // Final Spike Protection: Berubah ke warning agar bisa jaring koin liar
  if (market.priceChangeM5 > 15)
    warnings.push({ rule: 'PRICE_SPIKE_M5', msg: `Harga meledak ${market.priceChangeM5.toFixed(1)}% dlm 5 menit — Momentum kuat, siap tangkap volatilitas` });

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

function step7_organicScore(market, jup, thresholds) {
  const rejects = [];
  const warnings = [];
  const minOrganic = thresholds.minOrganic;
  let score = 0;

  if (market?.hasImage) score += 10;
  if (market?.hasSocials) score += 10;
  if (jup?.isStrict) score += 15;

  if (market) {
    if (market.volume24h >= 1000000) score += 30; // Volume Sultan
    else if (market.volume24h >= 100000) score += 20;
    else if (market.volume24h >= 50000) score += 10;

    if ((market.buys24h + market.sells24h) >= 500) score += 20; // Pool super aktif
    else if ((market.buys24h + market.sells24h) >= 100) score += 10;

  }

  if (market) {
    if (market.priceChange1h >= -10) score += 15;
  }

  score = Math.max(0, Math.min(100, score));

  if (score < minOrganic)
    rejects.push({ rule: 'LOW_ORGANIC_SCORE', msg: `Organic score: ${score}/100 (<${minOrganic})` });

  return { rejects, warnings, score };
}

function step8_volumeFilter(market, thresholds) {
  const rejects = [];
  if (!market) return { rejects, volume24h: null };
  const minVolume24h = Number(thresholds.minVolume24h || 0);
  const volume24h = safeNum(market.volume24h);
  if (minVolume24h > 0 && volume24h < minVolume24h) {
    rejects.push({
      rule: 'BELOW_MIN_VOLUME_24H',
      msg: `Volume 24h $${volume24h.toLocaleString()} < min $${minVolume24h.toLocaleString()}`,
    });
  }
  return { rejects, volume24h };
}

function step9_mcapFilter(marketCap, thresholds) {
  const rejects = [];
  const warnings = [];
  const minMcap = thresholds.minMcap;
  const maxMcap = thresholds.maxMcap;
  const mcap = marketCap || null;

  if (mcap === null) {
    warnings.push({ rule: 'MISSING_MCAP', msg: 'Data Market Cap kosong — lanjut dengan guard lain (volume/GMGN).' });
    return { rejects, warnings, mcap: null, skipped: true };
  }

  if (minMcap > 0 && mcap < minMcap)
    rejects.push({ rule: 'BELOW_MIN_MCAP', msg: `Mcap $${mcap.toLocaleString()} < min $${minMcap.toLocaleString()}` });
  if (maxMcap > 0 && mcap > maxMcap)
    rejects.push({ rule: 'ABOVE_MAX_MCAP', msg: `Mcap $${mcap.toLocaleString()} > max $${maxMcap.toLocaleString()}` });

  return { rejects, warnings, mcap, skipped: false };
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
    await ensureIpv4First();
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

function step14_feeIntegrity({ info, sec, market, solPrice, thresholds }) {
  const rejects = [];
  const minFeesSol = Number.isFinite(thresholds.gmgnMinTotalFeesSol)
    ? thresholds.gmgnMinTotalFeesSol
    : (thresholds.minTokenFeesSol || 0);
  let totalFeesSol = null;
  let feeSource = 'unknown';
  let usedFallback = false;

  if (minFeesSol <= 0) return { rejects, totalFeesSol, feeSource, usedFallback };

  const gmgnFees = extractGmgnTotalFeesSol(info, sec);
  if (Number.isFinite(gmgnFees.totalFeesSol)) {
    totalFeesSol = gmgnFees.totalFeesSol;
    feeSource = gmgnFees.source;
    if (totalFeesSol < minFeesSol) {
      rejects.push({
        rule: 'GMGN_TOTAL_FEES_LOW',
        msg: `Total fees GMGN rendah (${totalFeesSol.toFixed(2)} SOL < ${minFeesSol} SOL).`
      });
    }
    return { rejects, totalFeesSol, feeSource, usedFallback };
  }

  if (market && solPrice > 0) {
    const marketFees24h = Number.isFinite(market.fees24h) && market.fees24h > 0
      ? market.fees24h
      : (Number.isFinite(market.volume24h) && market.volume24h > 0 ? market.volume24h * 0.0025 : 0); // 0.25% conservative fee proxy

    if (marketFees24h <= 0) {
      rejects.push({
        rule: 'FEE_FALLBACK_DATA_MISSING',
        msg: 'Fallback fee data tidak tersedia (GMGN/Birdeye fees/volume kosong) — fail-closed.'
      });
      return { rejects, totalFeesSol, feeSource: 'missing', usedFallback };
    }

    totalFeesSol = marketFees24h / solPrice;
    feeSource = Number.isFinite(market.fees24h) && market.fees24h > 0
      ? 'gmgn_market_fees24h_fallback'
      : 'gmgn_market_volume_proxy_fallback';
    usedFallback = true;
    if (totalFeesSol < minFeesSol) {
      rejects.push({
        rule: 'FEE_VOLUME_INSUFFICIENT',
        msg: `Fallback fee rendah (${totalFeesSol.toFixed(2)} SOL < ${minFeesSol} SOL).`
      });
    }
    return { rejects, totalFeesSol, feeSource, usedFallback };
  }

  rejects.push({
    rule: 'GMGN_TOTAL_FEES_MISSING',
    msg: 'Data total fees GMGN kosong dan fallback fee GMGN/Birdeye tidak tersedia — fail-closed.'
  });
  feeSource = 'missing';
  return { rejects, totalFeesSol, feeSource, usedFallback };
}

// ─── Step 12: GMGN On-Chain Security ─────────────────────────────
// "Trip Wire" logic: rejects only when GMGN CONFIRMS a bad signal.
// null values = data unavailable = proceed (no blocking on absence of evidence).

function step12_gmgnSecurity(info, sec, thresholds = {}) {
  const rejects = [];
  const warnings = [];
  const failClosed = thresholds.gmgnFailClosedCritical !== false;
  const top10Max = (Number(thresholds.gmgnTop10HolderMaxPct ?? 30) / 100);
  const devHoldMax = (Number(thresholds.gmgnDevHoldMaxPct ?? 5) / 100);
  const insiderMax = (Number(thresholds.gmgnInsiderMaxPct ?? 0) / 100);
  const bundlerMax = (Number(thresholds.gmgnBundlerMaxPct ?? 60) / 100);
  const phishingMax = (Number(thresholds.gmgnPhishingMaxPct ?? 30) / 100);
  const rugRatioMax = Number(thresholds.gmgnRugRatioMax ?? 0.30);
  const rugHistoryMissingFailClosed = thresholds.gmgnRugHistoryMissingFailClosed === true;
  const washTradeMax = Number(thresholds.gmgnWashTradeMaxPct ?? 35);
  const requireBurnedLp = thresholds.gmgnRequireBurnedLp !== false;
  const requireZeroTax = thresholds.gmgnRequireZeroTax !== false;
  const blockCto = thresholds.gmgnBlockCto !== false;
  const blockVamped = thresholds.gmgnBlockVamped !== false;

  // Strict mode: GMGN wajib ada untuk keputusan entry
  if (!info && failClosed) rejects.push({ rule: 'GMGN_INFO_MISSING', msg: 'GMGN info tidak tersedia — fail-closed.' });
  if (!sec && failClosed) rejects.push({ rule: 'GMGN_SECURITY_MISSING', msg: 'GMGN security tidak tersedia — fail-closed.' });
  if (!info || !sec) return { rejects, warnings, fallbackFlags: { vampedFallback: false } };

  // ─── From token info ─────────────────────────────────────────
  if (info) {
    // CTO Coin (Community Takeover) — original dev abandoned, risky in early phase
    const ctoFlag = info.dev?.cto_flag;
    if (ctoFlag == null && failClosed && blockCto) {
      rejects.push({ rule: 'GMGN_CTO_DATA_MISSING', msg: 'Data CTO flag GMGN kosong — fail-closed.' });
    } else if (blockCto && Number(ctoFlag) === 1) {
      rejects.push({ rule: 'GMGN_CTO_COIN', msg: 'CTO Coin (dev.cto_flag=1) — dev original kabur, risiko manipulasi oleh komunitas/dev baru' });
    }

    // Phishing / Entrapment trader pattern
    const entrapment = info.stat?.top_entrapment_trader_percentage;
    const entrapmentRate = toRate(entrapment);
    if (entrapmentRate == null && failClosed) {
      rejects.push({ rule: 'GMGN_PHISHING_DATA_MISSING', msg: 'Data phishing/entrapment GMGN kosong — fail-closed.' });
    } else if (entrapmentRate > phishingMax) {
      rejects.push({ rule: 'GMGN_PHISHING_RISK', msg: `Entrapment traders ${(entrapmentRate * 100).toFixed(1)}% > ${(phishingMax * 100).toFixed(1)}% — pola jebakan terorganisir` });
    }

    // Top 10 concentration
    const top10 = info.stat?.top_10_holder_rate;
    const top10Rate = toRate(top10);
    if (top10Rate == null && failClosed) {
      rejects.push({ rule: 'GMGN_TOP10_DATA_MISSING', msg: 'Data top 10 holder GMGN kosong — fail-closed.' });
    } else if (top10Rate > top10Max) {
      rejects.push({ rule: 'GMGN_TOP10_CONCENTRATED', msg: `Top 10 holders ${(top10Rate * 100).toFixed(1)}% > ${(top10Max * 100).toFixed(1)}% — risiko whale dump` });
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
    if (suspectedInsider != null && suspectedInsider > insiderMax) {
      rejects.push({ rule: 'GMGN_SHADOW_WALLETS', msg: `Shadow Wallets (Insiders) memegang ${(suspectedInsider * 100).toFixed(1)}% supply — REJECT` });
    }

    // Rat Traders / Insider Front-running (HARD REJECT L6)
    const insiderRate = sec.rat_trader_amount_rate ?? info?.stat?.top_rat_trader_percentage;
    const insiderRatio = toRate(insiderRate);
    if (insiderRatio == null && failClosed) {
      rejects.push({ rule: 'GMGN_INSIDER_DATA_MISSING', msg: 'Data insider GMGN kosong — fail-closed.' });
    } else if (insiderRatio > insiderMax) {
      rejects.push({
        rule: 'GMGN_INSIDER_DETECTED',
        msg: `Insider/rat trader terdeteksi di volume (${formatRatePct(insiderRatio)}) > batas ${formatRatePct(insiderMax)} — REJECT`,
      });
    }

    // Creator/dev concentration
    const creatorRate = toRate(sec.creator_balance_rate ?? info?.stat?.dev_team_hold_rate ?? info?.stat?.creator_hold_rate);
    if (creatorRate == null && failClosed) {
      rejects.push({ rule: 'GMGN_DEV_HOLD_DATA_MISSING', msg: 'Data kepemilikan dev/creator kosong — fail-closed.' });
    } else if (creatorRate > devHoldMax) {
      rejects.push({ rule: 'GMGN_DEV_HOLD_HIGH', msg: `Kepemilikan dev ${(creatorRate * 100).toFixed(1)}% > ${(devHoldMax * 100).toFixed(1)}% — risiko dump` });
    }

    // Bundling threshold 60%
    const bundlerRate = sec.bundler_trader_amount_rate ?? info?.stat?.top_bundler_trader_percentage;
    const bundlerRatio = toRate(bundlerRate);
    if (bundlerRatio == null && failClosed) {
      rejects.push({ rule: 'GMGN_BUNDLER_DATA_MISSING', msg: 'Data bundler GMGN kosong — fail-closed.' });
    } else if (bundlerRatio > bundlerMax) {
      rejects.push({ rule: 'GMGN_BUNDLED', msg: `Bundling ${(bundlerRatio * 100).toFixed(1)}% > ${(bundlerMax * 100).toFixed(1)}% — dominasi gerombolan tertentu` });
    }

    // LP burn status
    if (requireBurnedLp && (sec.burn_status == null || sec.burn_status === '') && failClosed) {
      rejects.push({ rule: 'GMGN_LP_BURN_DATA_MISSING', msg: 'Data burn status LP kosong — fail-closed.' });
    } else if (requireBurnedLp && sec.burn_status !== 'burn') {
      rejects.push({ rule: 'GMGN_LP_NOT_BURNED', msg: `LP tidak dibakar (status: "${sec.burn_status}") — risiko tarik likuiditas (Rug)` });
    }

    // Rug risk score
    const rugRatio = sec.rug_ratio ?? info?.dev?.rug_ratio;
    if (rugRatio == null) {
      if (failClosed && rugHistoryMissingFailClosed) {
        rejects.push({ rule: 'GMGN_RUG_HISTORY_DATA_MISSING', msg: 'Data riwayat rug dev kosong — fail-closed.' });
      } else {
        warnings.push({ rule: 'GMGN_RUG_HISTORY_DATA_MISSING', msg: 'Data riwayat rug dev kosong — treated as neutral (pass).' });
      }
    } else if (rugRatio > rugRatioMax) {
      rejects.push({ rule: 'GMGN_RUG_HISTORY', msg: `Rug risk score ${rugRatio.toFixed(2)} > ${rugRatioMax.toFixed(2)} — deployer mencurigakan` });
    }

    // 🎭 METADATA SECURITY: Anti-Bunglon (Hard Reject)
    if (sec.is_mutable_metadata === true) {
      rejects.push({ rule: 'GMGN_MUTABLE_METADATA', msg: 'Metadata koin masih bisa diubah (Mutable) — risiko ganti nama/logo/symbol di tengah jalan' });
    }

    // 💸 ZERO TAX SHIELD: Anti-Pajak Siluman (Irit Mode Level Max)
    const buyTax = parseFloat(sec.buy_tax || 0);
    const sellTax = parseFloat(sec.sell_tax || 0);
    if (requireZeroTax && (buyTax > 0 || sellTax > 0)) {
      rejects.push({ rule: 'GMGN_TAX_DETECTED', msg: `Pajak terdeteksi (Beli: ${buyTax}%, Jual: ${sellTax}%) — Gak Irit, skip!` });
    }

    // 🍯 HONEYPOT GUARD: Anti-Jebakan (Hard Reject)
    if (sec.is_honeypot === true) {
      rejects.push({ rule: 'GMGN_HONEYPOT', msg: 'Honeypot terdeteksi! Koin tidak bisa dijual — REJECT' });
    }

    // 🎭 WASH-TRADE GUARD: Anti-Volume Palsu
    const washRate = parseFloat(sec.wash_trading_percentage || 0);
    if (washRate > washTradeMax) {
      rejects.push({ rule: 'GMGN_WASH_TRADE', msg: `Wash trading tinggi (${washRate.toFixed(1)}%) — manipulasi volume oleh dev` });
    }
  }

  // Vamped fallback: jika indikator explicit tidak ada, pakai proxy rules lama sementara
  const hasExplicitVamped = isVampedCoin(info, sec);
  if (blockVamped && hasExplicitVamped === true) {
    rejects.push({ rule: 'GMGN_VAMPED_COIN', msg: 'Vamped coin terdeteksi (liquidity vampire) — REJECT' });
  } else {
    const hasRawVampedField = pickFirstBoolean([info, sec], [
      'dev.vamped_flag',
      'dev.is_vamped',
      'stat.is_vamped',
      'is_vamped',
      'vamped',
    ]);
    const proxyTriggered = (
      (blockCto && info?.dev?.cto_flag === 1) ||
      (Number(sec?.rug_ratio ?? info?.dev?.rug_ratio) > rugRatioMax) ||
      (toRate(sec?.bundler_trader_amount_rate ?? info?.stat?.top_bundler_trader_percentage) > bundlerMax) ||
      (toRate(sec?.rat_trader_amount_rate ?? info?.stat?.top_rat_trader_percentage) > insiderMax)
    );
    if (blockVamped && hasRawVampedField == null && proxyTriggered) {
      rejects.push({ rule: 'GMGN_VAMPED_PROXY_RED', msg: 'Vamped indicator GMGN kosong — proxy redflag aktif (CTO/RUG/Bundler/Insider).' });
    }
  }

  const hasRawVampedField = pickFirstBoolean([info, sec], [
    'dev.vamped_flag',
    'dev.is_vamped',
    'stat.is_vamped',
    'is_vamped',
    'vamped',
  ]);
  return { rejects, warnings, fallbackFlags: { vampedFallback: hasRawVampedField == null && hasExplicitVamped !== true } };
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
    minTokenFeesSol: cfg.minTokenFeesSol,
    gmgnMinTotalFeesSol: cfg.gmgnMinTotalFeesSol,
    gmgnTop10HolderMaxPct: cfg.gmgnTop10HolderMaxPct,
    gmgnDevHoldMaxPct: cfg.gmgnDevHoldMaxPct,
    gmgnInsiderMaxPct: cfg.gmgnInsiderMaxPct,
    gmgnBundlerMaxPct: cfg.gmgnBundlerMaxPct,
    gmgnPhishingMaxPct: cfg.gmgnPhishingMaxPct,
    gmgnRugRatioMax: cfg.gmgnRugRatioMax,
    gmgnRugHistoryMissingFailClosed: cfg.gmgnRugHistoryMissingFailClosed,
    gmgnWashTradeMaxPct: cfg.gmgnWashTradeMaxPct,
    gmgnRequireBurnedLp: cfg.gmgnRequireBurnedLp,
    gmgnRequireZeroTax: cfg.gmgnRequireZeroTax,
    gmgnBlockCto: cfg.gmgnBlockCto,
    gmgnBlockVamped: cfg.gmgnBlockVamped,
    gmgnFailClosedCritical: cfg.gmgnFailClosedCritical,
  };

  const deployAmount = cfg.deployAmountSol || 0.1;

  const [gmgnInfoResult, gmgnSecResult, birdeyeResult, jupResult, authResult, simResult, solPriceResult, vampedStatusResult] = await Promise.allSettled([
    getGmgnTokenInfo(tokenMint),
    getGmgnSecurity(tokenMint),
    getBirdeyeMarketInfo(tokenMint),
    getJupiterData(tokenMint),
    getOnChainAuthority(tokenMint),
    getSlippageSimulation(tokenMint, deployAmount),
    getJupiterPrice('So11111111111111111111111111111111111111112'),
    getExternalVampedStatus(tokenMint, cfg),
  ]);

  const gmgnInfo = gmgnInfoResult.status === 'fulfilled' ? gmgnInfoResult.value : null;
  const gmgnSec  = gmgnSecResult.status  === 'fulfilled' ? gmgnSecResult.value  : null;
  const birdeye  = birdeyeResult.status === 'fulfilled' ? birdeyeResult.value : null;
  const jup  = jupResult.status  === 'fulfilled' ? jupResult.value  : null;
  const auth = authResult.status === 'fulfilled' ? authResult.value : { mintAuthority: true, freezeAuthority: true };
  const sim  = simResult.status  === 'fulfilled' ? simResult.value  : null;
  const solPrice = solPriceResult.status === 'fulfilled' ? solPriceResult.value : 0;
  const vampedSource = vampedStatusResult.status === 'fulfilled'
    ? vampedStatusResult.value
    : { status: 'ERROR', isVamped: null, source: 'external', reason: 'promise_rejected' };

  const market = normalizeGmgnMarket(gmgnInfo, gmgnSec, birdeye, jup, tokenName, tokenSymbol);
  const name   = tokenName   || market?.name   || jup?.name   || '';
  const symbol = tokenSymbol || market?.symbol || jup?.symbol || '';

  const s1  = step1_basicValidation(market, jup);
  const s2  = step2_narrativeFilter(name, symbol, cfg);
  const s3  = step3_priceHealth(market, thresholds);
  const minTokenAgeMinutes = Number.isFinite(Number(cfg.minTokenAgeMinutes))
    ? Number(cfg.minTokenAgeMinutes)
    : 60;
  const s4  = step4_tokenAge(market, minTokenAgeMinutes);
  const s5  = step5_txnAnalysis(market);
  const s6  = step6_tokenSafety(jup);
  const s7  = step7_organicScore(market, jup, thresholds);
  const s8  = step8_volumeFilter(market, thresholds);

  let mcap = market?.fdv || null;
  if (!mcap && auth?.supply && auth?.decimals) {
    const rawPrice = market?.priceUsd || (jup?.found ? await getJupiterPrice(tokenMint) : 0);
    if (rawPrice > 0) {
      const supplyFixed = auth.supply / Math.pow(10, auth.decimals);
      mcap = rawPrice * supplyFixed;
    }
  }

  const s9  = step9_mcapFilter(mcap, thresholds);
  const s10 = step10_authorityCheck(auth);
  const s11 = step11_slippageCheck(sim, thresholds.maxImpact);

  const preGmgnRejects = [
    ...s1.rejects,
    ...s2,
    ...s3.rejects,
    ...s4.rejects,
    ...s5.rejects,
    ...s6.rejects,
    ...s7.rejects,
    ...s8.rejects,
    ...s9.rejects,
    ...s10,
    ...s11.rejects,
  ];
  const preGmgnWarnings = [
    ...s1.warnings,
    ...s3.warnings,
    ...s5.warnings,
    ...s6.warnings,
    ...s9.warnings,
    ...s11.warnings,
  ];

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

  const s12 = step12_gmgnSecurity(gmgnInfo, gmgnSec, thresholds);
  const s14 = step14_feeIntegrity({ info: gmgnInfo, sec: gmgnSec, market, solPrice, thresholds });

  const allRejects = [
    ...preGmgnRejects,
    ...((thresholds.gmgnFailClosedCritical !== false) && gmgnStatus !== 'ACTIVE'
      ? [{ rule: 'GMGN_UNAVAILABLE_FAIL_CLOSED', msg: `GMGN status=${gmgnStatus} — entry diblokir (fail-closed).` }]
      : []),
    ...s12.rejects,
    ...s14.rejects,
    ...(cfg.vampedSourceEnabled === true && cfg.vampedSourceFailClosed === true && vampedSource.status !== 'OK'
      ? [{ rule: 'VAMPED_SOURCE_UNAVAILABLE', msg: `Vamped source ${vampedSource.status} (${vampedSource.reason || 'unknown'}) — fail-closed.` }]
      : []),
    ...(cfg.vampedSourceEnabled === true && vampedSource.status === 'OK' && vampedSource.isVamped === true
      ? [{ rule: 'VAMPED_SOURCE_DETECTED', msg: 'Token ditandai VAMPED oleh source eksternal (RapidLaunch/provider).' }]
      : []),
  ];
  const allWarnings = [
    ...preGmgnWarnings,
    ...s12.warnings,
  ];

  let verdict = allRejects.length > 0 ? 'AVOID' : (allWarnings.length > 0 ? 'CAUTION' : 'PASS');
  const stageFunnel = {
    stage1_gmgn_gate: preGmgnRejects.length === 0 ? 'PASS' : 'FAIL',
    stage2_gmgn_availability: gmgnStatus === 'ACTIVE' ? 'PASS' : 'FAIL',
    stage3_gmgn_security: s12.rejects.length === 0 ? 'PASS' : 'FAIL',
    stage4_fee_integrity: s14.rejects.length === 0 ? 'PASS' : 'FAIL',
    final: allRejects.length === 0 ? 'PASSED' : 'REJECTED',
  };

  const result = {
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
    gmgnFallbackFeesUsed: s14.usedFallback,
    totalFeesSol: s14.totalFeesSol,
    totalFeesSource: s14.feeSource,
    vampedSourceStatus: vampedSource.status,
    vampedSourceReason: vampedSource.reason,
    isVampedBySource: vampedSource.isVamped === true,
    stageFunnel,
    sources: {
      market: !!market,
      birdeye: !!birdeye,
      jupiter: !!(jup?.found),
      helius: (authResult.status === 'fulfilled'),
      gmgn: (gmgnStatus === 'ACTIVE'),
    },
  };
  result.operatorHints = buildOperatorHints(result);
  return result;
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
  if (Number.isFinite(result.totalFeesSol)) {
    text += `💸 Total Fees: ${result.totalFeesSol.toFixed(2)} SOL (${result.totalFeesSource || 'unknown'})\n`;
    if (result.gmgnFallbackFeesUsed) {
      text += `⚠️ Fee source fallback market dipakai karena field GMGN belum lengkap.\n`;
    }
  }
  if (result.vampedSourceStatus) {
    text += `🧛 Vamped Source: ${result.vampedSourceStatus}`;
    if (result.isVampedBySource) text += ' (VAMPED)';
    if (result.vampedSourceReason) text += ` — ${result.vampedSourceReason}`;
    text += '\n';
  }

  if (result.stageFunnel) {
    text += `\n🧭 *Funnel:* GMGN-Gate=${result.stageFunnel.stage1_gmgn_gate} → GMGN-API=${result.stageFunnel.stage2_gmgn_availability} → GMGN-Sec=${result.stageFunnel.stage3_gmgn_security} → Fee=${result.stageFunnel.stage4_fee_integrity} → Final=${result.stageFunnel.final}\n`;
  }

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
  if (Array.isArray(result.operatorHints) && result.operatorHints.length > 0) {
    text += `\n💡 *Saran Cepat:*\n`;
    result.operatorHints.forEach((h) => {
      text += `• ${h}\n`;
    });
  }

  if (result.eligible) text += `\n✅ Lolos semua filter — Eligible for DLMM.`;

  if (result.sources) {
    const srcList = Object.entries(result.sources).filter(([, v]) => v).map(([k]) => k).join(', ');
    text += `\n\n_Sources: ${srcList}_`;
  }
  return text;
}
