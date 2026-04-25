import crypto from 'crypto';
import { fetchWithTimeout, safeNum, withExponentialBackoff } from '../utils/safeJson.js';
import { getConfig } from '../config.js';
import { getJupiterPrice } from '../utils/jupiter.js';
import { ensureIpv4First, getGmgnTokenInfo, getGmgnSecurity } from '../utils/gmgn.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';
const OKX_BASE = 'https://web3.okx.com';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_BLACKLIST_TTL_MS = 24 * 60 * 60 * 1000;

const _jupiterFailBlacklist = new Map(); // mint -> { until, reason, ts }

function nowIso() {
  return new Date().toISOString();
}

function normalizeConfig(cfg = getConfig()) {
  const radar = cfg?.radar && typeof cfg.radar === 'object' ? cfg.radar : {};
  const read = (key, fallback) => {
    if (radar[key] !== undefined) return radar[key];
    if (cfg[key] !== undefined) return cfg[key];
    return fallback;
  };
  return {
    minMcap: Number(read('minMcap', 250000)) || 250000,
    minVolume24h: Number(read('minVolume24h', 1000000)) || 1000000,
    minTvl: Number(read('minTvl', 0)) || 0,
    maxMcap: Number(read('maxMcap', 0)) || 0,
    maxPriceImpactPct: Number(read('maxPriceImpactPct', 2.5)) || 2.5,
    gmgnMinTotalFeesSol: Number(read('gmgnMinTotalFeesSol', 30)) || 30,
    gmgnTop10HolderMaxPct: Number(read('gmgnTop10HolderMaxPct', 30)) || 30,
    gmgnDevHoldMaxPct: Number(read('gmgnDevHoldMaxPct', 5)) || 5,
    gmgnInsiderMaxPct: Number(read('gmgnInsiderMaxPct', 0)) || 0,
    gmgnBundlerMaxPct: Number(read('gmgnBundlerMaxPct', 60)) || 60,
    gmgnWashTradeMaxPct: Number(read('gmgnWashTradeMaxPct', 35)) || 35,
    gmgnRequireBurnedLp: read('gmgnRequireBurnedLp', true) !== false,
    gmgnRequireZeroTax: read('gmgnRequireZeroTax', true) !== false,
    gmgnBlockCto: read('gmgnBlockCto', false) === true,
    gmgnBlockVamped: read('gmgnBlockVamped', true) !== false,
    gmgnWhitelistEnabled: read('gmgnWhitelistEnabled', true) !== false,
    discoveryTimeframe: String(read('discoveryTimeframe', '5m') || '5m'),
    discoveryCategory: String(read('discoveryCategory', '') || ''),
    discoveryLimit: Math.max(10, Number(read('meteoraDiscoveryLimit', 150)) || 150),
    jupiterSimUsd: Number(read('jupiterSimUsd', 1)) || 1,
  };
}

export function appendDecision(decisions, line, meta = {}) {
  if (!Array.isArray(decisions) || !line) return;
  decisions.push({
    ts: nowIso(),
    line: String(line).trim(),
    ...meta,
  });
}

function formatPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : 'N/A';
}

function toRatio(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? n / 100 : n;
}

function pruneJupiterBlacklist() {
  const now = Date.now();
  for (const [mint, row] of _jupiterFailBlacklist.entries()) {
    if (!row?.until || row.until <= now) _jupiterFailBlacklist.delete(mint);
  }
}

function getJupiterBlacklistEntry(mint) {
  pruneJupiterBlacklist();
  return _jupiterFailBlacklist.get(mint) || null;
}

function addJupiterBlacklist(mint, reason) {
  if (!mint) return;
  _jupiterFailBlacklist.set(mint, {
    until: Date.now() + JUPITER_BLACKLIST_TTL_MS,
    reason: String(reason || 'Jupiter simulation failed'),
    ts: nowIso(),
  });
}

function removeJupiterBlacklist(mint) {
  if (!mint) return;
  _jupiterFailBlacklist.delete(mint);
}

function dexPairScore(pair) {
  const liq = safeNum(pair?.liquidity?.usd || 0);
  const vol = safeNum(pair?.volume?.h24 || 0);
  return liq + vol;
}

async function fetchDexScreenerSnapshot(tokenMint) {
  try {
    const res = await withExponentialBackoff(async () => {
      const r = await fetchWithTimeout(`${DEXSCREENER_BASE}/${tokenMint}`, {}, 8000);
      if (r.status === 429) throw new Error('DEX_429');
      if (!r.ok) throw new Error(`DEX_HTTP_${r.status}`);
      return r;
    }, { maxRetries: 2, baseDelay: 800 });
    const payload = await res.json().catch(() => null);
    const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
    if (!pairs.length) return null;
    const solPairs = pairs.filter((p) => String(p?.chainId || '').toLowerCase() === 'solana');
    const ranked = (solPairs.length ? solPairs : pairs).sort((a, b) => dexPairScore(b) - dexPairScore(a));
    const best = ranked[0];
    return {
      mcap: safeNum(best?.marketCap || best?.fdv || 0),
      volume24h: safeNum(best?.volume?.h24 || 0),
      liquidityUsd: safeNum(best?.liquidity?.usd || 0),
      pairAddress: best?.pairAddress || null,
      dexId: best?.dexId || null,
      pairCreatedAt: safeNum(best?.pairCreatedAt || 0) || null,
      priceUsd: safeNum(best?.priceUsd || 0),
      label: `${best?.baseToken?.symbol || ''}/${best?.quoteToken?.symbol || ''}`.trim(),
    };
  } catch {
    return null;
  }
}

function collectOkxRiskEntries(section) {
  if (!section || typeof section !== 'object') return [];
  return []
    .concat(Array.isArray(section.highRiskList) ? section.highRiskList : [])
    .concat(Array.isArray(section.middleRiskList) ? section.middleRiskList : [])
    .concat(Array.isArray(section.lowRiskList) ? section.lowRiskList : []);
}

function okxRiskHas(entries, key) {
  return entries.some((e) =>
    String(e?.riskKey || '') === key &&
    String(e?.newRiskLabel || '').trim().toLowerCase() === 'yes'
  );
}

async function fetchOkxSignals(tokenMint) {
  const headers = { 'Ok-Access-Client-type': 'agent-cli', Accept: 'application/json' };
  try {
    const riskPath = `/priapi/v1/dx/market/v2/risk/new/check?chainId=501&tokenContractAddress=${tokenMint}&t=${Date.now()}`;
    const advPath = `/api/v6/dex/market/token/advanced-info?chainIndex=501&tokenContractAddress=${tokenMint}`;
    const [riskRes, advRes] = await Promise.allSettled([
      fetchWithTimeout(`${OKX_BASE}${riskPath}`, { headers }, 8000),
      fetchWithTimeout(`${OKX_BASE}${advPath}`, { headers }, 8000),
    ]);

    let highRisk = false;
    let riskLevel = null;
    let wash = null;
    let bundlerPct = null;
    let sourceOk = false;

    if (riskRes.status === 'fulfilled' && riskRes.value.ok) {
      const riskPayload = await riskRes.value.json().catch(() => null);
      const riskData = riskPayload?.data || null;
      if (riskData) {
        sourceOk = true;
        const entries = []
          .concat(collectOkxRiskEntries(riskData?.allAnalysis))
          .concat(collectOkxRiskEntries(riskData?.swapAnalysis))
          .concat(collectOkxRiskEntries(riskData?.contractAnalysis))
          .concat(collectOkxRiskEntries(riskData?.extraAnalysis));
        highRisk = okxRiskHas(entries, 'isLiquidityRemoval') || okxRiskHas(entries, 'isHoneypot');
        wash = okxRiskHas(entries, 'isWash') ? 100 : 0;
        const rawRiskLevel = Number(riskData?.riskLevel ?? riskData?.riskControlLevel);
        riskLevel = Number.isFinite(rawRiskLevel) ? rawRiskLevel : null;
      }
    }

    if (advRes.status === 'fulfilled' && advRes.value.ok) {
      const advPayload = await advRes.value.json().catch(() => null);
      const advRaw = Array.isArray(advPayload?.data) ? advPayload.data[0] : advPayload?.data;
      if (advRaw) {
        sourceOk = true;
        const rawBundle = Number(advRaw.bundleHoldingPercent);
        if (Number.isFinite(rawBundle)) bundlerPct = rawBundle;
        const rawRiskLevel = Number(advRaw.riskControlLevel);
        if (Number.isFinite(rawRiskLevel)) riskLevel = rawRiskLevel;
        const tags = Array.isArray(advRaw.tokenTags) ? advRaw.tokenTags.map((t) => String(t).toLowerCase()) : [];
        if (tags.includes('honeypot')) highRisk = true;
      }
    }

    if (!sourceOk) return null;
    return { highRisk, washTradingPct: wash, bundlerPct, riskLevel };
  } catch {
    return null;
  }
}

function pickGmgnNumber(info, sec, paths) {
  const all = [info, sec];
  for (const path of paths) {
    for (const obj of all) {
      if (!obj) continue;
      const parts = path.split('.');
      let cur = obj;
      for (const p of parts) {
        cur = cur?.[p];
        if (cur == null) break;
      }
      const n = Number(cur);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractTotalFeesSol(info, sec) {
  return pickGmgnNumber(info, sec, [
    'stat.total_fees_sol',
    'total_fees_sol',
    'fees.total_sol',
    'fee.total_sol',
    'stat.priority_tip_sol',
  ]);
}

function isVampedCoin(info, sec) {
  const keys = [
    info?.dev?.vamped_flag,
    info?.dev?.is_vamped,
    info?.stat?.is_vamped,
    info?.is_vamped,
    sec?.is_vamped,
  ];
  if (keys.some((v) => v === true || v === 1 || String(v).toLowerCase() === 'true')) return true;
  const labels = []
    .concat(Array.isArray(info?.tags) ? info.tags : [])
    .concat(Array.isArray(sec?.tags) ? sec.tags : [])
    .map((x) => String(x?.label || x?.name || x || '').toLowerCase());
  return labels.some((t) => t.includes('vamped'));
}

async function runJupiterSimulation(tokenMint, usdAmount, maxImpactPct) {
  await ensureIpv4First();
  const solPrice = await getJupiterPrice(WSOL_MINT).catch(() => null);
  const simUsd = Number.isFinite(Number(usdAmount)) && Number(usdAmount) > 0 ? Number(usdAmount) : 1;
  const simSol = Number.isFinite(Number(solPrice)) && Number(solPrice) > 0
    ? Math.max(0.0001, simUsd / Number(solPrice))
    : 0.01;
  const amountLamports = Math.max(1, Math.floor(simSol * 1_000_000_000));

  try {
    const buyRes = await fetchWithTimeout(
      `${JUPITER_QUOTE_API}?inputMint=${WSOL_MINT}&outputMint=${tokenMint}&amount=${amountLamports}&slippageBps=100`,
      {},
      12000,
    );
    if (!buyRes.ok) {
      return { pass: false, reason: `BUY_HTTP_${buyRes.status}`, buyImpact: null, sellImpact: null };
    }
    const buy = await buyRes.json().catch(() => null);
    const buyImpact = safeNum(buy?.priceImpactPct);
    const outAmount = String(buy?.outAmount || '');
    if (!outAmount || outAmount === '0') {
      return { pass: false, reason: 'BUY_NO_ROUTE', buyImpact, sellImpact: null };
    }

    const sellRes = await fetchWithTimeout(
      `${JUPITER_QUOTE_API}?inputMint=${tokenMint}&outputMint=${WSOL_MINT}&amount=${outAmount}&slippageBps=100`,
      {},
      12000,
    );
    if (!sellRes.ok) {
      return { pass: false, reason: `SELL_HTTP_${sellRes.status}`, buyImpact, sellImpact: null };
    }
    const sell = await sellRes.json().catch(() => null);
    const sellImpact = safeNum(sell?.priceImpactPct);
    if (!Number.isFinite(sellImpact)) {
      return { pass: false, reason: 'SELL_NO_ROUTE', buyImpact, sellImpact: null };
    }

    const buyFail = Number.isFinite(buyImpact) && buyImpact > maxImpactPct;
    const sellFail = Number.isFinite(sellImpact) && sellImpact > Math.max(maxImpactPct * 4, 10);
    if (buyFail || sellFail) {
      const reason = buyFail
        ? `HIGH_PRICE_IMPACT_BUY_${buyImpact.toFixed(2)}`
        : `HIGH_PRICE_IMPACT_SELL_${sellImpact.toFixed(2)}`;
      return { pass: false, reason, buyImpact, sellImpact };
    }
    return { pass: true, reason: 'PASS', buyImpact, sellImpact };
  } catch (e) {
    return { pass: false, reason: e?.message || 'JUPITER_SIM_FAILED', buyImpact: null, sellImpact: null };
  }
}

function buildResult({
  tokenMint,
  name,
  symbol,
  mcap,
  volume24h,
  liquidityUsd,
  highFlags,
  mediumFlags,
  decisions,
  gmgnStatus,
  gmgnRejects,
  stageWaterfall,
  priceImpactBuy,
  priceImpactSell,
  sources,
  notes,
}) {
  const rejected = highFlags.length > 0;
  return {
    tokenMint,
    name: name || '',
    symbol: symbol || '',
    verdict: rejected ? 'AVOID' : (mediumFlags.length ? 'CAUTION' : 'PASS'),
    eligible: !rejected,
    mcap: Number.isFinite(mcap) ? mcap : null,
    volume24h: Number.isFinite(volume24h) ? volume24h : null,
    liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
    tokenAgeMinutes: null,
    highFlags,
    mediumFlags,
    decisions,
    gmgnStatus,
    gmgnRejects,
    gmgnFallbackFeesUsed: false,
    totalFeesSol: null,
    totalFeesSource: null,
    priceImpact: Number.isFinite(priceImpactBuy) ? priceImpactBuy : null,
    priceImpactSell: Number.isFinite(priceImpactSell) ? priceImpactSell : null,
    stageWaterfall,
    stageFunnel: {
      stage1_gmgn_gate: stageWaterfall.stage1PublicData,
      stage2_gmgn_availability: gmgnStatus === 'ACTIVE' ? 'PASS' : (gmgnStatus === 'UNVERIFIED' ? 'SOFT' : 'FAIL'),
      stage3_gmgn_security: stageWaterfall.stage2GmgnAudit,
      stage4_fee_integrity: stageWaterfall.stage3Jupiter,
      final: rejected ? 'REJECTED' : 'PASSED',
    },
    sources,
    notes: Array.isArray(notes) ? notes : [],
  };
}

export async function discoverMeteoraDlmmPools(opts = {}) {
  const cfg = getConfig();
  const radar = normalizeConfig(cfg);
  const limit = Math.max(10, Number(opts.limit || radar.discoveryLimit || 150));
  const timeframe = String(opts.timeframe || radar.discoveryTimeframe || '5m');
  const category = String(opts.category || radar.discoveryCategory || '');

  const filters = [
    'pool_type=dlmm',
    `base_token_market_cap>=${Math.max(0, radar.minMcap)}`,
    `volume>=${Math.max(0, radar.minVolume24h)}`,
    `tvl>=${Math.max(0, radar.minTvl)}`,
  ].join('&&');

  const params = new URLSearchParams({
    page_size: String(limit),
    filter_by: filters,
    timeframe,
  });
  if (category) params.set('category', category);

  const url = `${METEORA_DISCOVERY_BASE}/pools?${params.toString()}`;
  const pools = [];
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 12000);
    if (!res.ok) throw new Error(`DISCOVERY_HTTP_${res.status}`);
    const json = await res.json().catch(() => null);
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const p of rows) {
      const address = p?.pool_address || p?.address || null;
      const tokenX = p?.token_x?.address || p?.tokenX || null;
      const tokenY = p?.token_y?.address || p?.tokenY || null;
      if (!address || !tokenX || !tokenY) continue;
      pools.push({
        address,
        name: p?.name || `${p?.token_x?.symbol || 'TOKEN'}-${p?.token_y?.symbol || 'SOL'}`,
        tokenX,
        tokenY,
        tokenXSymbol: p?.token_x?.symbol || '',
        tokenYSymbol: p?.token_y?.symbol || '',
        mcap: safeNum(p?.token_x?.market_cap || p?.base_token_market_cap || 0),
        volume24hRaw: safeNum(p?.volume || p?.volume_24h || 0),
        liquidityRaw: safeNum(p?.active_tvl || p?.tvl || 0),
        txns24hRaw: safeNum(p?.swap_count || 0),
        binStep: safeNum(p?.dlmm_params?.bin_step || p?.bin_step || 0),
        tokenCreatedAt: safeNum(p?.token_x?.created_at || 0) || null,
        hasMeteoraPair: true,
      });
    }
  } catch (e) {
    return {
      pools: [],
      error: e?.message || 'DISCOVERY_FAILED',
      request: { url, filters, timeframe, category },
    };
  }

  return {
    pools,
    total: pools.length,
    request: { url, filters, timeframe, category },
  };
}

export async function screenToken(tokenMint, tokenName = '', tokenSymbol = '', opts = {}) {
  const cfg = getConfig();
  const radar = normalizeConfig(cfg);
  const highFlags = [];
  const mediumFlags = [];
  const gmgnRejects = [];
  const decisions = [];
  const notes = [];
  const sources = {
    meteoraDiscovery: !!opts?.seedData,
    dexScreener: false,
    okx: false,
    gmgn: false,
    jupiter: false,
  };

  appendDecision(decisions, `[STAGE-0] Discovery seed received for ${tokenMint.slice(0, 8)}`);

  const blacklistHit = getJupiterBlacklistEntry(tokenMint);
  if (blacklistHit) {
    const msg = `[VETO] Jupiter blacklist aktif sampai ${new Date(blacklistHit.until).toISOString()} (${blacklistHit.reason})`;
    highFlags.push({ rule: 'JUPITER_LOCAL_BLACKLIST', msg });
    appendDecision(decisions, msg, { stage: 3 });
    return buildResult({
      tokenMint,
      name: tokenName,
      symbol: tokenSymbol,
      mcap: null,
      volume24h: null,
      liquidityUsd: null,
      highFlags,
      mediumFlags,
      decisions,
      gmgnStatus: 'UNVERIFIED',
      gmgnRejects,
      stageWaterfall: {
        stage0Discovery: 'PASS',
        stage1PublicData: 'SKIPPED',
        stage2GmgnAudit: 'SKIPPED',
        stage3Jupiter: 'FAIL',
      },
      priceImpactBuy: null,
      priceImpactSell: null,
      sources,
      notes,
    });
  }

  // Stage 1: Public Data Waterfall (DexScreener + OKX)
  const dex = await fetchDexScreenerSnapshot(tokenMint);
  const mcap = safeNum(dex?.mcap || opts?.seedData?.seedMcap || 0);
  const volume24h = safeNum(dex?.volume24h || opts?.seedData?.seedVolume24h || 0);
  const liquidityUsd = safeNum(dex?.liquidityUsd || opts?.seedData?.seedLiquidity || 0);
  sources.dexScreener = !!dex;
  if (dex) {
    appendDecision(decisions, `[STAGE-1] DexScreener ${dex.label || '-'} mcap=$${Math.round(mcap).toLocaleString()} vol24h=$${Math.round(volume24h).toLocaleString()}`);
  } else {
    appendDecision(decisions, '[STAGE-1] DexScreener unavailable, fallback to discovery seed');
  }

  if (radar.minMcap > 0 && mcap > 0 && mcap < radar.minMcap) {
    const msg = `[VETO] Mcap $${Math.round(mcap).toLocaleString()} < min $${Math.round(radar.minMcap).toLocaleString()}`;
    highFlags.push({ rule: 'BELOW_MIN_MCAP', msg });
    appendDecision(decisions, msg, { stage: 1 });
  }
  if (radar.maxMcap > 0 && mcap > radar.maxMcap) {
    const msg = `[VETO] Mcap $${Math.round(mcap).toLocaleString()} > max $${Math.round(radar.maxMcap).toLocaleString()}`;
    highFlags.push({ rule: 'ABOVE_MAX_MCAP', msg });
    appendDecision(decisions, msg, { stage: 1 });
  }
  if (radar.minVolume24h > 0 && volume24h > 0 && volume24h < radar.minVolume24h) {
    const msg = `[VETO] Volume 24h $${Math.round(volume24h).toLocaleString()} < min $${Math.round(radar.minVolume24h).toLocaleString()}`;
    highFlags.push({ rule: 'BELOW_MIN_VOLUME_24H', msg });
    appendDecision(decisions, msg, { stage: 1 });
  }

  const okx = await fetchOkxSignals(tokenMint);
  sources.okx = !!okx;
  if (okx) {
    if (okx.highRisk || (Number.isFinite(okx.riskLevel) && okx.riskLevel >= 3)) {
      const msg = `[VETO] OKX menandai High Risk (riskLevel=${okx.riskLevel ?? 'N/A'})`;
      highFlags.push({ rule: 'OKX_HIGH_RISK', msg });
      appendDecision(decisions, msg, { stage: 1 });
    }
    if (Number.isFinite(okx.washTradingPct) && okx.washTradingPct > radar.gmgnWashTradeMaxPct) {
      const msg = `[VETO] Wash Trading ${okx.washTradingPct.toFixed(1)}% > ${radar.gmgnWashTradeMaxPct}%`;
      highFlags.push({ rule: 'OKX_WASH_TRADING', msg });
      appendDecision(decisions, msg, { stage: 1 });
    }
    if (Number.isFinite(okx.bundlerPct)) {
      notes.push(`OKX bundler ${formatPct(okx.bundlerPct)}`);
    }
  } else {
    appendDecision(decisions, '[STAGE-1] OKX unavailable (non-blocking)');
  }

  // Stage 2: GMGN Deep Audit
  const [gmgnInfo, gmgnSec] = await Promise.all([
    getGmgnTokenInfo(tokenMint).catch(() => null),
    getGmgnSecurity(tokenMint).catch(() => null),
  ]);
  const gmgnAvailable = !!(gmgnInfo || gmgnSec);
  sources.gmgn = gmgnAvailable;
  const gmgnStatus = gmgnAvailable ? 'ACTIVE' : 'UNVERIFIED';

  if (gmgnAvailable && radar.gmgnWhitelistEnabled) {
    const top10 = toRatio(pickGmgnNumber(gmgnInfo, gmgnSec, ['stat.top_10_holder_rate', 'top_10_holder_rate']));
    const devHold = toRatio(pickGmgnNumber(gmgnInfo, gmgnSec, ['creator_balance_rate', 'stat.dev_team_hold_rate', 'stat.creator_hold_rate']));
    const insider = toRatio(pickGmgnNumber(gmgnInfo, gmgnSec, ['rat_trader_amount_rate', 'stat.top_rat_trader_percentage']));
    const bundler = toRatio(pickGmgnNumber(gmgnInfo, gmgnSec, ['bundler_trader_amount_rate', 'stat.top_bundler_trader_percentage']));
    const totalFeesSol = extractTotalFeesSol(gmgnInfo, gmgnSec);
    const burnStatus = String(gmgnSec?.burn_status || '').toLowerCase();
    const buyTax = safeNum(gmgnSec?.buy_tax || 0);
    const sellTax = safeNum(gmgnSec?.sell_tax || 0);
    const ctoFlag = Number(gmgnInfo?.dev?.cto_flag || 0);
    const vamped = isVampedCoin(gmgnInfo, gmgnSec);

    const gmgnChecks = [
      { ok: top10 == null || top10 <= radar.gmgnTop10HolderMaxPct / 100, msg: `[VETO] Top 10 Holders ${(top10 * 100).toFixed(2)}% > ${radar.gmgnTop10HolderMaxPct}%`, rule: 'GMGN_TOP10' },
      { ok: devHold == null || devHold <= radar.gmgnDevHoldMaxPct / 100, msg: `[VETO] Dev Hold ${(devHold * 100).toFixed(2)}% > ${radar.gmgnDevHoldMaxPct}%`, rule: 'GMGN_DEV_HOLD' },
      { ok: insider == null || insider <= radar.gmgnInsiderMaxPct / 100, msg: `[VETO] Insider ${(insider * 100).toFixed(2)}% > ${radar.gmgnInsiderMaxPct}%`, rule: 'GMGN_INSIDER' },
      { ok: bundler == null || bundler <= radar.gmgnBundlerMaxPct / 100, msg: `[VETO] Bundler ${(bundler * 100).toFixed(2)}% > ${radar.gmgnBundlerMaxPct}%`, rule: 'GMGN_BUNDLER' },
      { ok: totalFeesSol == null || totalFeesSol >= radar.gmgnMinTotalFeesSol, msg: `[VETO] Total Fees ${safeNum(totalFeesSol).toFixed(2)} SOL < ${radar.gmgnMinTotalFeesSol} SOL`, rule: 'GMGN_TOTAL_FEES' },
      { ok: !radar.gmgnRequireBurnedLp || burnStatus === 'burn', msg: `[VETO] LP burn wajib, status="${burnStatus || 'unknown'}"`, rule: 'GMGN_LP_BURN' },
      { ok: !radar.gmgnRequireZeroTax || (buyTax <= 0 && sellTax <= 0), msg: `[VETO] Wajib Zero Tax, buy=${buyTax}% sell=${sellTax}%`, rule: 'GMGN_TAX' },
      { ok: !radar.gmgnBlockCto || ctoFlag !== 1, msg: '[VETO] CTO flag aktif (gmgnBlockCto=true)', rule: 'GMGN_CTO' },
      { ok: !radar.gmgnBlockVamped || vamped !== true, msg: '[VETO] Vamped flag aktif (gmgnBlockVamped=true)', rule: 'GMGN_VAMPED' },
    ];

    for (const chk of gmgnChecks) {
      if (!chk.ok) {
        gmgnRejects.push({ rule: chk.rule, msg: chk.msg });
        highFlags.push({ rule: chk.rule, msg: chk.msg });
        appendDecision(decisions, chk.msg, { stage: 2 });
      }
    }
    if (gmgnRejects.length === 0) {
      appendDecision(decisions, '[STAGE-2] GMGN strict profile PASS');
    }
  } else if (!gmgnAvailable) {
    appendDecision(decisions, '[STAGE-2] Unverified GMGN (data null), lanjut ke Jupiter simulation');
    notes.push('Unverified GMGN');
  } else {
    appendDecision(decisions, '[STAGE-2] GMGN whitelist nonaktif, strict profile dilewati');
  }

  // Stage 3: Jupiter Safety & Memory
  let buyImpact = null;
  let sellImpact = null;
  const jup = await runJupiterSimulation(tokenMint, radar.jupiterSimUsd, radar.maxPriceImpactPct);
  sources.jupiter = true;
  buyImpact = jup.buyImpact;
  sellImpact = jup.sellImpact;

  if (!jup.pass) {
    const msg = `[VETO] Jupiter simulation gagal: ${jup.reason}`;
    highFlags.push({ rule: 'JUPITER_SIM_FAIL', msg });
    addJupiterBlacklist(tokenMint, jup.reason);
    appendDecision(decisions, `${msg} (blacklist 24h)`, { stage: 3 });
  } else {
    removeJupiterBlacklist(tokenMint);
    appendDecision(decisions, `[STAGE-3] Jupiter PASS buyImpact=${Number(buyImpact).toFixed(2)} sellImpact=${Number(sellImpact).toFixed(2)}`, { stage: 3 });
  }

  const stageWaterfall = {
    stage0Discovery: 'PASS',
    stage1PublicData: highFlags.some((f) => String(f.rule).startsWith('OKX_') || String(f.rule).includes('MCAP') || String(f.rule).includes('VOLUME')) ? 'FAIL' : 'PASS',
    stage2GmgnAudit: gmgnRejects.length > 0 ? 'FAIL' : (gmgnStatus === 'UNVERIFIED' ? 'SOFT' : 'PASS'),
    stage3Jupiter: jup.pass ? 'PASS' : 'FAIL',
  };

  const name = tokenName || gmgnInfo?.name || tokenSymbol || tokenMint.slice(0, 8);
  const symbol = tokenSymbol || gmgnInfo?.symbol || '';
  return buildResult({
    tokenMint,
    name,
    symbol,
    mcap,
    volume24h,
    liquidityUsd,
    highFlags,
    mediumFlags,
    decisions,
    gmgnStatus,
    gmgnRejects,
    stageWaterfall,
    priceImpactBuy: buyImpact,
    priceImpactSell: sellImpact,
    sources,
    notes,
  });
}

export function formatScreenResult(result) {
  const verdictEmoji = result?.eligible ? '✅' : '🚫';
  let out = `${verdictEmoji} *${result?.name || '-'}* (${result?.symbol || '-'}) — ${result?.eligible ? 'ELIGIBLE' : 'VETO'}\n`;
  if (Number.isFinite(result?.mcap)) out += `💰 Mcap: $${Math.round(result.mcap).toLocaleString()}\n`;
  if (Number.isFinite(result?.volume24h)) out += `📊 Vol 24h: $${Math.round(result.volume24h).toLocaleString()}\n`;
  if (Number.isFinite(result?.priceImpact)) out += `🧪 Jupiter Buy Impact: ${result.priceImpact.toFixed(2)}%\n`;
  if (Number.isFinite(result?.priceImpactSell)) out += `🧪 Jupiter Sell Impact: ${result.priceImpactSell.toFixed(2)}%\n`;

  if (result?.stageWaterfall) {
    out += `\n🧭 *Waterfall:* S0=${result.stageWaterfall.stage0Discovery} → S1=${result.stageWaterfall.stage1PublicData} → S2=${result.stageWaterfall.stage2GmgnAudit} → S3=${result.stageWaterfall.stage3Jupiter}\n`;
  }

  if (Array.isArray(result?.highFlags) && result.highFlags.length) {
    out += `\n🔴 *VETO Reasons:*\n`;
    result.highFlags.forEach((f) => { out += `• ${f.msg}\n`; });
  }
  if (Array.isArray(result?.mediumFlags) && result.mediumFlags.length) {
    out += `\n🟡 *Warnings:*\n`;
    result.mediumFlags.forEach((f) => { out += `• ${f.msg}\n`; });
  }
  if (Array.isArray(result?.notes) && result.notes.length) {
    out += `\n📝 *Notes:*\n`;
    result.notes.forEach((n) => { out += `• ${n}\n`; });
  }
  if (Array.isArray(result?.decisions) && result.decisions.length) {
    out += `\n📚 *Decision Trail:*\n`;
    result.decisions.slice(-8).forEach((d) => { out += `• ${d.line}\n`; });
  }
  return out.trim();
}
