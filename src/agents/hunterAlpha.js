'use strict';

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition, getSolPriceUsd } from '../solana/meteora.js';
import { getWalletBalance, getConnection } from '../solana/wallet.js';
import { PublicKey } from '@solana/web3.js';
import { getOpenPositions, getPoolStats, closePositionWithPnl, getStat, recordScreeningEvent } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getStrategy, parseStrategyParameters, getAllStrategies } from '../strategies/strategyManager.js';
import {
  matchStrategyToMarket,
  getLibraryStats,
  evaluateStrategyReadiness as libEvaluateReadiness,
  classifyMarketRegime,
} from '../market/strategyLibrary.js';
import { fetchCandles, getMarketSnapshot, getOHLCV, getMultiTFScore, getSentiment } from '../market/oracle.js';
import { getSocialSignals, getTokenSocialScore } from '../market/socialScanner.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { screenToken, formatScreenResult } from '../market/coinfilter.js';
import { parseTvl, safeNum, stringify, escapeHTML, getConservativeSlippage } from '../utils/safeJson.js';
import { kv, hr, codeBlock, shortAddr } from '../utils/table.js';
import { getDarwinWeights, captureSignals } from '../market/signalWeights.js';
import { isOnCooldown, getPoolMemoryContext, recordDeployment } from '../market/poolMemory.js';
import { checkSmartWalletsOnPool, formatSmartWalletSignal } from '../market/smartWallets.js';
import { executeControlledOperation } from '../app/executionService.js';
import { discoverPools as lpAgentDiscoverPools, enrichPools as lpAgentEnrichPools, isLPAgentEnabled } from '../market/lpAgent.js';
import { runEvolutionCycle } from '../learn/evolve.js';
import { checkMaxDrawdown, requestConfirmation, validateStrategyForMarket } from '../safety/safetyManager.js';
import { getRuntimeState, setRuntimeState, flushRuntimeState } from '../runtime/state.js';

// ─── State ───────────────────────────────────────────────────────

let lastCandidates = [];
let lastReport = null;
let hunterNotifyFn = null;
let hunterBotRef = null;
let hunterAllowedId = null;
let _hunterTargetCount = null; // Local caches for tool output (shared across rounds)
let _hunterMaxPositionsCap = null; // Global stage-aware cap injected by orchestrator (index)

export function getCandidates() { return lastCandidates; }
export function getLastHunterReport() { return lastReport; }

function extractPrimaryFlag(result) {
  const first = Array.isArray(result?.highFlags) && result.highFlags.length > 0
    ? result.highFlags[0]
    : null;
  return {
    rule: first?.rule || null,
    msg: first?.msg || null,
  };
}

function auditScreeningResult(result, context = {}) {
  try {
    const primary = extractPrimaryFlag(result);
    recordScreeningEvent({
      tokenMint: result?.tokenMint || context.tokenMint || null,
      tokenSymbol: result?.symbol || context.tokenSymbol || null,
      tokenName: result?.name || context.tokenName || null,
      poolAddress: context.poolAddress || null,
      verdict: result?.verdict || 'UNKNOWN',
      eligible: result?.eligible === true,
      primaryRule: primary.rule,
      primaryMessage: primary.msg,
      gmgnStatus: result?.gmgnStatus || null,
      vampedSourceStatus: result?.vampedSourceStatus || null,
      totalFeesSol: result?.totalFeesSol,
      totalFeesSource: result?.totalFeesSource || null,
      sourceContext: context.sourceContext || 'hunter',
      highFlags: result?.highFlags || [],
      mediumFlags: result?.mediumFlags || [],
    }).catch(() => {});
  } catch {
    // Audit failure must never break decision path.
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeAdaptiveDeployAmount({ cfg, poolInfo, snapshot }) {
  const baseAmount = safeNum(cfg.deployAmountSol || 0.05);
  const range24hPct = safeNum(snapshot?.ohlcv?.range24hPct);
  const volatility = String(snapshot?.ohlcv?.volatilityCategory || '').toUpperCase();
  const feeApr = safeNum(poolInfo?.feeApr);
  const tvl = safeNum(poolInfo?.tvl);
  const volume24h = safeNum(poolInfo?.volume24h);
  const volumeTvlRatio = tvl > 0 ? volume24h / tvl : 0;

  let multiplier = 1.0;

  if (volatility === 'HIGH' || range24hPct >= 20) multiplier *= 0.55;
  else if (volatility === 'MEDIUM' || range24hPct >= 10) multiplier *= 0.75;

  if (feeApr >= 250) multiplier *= 1.10;
  else if (feeApr > 0 && feeApr < 60) multiplier *= 0.85;

  if (volumeTvlRatio > 0 && volumeTvlRatio < 0.75) multiplier *= 0.80;
  else if (volumeTvlRatio > 3.0 && volatility !== 'HIGH' && range24hPct < 15) multiplier *= 1.05;

  const adjusted = clamp(baseAmount * multiplier, 0.01, baseAmount);
  return Number(adjusted.toFixed(4));
}

// --- Kode Zombie Diamputasi (Baris 43-149) ---
// Logika evaluasi strategi kini terpusat di src/market/strategyLibrary.js 
// untuk mencegah dualisme kodingan dan shadowing bug.

// ─── Darwinian Scoring ───────────────────────────────────────────
// Weights di-load dari signalWeights.js (auto-recalibrated dari data nyata).
// Fallback ke defaults jika belum ada data.

function calculateDarwinScore(pool, weightsOverride, sentiment = 'NEUTRAL') {
  const cfg = getConfig();
  const w = weightsOverride || getDarwinWeights();
  let score = 0;

  // fee/TVL ratio — strong predictor
  const tvl = pool.liquidityRaw || pool.tvl || 0;
  const fees = pool.fees24hRaw || 0;
  if (tvl > 0 && fees > 0) {
    const ratio = fees / tvl;
    const ratioScore = Math.min(ratio / 0.05, 2.0) / 2.0; // 5% ratio = max 1.0
    score += ratioScore * (w.feeActiveTvlRatio || 3.5);
  }

  // Maturity Bonus: Beri poin ekstra untuk koin yang sudah terbukti bertahan lama
  if (pool.createdAt) {
    const ageHours = (Date.now() - new Date(pool.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours > 24) {
      score += 1.0; // Bonus +1.0 untuk koin berumur > 24 jam
      if (process.env.HUNTER_DEBUG) console.log(`[hunter] Maturity Bonus for ${pool.name}: +1.0`);
    }
  }

  // volume — near floor, de-emphasize
  const vol = pool.volume24hRaw || 0;
  if (vol > 0) {
    score += Math.min(vol / 500000, 1.0) * (w.volume || 0.36);
  }

  // mcap proxy via TVL
  if (tvl > 0) {
    const mcapScore = tvl < 10000 ? 0.2 : tvl < 50000 ? 0.5 : tvl < 100000 ? 0.8 : 1.0;
    score += mcapScore * (w.mcap || 2.5);
  }

  // holderCount
  score += 0.3 * (w.holderCount || 0.3);

  // multiTFScore — bonus jika tersedia (di-set saat enrichment)
  if (pool.multiTFScore > 0) {
    score += pool.multiTFScore * (w.multiTFScore || 1.5);
  }

  // Technical Confluence Filter: Slash score if trend is bearish
  const isGlobalBullish = sentiment === 'BULLISH';
  if (pool.multiTFScore > 0 && pool.multiTFScore < 0.4) {
    if (!isGlobalBullish) {
      score *= 0.5;
    } else {
      score *= 0.95;
    }
  }

  return parseFloat(score.toFixed(4));
}

const HUNTER_TOOLS = [
  {
    name: 'screen_pools',
    description: 'Screen pool Meteora DLMM terbaik berdasarkan threshold yang dikonfigurasi',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Jumlah kandidat (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_pool_detail',
    description: 'Ambil detail pool + rekomendasi strategi berdasarkan kondisi market saat ini',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'screen_token',
    description: 'WAJIB sebelum deploy. Filter token via 7-step Coin Filter: narrative, price health, holder check, token safety (DexScreener, BirdEye, OKX).',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string' },
        token_name: { type: 'string' },
        token_symbol: { type: 'string' },
      },
      required: ['token_mint'],
    },
  },
  {
    name: 'get_wallet_status',
    description: 'Cek balance wallet dan jumlah posisi terbuka saat ini',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pool_memory',
    description: 'Cek histori deploy sebelumnya di pool ini — win rate, avg PnL, range efficiency, close reason dominan. Gunakan sebelum deploy untuk hindari pool dengan histori buruk.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'deploy_position',
    description: 'Deploy likuiditas ke pool. Jumlah token dihitung otomatis dari strategi dan config. Hanya boleh dipanggil setelah screen_token verdict PASS atau CAUTION.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari Strategy Library' },
        dev_address: { type: 'string', description: 'Alamat deployer koin (diambil dari screen_token)' },
        reasoning: { type: 'string', description: 'Alasan memilih pool dan strategi ini (DLMM-specific: fee APR, range fit, volatilitas)' },
      },
      required: ['pool_address', 'reasoning'],
    },
  },
  {
    name: 'get_social_signals',
    description: 'Ambil daftar token trending dari Discord/KOL/Social channels (Meridian-style). Gunakan untuk menemukan early gems sebelum masuk volume screener.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_evolution',
    description: 'Trigger autonomous evolution cycle untuk kalibrasi ulang threshold config berdasarkan performa trade terakhir.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── Tool execution ──────────────────────────────────────────────

async function executeTool(name, input) {
  // Global Marker
  console.log(`[hunter] Rebirth Engine v3.0 Unified — Tool: ${name}`);

  switch (name) {

    case 'screen_pools': {
      const limit = input.limit || 10;
      const thresholds = getThresholds();
      const weights = getDarwinWeights();

      const cfg = getConfig();
      // ── LP Agent: discover top pools (1 API call, cached 10 menit) ──
      // Berjalan paralel dengan getTopPools untuk hemat waktu
      const [dexPools, lpAgentPools] = await Promise.allSettled([
        getTopPools(limit * 3),
        isLPAgentEnabled()
          ? lpAgentDiscoverPools({
            pageSize: 50,
            vol24hMin: cfg.minVolume24h,
            organicScoreMin: cfg.minOrganic,
            binStepMin: cfg.minBinStep,
            binStepMax: 125,
            feeTVLInterval: '1h',
          })
          : Promise.resolve([]),
      ]);

      const rawDex = dexPools.status === 'fulfilled' ? (dexPools.value || []) : [];
      const rawLP = lpAgentPools.status === 'fulfilled' ? (lpAgentPools.value || []) : [];

      // Merge: LP Agent pools tidak ada di DexScreener → tambahkan sebagai kandidat baru
      // Pool yang sudah ada di DexScreener → tidak di-double
      const dexAddresses = new Set(rawDex.map(p => p.address));
      const lpAgentOnly = rawLP.filter(p => p.address && !dexAddresses.has(p.address)).map(p => ({
        address: p.address,
        name: p.name || p.tokenXSymbol ? `${p.tokenXSymbol}-SOL` : '',
        tokenX: p.tokenX,
        tokenY: p.tokenY,
        tvl: p.tvl,
        fees24hRaw: p.vol24h * (p.feeTVLRatio || 0),
        binStep: p.binStep,
        _fromLPAgent: true,
      }));
      const combined = [...rawDex, ...lpAgentOnly];

      // ── Satu call enrichment LP Agent untuk semua kandidat ──
      // enrich pools SETELAH merge, zero extra API calls (pakai cache)
      const allAddresses = combined.map(p => p.address).filter(Boolean);
      const lpEnrichMap = isLPAgentEnabled()
        ? await lpAgentEnrichPools(allAddresses).catch(() => ({}))
        : {};

      // Filter dasar — binStep difilter via allowlist dari active strategy (dynamic)
      const activeStrat = getStrategy(cfg.activeStrategy || 'Evil Panda');
      const allowedBinSteps = activeStrat?.allowedBinSteps || cfg.allowedBinSteps || [100, 125];
      const minTokenFeesSol = cfg.minTokenFeesSol;
      const preFiltered = combined.filter(p => {
        const fees = p.fees24hRaw || 0;
        const volume24h = p.volume24hRaw || 0;
        const binStep = p.binStep || 0;

        // Fokus filter dipindah ke kualitas token (Dex + GMGN), bukan TVL/Liquidity gate.
        const minVolume24h = thresholds.minVolume24h || cfg.minVolume24h || 0;
        const volumePasses = minVolume24h <= 0 || volume24h >= minVolume24h;

        // 🏰 HERITAGE FILTER v76.0 (Kecerdasan Sultan)
        const minTotalFeesSol = cfg.minTotalFeesSol || 30.0;
        const heritageMode = cfg.heritageModeEnabled !== false;

        const isMomentumPass = (minTokenFeesSol <= 0 || fees >= minTokenFeesSol);
        const isHeritagePass = heritageMode && (p.totalFeesEstimated >= minTotalFeesSol);

        // 🐼 EVIL PANDA GATE 1: Pool age <72h (freshness edge)
        const maxPoolAgeDays = cfg.maxPoolAgeDays ?? 3;
        const poolAgeHours = p.createdAt
          ? (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60)
          : null;
        const agePasses = poolAgeHours === null || poolAgeHours <= maxPoolAgeDays * 24;

        return (
          allowedBinSteps.includes(binStep) &&
          volumePasses &&
          agePasses &&
          (isMomentumPass || isHeritagePass) &&
          !isOnCooldown(p.address)
        );
      }).map(p => {
        const fees = p.fees24hRaw || 0;
        const isMomentumPass = (minTokenFeesSol <= 0 || fees >= minTokenFeesSol);
        const isHeritagePass = (cfg.heritageModeEnabled !== false) && (p.totalFeesEstimated >= (cfg.minTotalFeesSol || 30.0));

        return {
          ...p,
          isHeritageMatch: isHeritagePass && !isMomentumPass,
          heritageStatus: isHeritagePass ? 'HERITAGE_SULTAN' : 'MOMENTUM_ONLY'
        };
      });

      // Enrich: multi-TF + smart wallet + LP Agent data (parallel, best-effort)
      const enriched = await Promise.all(preFiltered.map(async p => {
        let multiTFScore = 0;
        let smartWalletSignal = null;
        let poolMemCtx = '';
        let marketSent = 'NEUTRAL';
        try {
          const [mtf, sw, ss, sent] = await Promise.allSettled([
            getMultiTFScore(p.tokenX, p.address),
            checkSmartWalletsOnPool(p.address),
            getTokenSocialScore(p.tokenX || p.tokenY),
            getSentiment(p.tokenX || p.tokenY)
          ]);
          if (mtf.status === 'fulfilled') multiTFScore = mtf.value.score || 0;
          if (sw.status === 'fulfilled' && sw.value.found) smartWalletSignal = sw.value;
          if (ss.status === 'fulfilled' && ss.value) p.socialSignal = ss.value;
          if (sent.status === 'fulfilled' && sent.value) marketSent = sent.value.sentiment || 'NEUTRAL';
          poolMemCtx = getPoolMemoryContext(p.address);
        } catch { /* best-effort */ }

        const lpData = lpEnrichMap[p.address] || { inLPAgentList: false };

        return {
          ...p,
          multiTFScore,
          marketSentiment: marketSent,
          smartWallet: smartWalletSignal
            ? { found: true, wallets: smartWalletSignal.matches.map(m => m.label), confidence: smartWalletSignal.confidence }
            : null,
          poolMemory: poolMemCtx || undefined,
          lpAgent: lpData,   // { inLPAgentList, organicScore, feeTVLRatioLP, vol24hLP }
          darwinScore: calculateDarwinScore({ ...p, multiTFScore }, weights, marketSent),
          feeToTvlRatio: (() => {
            const tvl = parseTvl(p.tvlStr || p.tvl || 0);
            return tvl > 0 ? ((p.fees24hRaw || 0) / tvl).toFixed(4) : '0';
          })(),
        };
      }));

      // ─── Efficiency Scorer & Deduplication (Layer 7) ──────────
      // Jika koin yang sama punya > 1 pool (misal 100 vs 125), 
      // ambil yang rasionya paling "Gacor" (Volume/TVL tertinggi).
      const tokenMap = new Map(); // tokenMint -> bestPool
      for (const p of enriched) {
        const mint = p.tokenX || p.tokenY;
        const currentRatio = parseFloat(p.feeToTvlRatio);
        const existing = tokenMap.get(mint);

        if (!existing || currentRatio > parseFloat(existing.feeToTvlRatio)) {
          tokenMap.set(mint, p);
        }
      }

      // Re-sort berdasarkan Darwin Score (yang sudah include TVL/Fee logic)
      const filtered = Array.from(tokenMap.values())
        .sort((a, b) => b.darwinScore - a.darwinScore)
        .slice(0, limit);

      lastCandidates = filtered;

      const lpNote = isLPAgentEnabled()
        ? `LP Agent: ${rawLP.length} pools discovered, ${lpAgentOnly.length} tambahan baru, enrich ${allAddresses.length} pool.`
        : 'LP Agent: disabled (LP_AGENT_API_KEY tidak diset).';

      // Trim kandidat — hapus field verbose yang tidak dibutuhkan LLM untuk keputusan
      const trimmedCandidates = filtered.map(p => ({
        address: p.address,
        name: p.name || '',
        binStep: p.binStep,
        tvl: typeof p.tvl === 'number' ? Math.round(p.tvl) : p.tvlStr,
        fees24h: p.fees24hRaw ? parseFloat(p.fees24hRaw.toFixed(2)) : undefined,
        feeToTvlRatio: p.feeToTvlRatio,
        darwinScore: p.darwinScore ? parseFloat(p.darwinScore.toFixed(3)) : undefined,
        multiTFScore: p.multiTFScore || undefined,
        smartWallet: p.smartWallet || undefined,
        poolMemory: p.poolMemory || undefined,
        lpAgent: p.lpAgent?.inLPAgentList
          ? { organicScore: p.lpAgent.organicScore, feeTVLRatioLP: p.lpAgent.feeTVLRatioLP }
          : undefined,
      }));

      return JSON.stringify({
        note: `Sorted by darwinScore. Pool cooldown difilter. ${lpNote}`,
        candidates: trimmedCandidates,
      }, null, 2);
    }

    case 'get_pool_detail': {
      const info = await getPoolInfo(input.pool_address);
      if (!info) {
        return JSON.stringify({ error: 'Pool tidak ditemukan atau RPC gagal. Coba pool lain.' }, null, 2);
      }
      let strategyMatch = null;
      let dlmmSnapshot = null;

      // Retry logic for market snapshot
      for (let i = 0; i < 3; i++) {
        try {
          dlmmSnapshot = await getMarketSnapshot(info.tokenX, input.pool_address);
          strategyMatch = matchStrategyToMarket(dlmmSnapshot);
          break;
        } catch (e) {
          if (i === 2) console.warn(`[hunter] Failed to get snapshot after 3 retries: ${e.message}`);
          await new Promise(r => setTimeout(r, 500));
        }
      }

      const pool = dlmmSnapshot?.pool;
      const price = dlmmSnapshot?.price;

      return JSON.stringify({
        poolInfo: info,
        dlmmEconomics: pool ? {
          feeApr: `${pool.feeApr}% (${pool.feeAprCategory})`,
          feeVelocity: pool.feeVelocity,
          feeTvlRatioPct: `${(pool.feeTvlRatio * 100).toFixed(3)}%/hari`,
          tvl: pool.tvl,
          volume24h: pool.volume24h,
          healthScore: dlmmSnapshot?.healthScore,
          eligible: pool.feeAprCategory !== 'LOW' && pool.feeTvlRatio > 0.01,
        } : null,
        priceContext: price ? {
          trend: price.trend,
          momentumM5: price.priceChangeM5,
          volatility: `${price.volatility24h}% (${price.volatilityCategory})`,
          // binStepFit: Defensive implementation v61.2
          binStepFit: info.binStep >= (price.suggestedBinStepMin || 1) ? 'OK' : `⚠️ Butuh bin step ≥${price.suggestedBinStepMin || 1}`,
          buyPressure: `${price.buyPressurePct}% (${price.sentiment})`,
        } : null,
        strategyRecommendation: strategyMatch ? {
          recommended: strategyMatch.recommended?.name || 'Evil Panda',
          confidence: strategyMatch.recommended?.matchScore,
          entryConditions: 'm5 Momentum + h1 Trend Alignment',
          exitConditions: 'Evil Panda Confluence',
        } : null,
        validStrategyNames: ['Evil Panda'],
      }, null, 2);
    }

    case 'screen_token': {
      if (hunterNotifyFn) {
        const label = input.token_symbol || input.token_name || input.token_mint.slice(0, 8);
        await hunterNotifyFn(`🔬 <b>Coin Filter</b>: Screening <code>${escapeHTML(label)}</code>...`);
      }
      const result = await screenToken(
        input.token_mint,
        input.token_name || '',
        input.token_symbol || ''
      );
      auditScreeningResult(result, {
        tokenMint: input.token_mint || null,
        tokenName: input.token_name || null,
        tokenSymbol: input.token_symbol || null,
        sourceContext: 'hunter_tool_screen_token',
      });

      // Kirim hasil ke user untuk semua verdict:
      // - AVOID  → user perlu tahu kenapa ditolak
      // - CAUTION → user perlu tahu warning sebelum deploy
      // - PASS   → user perlu konfirmasi GMGN clean sebelum deploy
      if (hunterNotifyFn) {
        const prefix = result.verdict === 'AVOID'
          ? '🚫 <b>Token Ditolak</b>'
          : result.verdict === 'CAUTION'
            ? '⚠️ <b>Token CAUTION</b>'
            : '✅ <b>Token Lolos Screening</b>';
        await hunterNotifyFn(`${prefix}\n\n${formatScreenResult(result)}`);
      }

      return JSON.stringify({
        verdict: result.verdict,
        eligible: result.eligible,
        highFlags: (result.highFlags || []).map(f => f.msg),
        mediumFlags: (result.mediumFlags || []).map(f => f.msg),
        gmgnStatus: result.gmgnStatus || 'UNKNOWN',
        gmgnFallbackFeesUsed: result.gmgnFallbackFeesUsed === true,
        gmgnIssues: (result.gmgnRejects || []).map(f => f.msg),
        tokenAgeMinutes: result.tokenAgeMinutes,
        priceImpact: result.priceImpact,
        sources: result.sources,
        action: result.verdict === 'AVOID'
          ? 'SKIP — cari kandidat lain'
          : 'LANJUT DEPLOY — jumlah token dihitung otomatis',
      }, null, 2);
    }

    case 'get_wallet_status': {
      const cfg = getConfig();
      const balance = await getWalletBalance();
      const openPos = getOpenPositions();
      const maxCap = Number.isFinite(_hunterMaxPositionsCap) ? _hunterMaxPositionsCap : cfg.maxPositions;
      // Jika run dari /entry dengan targetCount, hitung batas berdasarkan posisi yang akan dibuka
      const effectiveMax = _hunterTargetCount != null
        ? Math.min(openPos.length + _hunterTargetCount, maxCap)
        : maxCap;
      const minReserve = cfg.gasReserve || 0.05;
      const totalRequired = cfg.deployAmountSol + minReserve;

      return stringify({
        solBalance: balance,
        openPositions: openPos.length,
        maxPositions: effectiveMax,
        targetCount: _hunterTargetCount,
        canOpen: safeNum(balance) >= totalRequired && openPos.length < effectiveMax,
        requiredSol: safeNum(totalRequired.toFixed(4)),
        gasReserve: minReserve,
        notes: safeNum(balance) < totalRequired ? `⚠️ Saldo SOL kurang untuk Gas Reserve (${minReserve} SOL)` : 'OK',
      }, 2);
    }

    case 'get_pool_memory': {
      const stats = getPoolStats(input.pool_address);
      if (!stats) {
        return stringify({ firstTime: true, message: 'Belum pernah deploy ke pool ini.' }, 2);
      }
      const verdict = stats.winRate < 40
        ? 'HINDARI — win rate rendah, histori buruk di pool ini'
        : stats.winRate < 60
          ? 'HATI-HATI — win rate di bawah rata-rata'
          : 'OK — histori positif di pool ini';
      return stringify({ ...stats, verdict }, 2);
    }

    case 'deploy_position': {
      // ── Initialization (Top-level scope to prevent ReferenceError) ──
      const cfg = getConfig();
      let deployOptions = {};
      let strategyEval = null;
      let targetPriceRangePct = 10;
      let result = null;

      // ── Guard: cegah deploy duplikat ke pool yang sama ──────────
      let existingPositions = getOpenPositions();
      const existingForPool = existingPositions.find(p => p.pool_address === input.pool_address);
      if (existingForPool) {
        // Ada di DB — verifikasi on-chain dulu. DB bisa stale jika position ditutup
        // di luar bot (manual close, expired, dll) tanpa DB di-update.
        let accountExists = true;
        try {
          const conn = getConnection();
          const pubkey = new PublicKey(existingForPool.position_address);
          const info = await conn.getAccountInfo(pubkey);
          accountExists = info !== null;
        } catch { /* best-effort — kalau gagal, anggap masih ada (safe default) */ }

        if (!accountExists) {
          // Account sudah tidak ada on-chain → DB stale → bersihkan dan izinkan deploy baru
          console.log(`[hunter] DB stale: posisi ${existingForPool.position_address} tidak ada on-chain, bersihkan dan izinkan re-deploy`);
          try {
            await closePositionWithPnl(existingForPool.position_address, {
              pnlUsd: 0, pnlPct: 0, feesUsd: 0, pnlSol: 0, feesSol: 0, closeReason: 'MANUAL_CLOSE', lifecycleState: 'closed_reconciled',
            });
          } catch { /* best-effort */ }
          // Re-fetch setelah cleanup agar slot count akurat
          existingPositions = getOpenPositions();
          // Tidak return di sini — lanjut ke deploy baru di bawah
        } else {
          // Posisi benar-benar masih ada on-chain → tolak duplikat
          return JSON.stringify({
            success: true,
            alreadyDeployed: true,
            positionAddress: existingForPool.position_address,
            pool_address: input.pool_address,
            strategyUsed: existingForPool.strategy_used,
            note: 'SUDAH_ADA — skip diam-diam, lanjut kandidat berikutnya.',
          }, null, 2);
        }
      }

      // NOTE: Database-level lock in executeControlledOperation handles duplicate guard per pool.

      // ── Guard: slot posisi penuh ─────────────────────────────────
      const maxCap = Number.isFinite(_hunterMaxPositionsCap) ? _hunterMaxPositionsCap : cfg.maxPositions;
      const effectiveMaxPos = _hunterTargetCount != null
        ? Math.min(existingPositions.length + _hunterTargetCount, maxCap)
        : maxCap;
      if (existingPositions.length >= effectiveMaxPos) {
        return JSON.stringify({
          blocked: true,
          reason: `Slot penuh (${existingPositions.length}/${effectiveMaxPos}) — tidak bisa deploy lagi.`,
        }, null, 2);
      }

      // ── Semua validasi di sini — SEBELUM lock + "Deploying..." ──────
      // "Deploying..." hanya dikirim kalau semua cek lulus dan TX benar-benar
      // akan dieksekusi. Kalau ada yang block, user tidak dapat notif palsu.

      // Safety: max drawdown (sinkron — cek dulu sebelum fetch API)
      const drawdown = checkMaxDrawdown();
      if (drawdown.triggered) {
        return stringify({ blocked: true, reason: drawdown.reason }, 2);
      }

      // ── Auto-calculate position sizing ──────────────────────────
      let deployAmountSol = cfg.deployAmountSol || 0.1;
      const tokenXAmount = 0;
      let tokenYAmount = deployAmountSol;

      // Ambil pool info + validasi sebelum lock
      const poolInfo = await getPoolInfo(input.pool_address);
      if (!poolInfo) {
        return JSON.stringify({
          blocked: true,
          reason: 'Gagal fetch pool info — RPC tidak merespons atau pool tidak valid. Coba lagi.',
        }, null, 2);
      }

      // Guard: hanya deploy ke pool TOKEN/SOL
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      if (poolInfo.tokenY !== WSOL_MINT) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool tokenY bukan WSOL (${poolInfo.tokenYSymbol || poolInfo.tokenY?.slice(0, 8)}) — bot hanya deploy ke pool TOKEN/SOL. Skip pool ini.`,
        }, null, 2);
      }

      // Guard: Liquidity Dominance — prevent bot from becoming the dominant LP
      // Dominant LP = price can be manipulated against the position, amplifying IL
      const poolTvlUsd = safeNum(poolInfo?.tvl);
      if (poolTvlUsd > 0) {
        const solPriceUsd   = await getSolPriceUsd().catch(() => 150);
        const deployUsd     = deployAmountSol * solPriceUsd;
        const dominancePct  = (deployUsd / poolTvlUsd) * 100;
        const maxDominance  = cfg.maxLpDominancePct ?? 20;
        if (dominancePct > maxDominance) {
          return JSON.stringify({
            blocked: true,
            reason: `Liquidity dominance terlalu tinggi: ${dominancePct.toFixed(1)}% (max ${maxDominance}%). Deploy ~$${deployUsd.toFixed(0)} ke pool TVL $${poolTvlUsd.toFixed(0)} akan membuat bot jadi LP dominan — risiko manipulasi harga tinggi.`,
          }, null, 2);
        }
      }

      // Strategy validation sebelum lock — hardlocked ke Evil Panda, tidak ada strategi lain.
      const strategy = getStrategy('Evil Panda');

      if (!strategy) {
        return JSON.stringify({
          blocked: true,
          reason: `Strategi "${input.strategy_name}" tidak ditemukan di database atau baseline.`,
        }, null, 2);
      }

      // ── Guard: binStep Enforcement (Sentinel v61) ──────────────
      if (strategy.allowedBinSteps && !strategy.allowedBinSteps.includes(poolInfo.binStep)) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool binStep (${poolInfo.binStep}) tidak dijinkan untuk strategi ${strategy.name}. Diperlukan: [${strategy.allowedBinSteps.join(', ')}].`,
        }, null, 2);
      }

      // ── Guard: Dev Correlation Filter (Intelligence v1.0) ──────
      const devAddr = input.dev_address || null;
      if (devAddr) {
        const activeDevs = getOpenPositions().map(p => p.dev_address).filter(Boolean);
        if (activeDevs.includes(devAddr)) {
          return JSON.stringify({
            blocked: true,
            reason: `CORRELATION RISK: Deployer \`${devAddr.slice(0, 8)}...\` sudah memiliki posisi aktif di bot ini. Melewati pool ini untuk menghindari risiko sistemik satu dev.`,
          }, null, 2);
        }
      }

      // ── Guard: Gas Vault & Balance Check (atomic) ──────────────
      const walletBalance = await getWalletBalance();
      const gasReserve = cfg.gasReserve || 0.025; // Aegis-level reserve
      // Each open position needs ~0.004 SOL gas buffer to close (tx fees + account rent).
      const existingCount = getOpenPositions().length;
      const closeGasBuffer = existingCount * 0.004;
      const minRequired = (deployAmountSol || 0.1) + gasReserve + closeGasBuffer;
      if (safeNum(walletBalance) < minRequired) {
        return JSON.stringify({
          blocked: true,
          reason: `Saldo SOL tidak cukup (${walletBalance.toFixed(4)} SOL). Butuh ${minRequired.toFixed(4)} SOL (Deploy: ${(deployAmountSol || 0.1).toFixed(4)} + Reserve: ${gasReserve} + CloseBuffer: ${closeGasBuffer.toFixed(4)} untuk ${existingCount} posisi).`,
        }, null, 2);
      }

      const stratParams = parseStrategyParameters(strategy);
      const strategyType = strategy?.type || 'spot';
      const strategyProfile = getStrategy(strategy.name);
      deployOptions = { ...(strategyProfile?.parameters || {}), ...(strategyProfile?.deploy || {}) };
      strategyEval = null;

      try {
        const snapshot = await getMarketSnapshot(poolInfo.tokenX, input.pool_address);
        const regimeInfo = classifyMarketRegime(snapshot);
        if (regimeInfo?.regime === 'BEAR_DEFENSE') {
          return JSON.stringify({
            blocked: true,
            reason: `Regime ${regimeInfo.regime}: ${regimeInfo.notes || 'market bearish-defense mode'}. Entry di-skip.`,
            policy: 'REGIME_BEAR_DEFENSE',
            regime: regimeInfo,
          }, null, 2);
        }
        const failSafeEnabled = cfg.failSafeModeOnDataUnreliable !== false;
        const dataReliable = snapshot?.quality?.dataReliable !== false;
        const taReliable = snapshot?.quality?.taReliable === true;
        const taSource = snapshot?.quality?.taSource || snapshot?.ta?.supertrend?.source || 'unknown';
        if (failSafeEnabled && (!dataReliable || !taReliable)) {
          const issueText = (snapshot?.quality?.issues || []).join(' | ') || 'oracle snapshot unreliable';
          const taIssue = !taReliable
            ? `TA reliability belum memenuhi syarat (source=${taSource}, minConf=${snapshot?.quality?.minTaConfidence ?? 'n/a'}).`
            : '';
          return JSON.stringify({
            blocked: true,
            reason: `Fail-safe aktif: data market/TA belum reliable untuk entry. ${issueText} ${taIssue}`.trim(),
            policy: 'FAIL_SAFE_UNRELIABLE_DATA',
          }, null, 2);
        }
        deployAmountSol = computeAdaptiveDeployAmount({ cfg, poolInfo, snapshot });
        tokenYAmount = deployAmountSol;
        strategyEval = await libEvaluateReadiness({
          strategyName: strategy.name,
          poolAddress: input.pool_address,
          snapshot,
          binStep: poolInfo.binStep,
          activeBinId: poolInfo.activeBinId,
        });
        // Merge dynamic market-based options (e.g., adaptive fixedBinsBelow)
        if (strategyEval?.deployOptions) {
          deployOptions = { ...deployOptions, ...strategyEval.deployOptions };
        }
        // T1.4: Per-pool slippage at deploy time, not hardcoded strategy default.
        // Stored in deployOptions.slippageBps so closePositionDLMM can use it as a floor.
        const vol24h = snapshot?.price?.volatility24h || 0;
        deployOptions.slippageBps = getConservativeSlippage(vol24h);
      } catch (e) {
        console.warn(`[hunter] Market evaluation failed for ${input.pool_address}:`, e.message);
      }

      if (strategyEval && !strategyEval.ok) {
        return JSON.stringify({
          blocked: true,
          reason: `Strategy ${strategy.name} tidak valid untuk kondisi saat ini: ${strategyEval.blockers.join(' | ')}`,
          strategyNotes: strategyEval.notes,
        }, null, 2);
      }

      // Dynamic range — strategyEval.deployOptions sudah di-merge ke deployOptions di atas.
      // Fallback: deployOptions.priceRangePct → strategy params → generic 10%.
      targetPriceRangePct = deployOptions?.priceRangePct ?? stratParams.priceRangePercent ?? 10;

      // Strategy vs pool warning (non-blocking)
      try {
        const validation = validateStrategyForMarket(strategyType, poolInfo);
        if (!validation.valid && strategy.name === 'Evil Panda') {
          return JSON.stringify({
            blocked: true,
            reason: `Strategy ${strategy.name} diblokir oleh LP market validation: ${validation.warning}`,
            recommendation: validation.recommendation,
          }, null, 2);
        }
        if (!validation.valid && hunterNotifyFn) {
          await hunterNotifyFn(`⚠️ <b>Strategy Warning</b>\n\n${escapeHTML(validation.warning)}`);
        }
      } catch { /* skip */ }

      // ── Semua validasi lulus — sekarang kirim "Deploying..." ──

      if (hunterNotifyFn) {
        await hunterNotifyFn(
          `⚡ <b>Deploying...</b>\n` +
          `Pool: <code>${escapeHTML(input.pool_address.slice(0, 8))}...</code>\n` +
          `Strategi: <b>${escapeHTML(strategy.name)}</b>\n` +
          `Range: ${targetPriceRangePct.toFixed(1)}%\n` +
          `<i>${escapeHTML((deployOptions.technicalReasoning || input.reasoning || '').slice(0, 150))}</i>`
        );
      }


      // Konfirmasi Telegram (cegah race)
      if (cfg.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
        const confirmed = await requestConfirmation(
          hunterNotifyFn,
          hunterBotRef,
          hunterAllowedId,
          `🚀 <b>Hunter Alpha ingin deploy:</b>\n\n` +
          `📍 Pool: <code>${escapeHTML(input.pool_address.slice(0, 8))}...</code>\n` +
          `📊 Strategi: <b>${escapeHTML(strategy.name)}</b> (${targetPriceRangePct.toFixed(1)}%)\n` +
          `💰 Deploy: ${deployAmountSol} SOL (Single-Side SOL, adaptive)\n` +
          `  tokenX: 0 | tokenY: ${tokenYAmount.toFixed(4)} SOL\n\n` +
          `💭 ${escapeHTML(deployOptions.technicalReasoning || input.reasoning)}`
        );
        if (!confirmed) {
          // Kirim notif batal agar user tidak bingung kenapa "Deploying..." tanpa follow-up
          if (hunterNotifyFn) {
            await hunterNotifyFn(`❌ <b>Deploy Dibatalkan</b>\n\nUser tidak menyetujui deploy ke pool <code>${escapeHTML(input.pool_address.slice(0, 8))}...</code>`).catch(() => { });
          }
          return stringify({ blocked: true, reason: 'Ditolak oleh user.' }, 2);
        }
      }

      // Execute TX — jika gagal, notifikasi user sebelum re-throw
      try {
        ({ result } = await executeControlledOperation({
          operationType: 'OPEN_POSITION',
          entityId: input.pool_address,
          payload: {
            poolAddress: input.pool_address,
            tokenXAmount,
            tokenYAmount,
            priceRangePct: targetPriceRangePct,
            strategy: strategy.name,
            deployOptions,
          },
          metadata: { source: 'hunter_alpha', strategy: strategy.name },
          policy: { isEntryOperation: true, entryMaxPositions: effectiveMaxPos },
          execute: () => openPosition(
            input.pool_address,
            tokenXAmount,
            tokenYAmount,
            targetPriceRangePct,
            strategy.name,
            deployOptions,
          ),
        }));
      } catch (deployErr) {
        // Kirim notif gagal supaya user tidak stuck di "Deploying..." tanpa follow-up
        if (hunterNotifyFn) {
          hunterNotifyFn(
            `❌ <b>Deploy Gagal</b>\n\n` +
            `Pool: <code>${escapeHTML(input.pool_address.slice(0, 8))}...</code>\n` +
            `Error: <code>${escapeHTML(deployErr.message)}</code>\n\n` +
            `<i>Cek wallet balance dan Meteora UI untuk memastikan posisi tidak terbuat.</i>`
          ).catch(() => { });
        }
        throw deployErr; // re-throw agar AI tahu dan bisa report
      }

      // Notifikasi & recording — dikurung try/catch agar error Telegram
      // tidak membuat tool return Error dan memicu AI retry ke pool yang sama
      try {
        if (hunterNotifyFn && result.success) {
          const tpTarget = strategyProfile?.exit?.takeProfitPct ?? cfg.takeProfitFeePct ?? 5;
          const slTarget = strategyProfile?.exit?.emergencyStopLossPct ?? cfg.stopLossPct ?? 5;
          const trailAct = strategyProfile?.exit?.trailingTriggerPct ?? cfg.trailingTriggerPct ?? 3.0;
          const nPos = result.positionCount ?? 1;

          const details = [
            kv('Posisi', nPos > 1 && result.positionAddresses?.length > 0
              ? `${nPos}x chunks (${result.positionAddresses.map(a => shortAddr(a, 4, 4)).join(', ')})`
              : shortAddr(result.positionAddress, 4, 4), 9),
            kv('Pool', shortAddr(input.pool_address, 4, 4), 9),
            kv('Strategi', strategy?.name || 'default', 9),
            kv('Deploy', `${deployAmountSol} SOL (${nPos > 1 ? `${nPos} positions` : 'Single-Side'})`, 9),
            ...(nPos > 1 && result.positions?.length > 0 ? result.positions.map((p, i) =>
              kv(`Chunk${i + 1}`, `${p.yAmountSol.toFixed(4)}◎ @ ${p.binCount} bins`, 9)
            ) : []),
            hr(40),
            kv('Entry', result.entryPrice?.toFixed(8) ?? '-', 9),
            kv('Bawah', `${result.lowerPrice?.toFixed(8) ?? '-'}  (-${targetPriceRangePct}%)`, 9),
            kv('Atas', `${result.upperPrice?.toFixed(8) ?? '-'}  (entry)`, 9),
            kv('Fee/bin', `${result.feeRatePct}%`, 9),
            kv('Range', `${deployOptions.fixedBinsBelow && result.binsBelow !== undefined ? `${result.binsBelow + 1} bins` : `${targetPriceRangePct}%`} | ${result.positions?.reduce((s, p) => s + p.binCount, 0) ?? (result.binRange ? (result.binRange.max - result.binRange.min + 1) : '?')} bins total`, 9),
            hr(40),
            kv('TP', `+${tpTarget}%  Trail: +${trailAct}%  SL: -${slTarget}%`, 9),
            ...(strategyEval?.notes?.length ? [kv('Setup', strategyEval.notes.join(' | ').slice(0, 40), 9)] : []),
          ];

          const txLinks = result.txHashes.slice(0, 3)
            .map((h, i) => `[Tx${result.txHashes.length > 1 ? i + 1 : ''}](https://solscan.io/tx/${h})`)
            .join(' · ');

          const openMsg =
            `🚀 <b>Posisi Dibuka${nPos > 1 ? ` (${nPos} Chunks)` : ''}</b>\n\n` +
            codeBlock(details) + '\n' +
            `💭 <i>${escapeHTML(input.reasoning)}</i>\n\n` +
            `🔗 ${txLinks}`;

          await hunterNotifyFn(openMsg);
        }

        // Record deploy ke pool memory + capture signals untuk Darwinian learning
        if (result.success && result.positionAddress) {
          await recordDeployment(input.pool_address);
          const poolData = lastCandidates.find(c => c.address === input.pool_address);
          if (poolData) captureSignals(result.positionAddress, poolData);
        }
      } catch (notifErr) {
        // Notifikasi/recording gagal — JANGAN propagate error ini.
        // Posisi sudah berhasil di-deploy & tersimpan di DB.
        console.warn('[hunter] Post-deploy notification failed:', notifErr.message);
      }

      return stringify({ ...result, strategyUsed: strategy?.name, reasoning: input.reasoning }, 2);
    }

    case 'get_social_signals': {
      const signals = await getSocialSignals();
      return stringify({
        source: 'Meridian Social Hivemind',
        signals: signals.slice(0, 15),
        note: 'Gunakan mint address ini untuk memanggil screen_token jika belum ada di screen_pools.'
      }, 2);
    }

    case 'run_evolution': {
      const updates = await runEvolutionCycle();
      return stringify({
        success: !!updates,
        appliedUpdates: updates || 'No updates needed at this cycle (performance stable).',
        summary: updates ? 'Thresholds adjusted based on recent trade performance.' : 'Current thresholds are optimal.'
      }, 2);
    }

    default:
      return `Tool tidak dikenali: ${name}`;
  }
}

// ─── Screen-only: get top candidates without running LLM ─────────
// Used by auto-screening flow for batch Telegram approval


// ─── Main agent loop ─────────────────────────────────────────────

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null, options = {}) {
  // Bungkus notifyFn agar error Telegram (EFATAL/terminated) tidak crash loop screening.
  // Error "terminated" terjadi saat polling Telegram putus ditengah eksekusi.
  hunterNotifyFn = notifyFn
    ? (msg) => notifyFn(msg).catch(err => {
      if (process.env.HUNTER_DEBUG) console.warn('[hunter] notify swallowed:', err?.message);
    })
    : null;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;
  _hunterTargetCount = options.targetCount ?? null;
  _hunterMaxPositionsCap = Number.isFinite(options.maxPositionsCap)
    ? Math.max(1, Math.floor(options.maxPositionsCap))
    : null;

  const cfg = getConfig();

  // ─── Circuit Breaker Check ────────────────────────────────────
  // Healer can trip this state after rapid stop-loss clusters.
  // Persisted in runtime-state.json so restart does not bypass cooldown.
  {
    const cb = getRuntimeState('hunter-circuit-breaker', null);
    if (cb?.pausedUntil && Date.now() < cb.pausedUntil) {
      const remainMin = Math.ceil((cb.pausedUntil - Date.now()) / 60000);
      hunterNotifyFn?.(
        `⚡ *Hunter Paused — Circuit Breaker Active*\n` +
        `Sisa waktu pembekuan: *${remainMin} menit*\n` +
        `_${cb.count || 0} SL exits terdeteksi. Menunggu kondisi market stabil._`
      );
      return;
    }
    if (cb?.pausedUntil && Date.now() >= cb.pausedUntil) {
      setRuntimeState('hunter-circuit-breaker', null);
      setRuntimeState('recent-sl-events', []);
      await flushRuntimeState().catch(() => {});
      hunterNotifyFn?.(
        '✅ *Hunter Circuit Breaker Reset*\n_Buffer SL lama dibersihkan, hunter kembali normal._'
      );
    }
  }

  // --- Portfolio Awareness ---
  const balanceRaw = await getWalletBalance().catch(() => 0);
  const balanceSnapshot = safeNum(balanceRaw);
  const minSolNeeded = cfg.minSolToOpen + (cfg.gasReserve ?? 0.02);
  const isBalanceLow = balanceSnapshot < (minSolNeeded * 3);

  if (isBalanceLow) {
    console.log(`📡 Portfolio Awareness: Saldo SOL menipis (${balanceSnapshot.toFixed(4)}). Memperketat filter entry...`);
  }

  // ── Skip silently jika slot posisi penuh ─────────────────────
  const openPos = getOpenPositions();
  const maxCap = Number.isFinite(_hunterMaxPositionsCap) ? _hunterMaxPositionsCap : cfg.maxPositions;
  const effectiveMax = _hunterTargetCount != null
    ? Math.min(openPos.length + _hunterTargetCount, maxCap)
    : maxCap;
  if (openPos.length >= effectiveMax) {
    _hunterTargetCount = null;
    _hunterMaxPositionsCap = null;
    return null;
  }

  // ── Skip silently jika balance tidak cukup ───────────────────
  try {
    const balance = await getWalletBalance();
    if (safeNum(balance) < (cfg.deployAmountSol + (cfg.gasReserve ?? 0.02))) {
      _hunterTargetCount = null;
      _hunterMaxPositionsCap = null;
      return null;
    }
  } catch { /* lanjut jika gagal cek balance */ }

  // ── PRE-COMPUTE: parallelkan pool screening sebelum LLM loop ─
  // Mengurangi LLM round trips dari 40+ menjadi ~6-8.
  // getTopPools + pool memory + OKX dijalankan sekaligus, bukan satu per satu oleh LLM.
  let statusMsgId = null;
  const updatePulse = async (text) => {
    if (!notifyFn) return;
    if (!statusMsgId) {
      const msg = await notifyFn(`🔍 <b>Radar Sweep Initializing...</b>`);
      if (msg?.message_id) statusMsgId = msg.message_id;
    } else {
      // Access updateStatus if the transport provides it
      // hunterBotRef and hunterNotifyFn are cached in state
      if (hunterBotRef && statusMsgId) {
        try {
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: statusMsgId,
            parse_mode: 'HTML'
          });
        } catch (e) { /* ignore mod errors */ }
      }
    }
  };

  await updatePulse(`🔍 <b>Radar Sweep: Scanning Meteora DLMM...</b>`);

  let preComputedContext = '';
  try {
    const thresholds = getThresholds();
    const weights = getDarwinWeights(); // adaptive weights dari data nyata
    // --- Hybrid Discovery Layer ---
    const [rawPools, socialSignals] = await Promise.all([
      import('../solana/meteora.js').then(m => m.getDiscoveryPools(40)),
      getSocialSignals().catch(() => [])
    ]);

    let rejFlow = 0, rejBin = 0, rejMcap = 0, rejCooldown = 0;

    // --- SULTAN RADAR MAPPING (v75.3) --- 
    // Kita petakan koin yang Lolos (Matched) dan yang Disingkirkan (Vetoed)
    const radarSnapshot = rawPools.map(p => {
      const cfg = getConfig();
      const thresholds = getThresholds();
      const binStep = p.binStep || 0;
      const activeStrat = getStrategy(cfg.activeStrategy || 'Evil Panda');
      const allowed = activeStrat?.allowedBinSteps || cfg.allowedBinSteps || [100, 125];

      let matched = true;
      let reason = 'Target Locked via Hybrid Scan';

      if (!allowed.includes(binStep)) {
        matched = false;
        reason = `Reject: Bin Step ${binStep} not in allowed list [${allowed.join(', ')}] for strategy`;
        rejBin++;
      } else if (p.volume24hRaw < thresholds.minVolume24h) {
        matched = false;
        reason = `Reject: Volume $${(p.volume24hRaw / 1000).toFixed(1)}k terlalu sepi`;
        rejFlow++;
      } else if (p.createdAt && (() => {
        const ageHours = (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60);
        return ageHours > (cfg.maxPoolAgeDays ?? 3) * 24;
      })()) {
        const ageH = ((Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60)).toFixed(0);
        matched = false;
        reason = `Reject: Pool sudah ${ageH}h (max ${(cfg.maxPoolAgeDays ?? 3) * 24}h freshness rule)`;
        rejFlow++;
      } else if (p.mcap && p.mcap < thresholds.minMcap) {
        matched = false;
        reason = `Reject: Mcap $${(p.mcap / 1000).toFixed(1)}k terlalu kecil`;
        rejMcap++;
      } else if (isOnCooldown(p.address)) {
        matched = false;
        reason = `Reject: Koin sedang dalam masa cooldown`;
        rejCooldown++;
      }

      return {
        ...p,
        isMatched: matched,
        vetoReason: reason,
        darwinScore: calculateDarwinScore(p, weights, 'NEUTRAL')
      };
    });

    // filtered: Hanya yang benar-benar lolos untuk diproses LLM (Hemat Cost)
    const filtered = radarSnapshot
      .filter(p => p.isMatched)
      .sort((a, b) => b.darwinScore - a.darwinScore)
      .slice(0, 6);

    // radarDisplay: Koin terpilih (Matched + Vetoed terbaik) untuk Dashboard Mac
    const radarDisplay = radarSnapshot
      .sort((a, b) => {
        if (a.isMatched !== b.isMatched) return b.isMatched ? 1 : -1;
        return b.volume24hRaw - a.volume24hRaw;
      })
      .slice(0, 15);

    lastCandidates = filtered;

    // --- DASHBOARD EXPORT (Tactical Panda Radar) ---
    try {
      const __dirname = fileURLToPath(new URL('.', import.meta.url));
      const dashboardFile = join(__dirname, '../web/dashboard_data.json');
      const walBalRaw = await getWalletBalance().catch(() => '0');
      const openPositions = await getOpenPositions();
      const thresholds = getThresholds();
      const rentSaved = getStat('total_rent_reclaimed_sol') || 0;

      const dashboardSnapshot = {
        timestamp: new Date().toISOString(),
        walletBalance: safeNum(walBalRaw).toFixed(4),
        activeCount: openPositions.length,
        totalNetProfitSol: (openPositions.reduce((acc, p) => acc + (parseFloat(p.pnl_sol) || 0), 0)).toFixed(4),
        totalRentSaved: safeNum(rentSaved).toFixed(4),
        candidates: radarDisplay.map(p => ({
          address: p.address,
          name: p.name,
          tvl: p.liquidityRaw,
          vol24h: p.volume24hRaw,
          fees: p.fees24hRaw,
          totalFees: p.totalFeesEstimated, // New: Heritage Awareness v76.0
          binStep: p.binStep,
          mcap: p.mcap,
          score: p.darwinScore,
          volTvlRatio: (p.volume24hRaw / (p.liquidityRaw || 1)).toFixed(2),
          isMatched: p.isMatched,
          isHeritage: p.isHeritageMatch,   // New: Tag Sultan Multiday
          vetoReason: p.vetoReason
        })),
        sentiment: 'BULLISH'
      };

      // --- SULTAN PORTABLE RADAR (v75.6) ---
      // Injeksi data (all-in-one) agar bisa dibuka di Mac tanpa CORS issues
      const rootDir = process.cwd();
      const templatePath = join(rootDir, 'src/web/dashboard.html');
      const sultanRadarPath = join(rootDir, 'src/web/radar_sultan.html');

      if (existsSync(templatePath)) {
        let htmlStr = readFileSync(templatePath, 'utf8');
        // Gunakan REGEX agar anti-gagal terhadap spasi/indentasi
        const injectionRegex = /window\.SULTAN_RADAR_DATA\s*=\s*null;/;
        const injectionValue = `window.SULTAN_RADAR_DATA = ${JSON.stringify(dashboardSnapshot, null, 2)};`;

        if (injectionRegex.test(htmlStr)) {
          htmlStr = htmlStr.replace(injectionRegex, injectionValue);
          writeFileSync(sultanRadarPath, htmlStr);
        } else {
          console.warn('[hunter] Injection point not found in template!');
        }
      }

      // Keep JSON for legacy/API support
      writeFileSync(dashboardFile, JSON.stringify(dashboardSnapshot, null, 2));
    } catch (dErr) {
      console.warn('[hunter] Dashboard export failed:', dErr.message);
    }

    // Fetch pool memory + multi-TF + smart wallets + sentiment in parallel
    const totalToEnrich = filtered.length;
    let processed = 0;

    const enriched = await Promise.all(filtered.map(async (p) => {
      const [memResult, ohlcvResult, swResult, sentResult] = await Promise.allSettled([
        Promise.resolve(getPoolStats(p.address)),
        getOHLCV(p.tokenX || p.tokenY, p.address),
        checkSmartWalletsOnPool(p.address),
        getSentiment(p.tokenX || p.tokenY)
      ]);

      processed++;
      if (processed % 2 === 0 || processed === totalToEnrich) {
        await updatePulse(`🔍 <b>Radar Sweep: Analyzing Candidates [${processed}/${totalToEnrich}]...</b>`);
      }

      const mem = memResult.status === 'fulfilled' ? memResult.value : null;
      const ohlcv = ohlcvResult.status === 'fulfilled' ? ohlcvResult.value : null;
      const sw = swResult.status === 'fulfilled' ? swResult.value : null;
      const sent = sentResult.status === 'fulfilled' ? sentResult.value : null;

      const marketSent = sent?.sentiment || 'NEUTRAL';
      const trend = ohlcv?.ta?.supertrend?.trend || 'NEUTRAL';

      // ─── Phase 2.0: Technical Hard-Gate ─────────────────────────
      // Sesuai filosofi Evil Panda: Jangan pernah entry kalau 15m Bearish.
      if (trend !== 'BULLISH') {
        if (process.env.HUNTER_DEBUG) console.log(`[hunter] Skipping ${p.name} - Supertrend 15m is ${trend}`);
        return null;
      }

      // ─── Phase 2.1: LLM Cost Guard (Static Security Filter) ─────
      // Run full audit for top candidates BEFORE sending to LLM.
      // This saves 10k-50k tokens by rejecting rugs during pre-screening.
      let security = null;
      try {
        security = await screenToken(p.tokenX || p.tokenY, p.name);
        auditScreeningResult(security, {
          tokenMint: p.tokenX || p.tokenY || null,
          tokenName: p.name || null,
          poolAddress: p.address || null,
          sourceContext: 'hunter_precompute',
        });
      } catch (e) {
        console.warn(`[cost-guard] Security check failed for ${p.name}:`, e.message);
      }


      // Update darwinScore dengan Sentiment & TA
      p.darwinScore = calculateDarwinScore(p, weights, marketSent);

      const memVerdict = !mem
        ? 'firstTime'
        : mem.winRate < 40 ? 'HINDARI'
          : mem.winRate < 60 ? 'HATI-HATI'
            : 'OK';

      const tvl = p.liquidityRaw || 0;
      return {
        address: p.address,
        name: p.name,
        darwinScore: p.darwinScore,
        tvl: tvl.toFixed(0),
        fees24h: (p.fees24hRaw || 0).toFixed(2),
        security: security ? {
          verdict: security.verdict,
          eligible: security.eligible,
          gmgnStatus: security.gmgnStatus,
          highFlags: (security.highFlags || []).map(f => f.msg)
        } : { verdict: 'UNKNOWN' },
        socialHype: p.socialSignal ? `🔥 Discord Impact: ${p.socialSignal.intensity}/10` : 'Neutral',
        feeToTvlPct: tvl > 0 ? ((p.fees24hRaw || 0) / tvl * 100).toFixed(2) + '%' : '0%',
        binStep: p.binStep,
        tokenXMint: p.tokenX,
        poolMemory: mem
          ? { winRate: mem.winRate, totalTrades: mem.totalTrades, verdict: memVerdict }
          : { verdict: 'firstTime' },
        multiTF: ohlcv?.ta ? {
          score: (ohlcv.ta.supertrend?.trend === 'BULLISH' ? 0.7 : 0.3),
          bullishTFs: ohlcv.ta.supertrend?.trend === 'BULLISH' ? '1/1' : '0/1',
          breakdown: `15m:${ohlcv.ta.supertrend?.trend === 'BULLISH' ? '✅' : '❌'}`
        } : null,
        smartWallet: sw?.found
          ? { wallets: sw.matches.map(m => m.label), confidence: sw.confidence }
          : null,
      };
    }));

    // --- Filter obvious rejects & Technical Hard-Gate ---
    const rawTotal = rawPools.length;
    const basicFilteredCount = filtered.length;
    const finalEnriched = enriched.filter(p => p !== null);
    const trendFilteredCount = finalEnriched.length;
    const trendRejectedCount = basicFilteredCount - finalEnriched.length;

    if (finalEnriched.length === 0) {
      if (notifyFn) {
        await notifyFn(
          `⚠️ <b>Discovery Result:</b> 0/${rawTotal} candidates matched.\n\n` +
          `• Candidates Scanned: <b>${rawTotal}</b>\n` +
          `• Rejected: <code>BinStep: ${rejBin} | Flow/Freshness: ${rejFlow} | Mcap: ${rejMcap} | Cooldown: ${rejCooldown}</code>\n` +
          `• Technical Hard-Gate (Trend): <b>${basicFilteredCount - trendFilteredCount}</b> non-Bullish\n` +
          `• API/Data Status: ${trendRejectedCount === 0 && basicFilteredCount > 0 ? '❌ All APIs Failed' : '✅ APIs Linked'}\n\n` +
          `<i>Market sepertinya sedang sideways/bearish. Sniper tetap disiplin.</i>`
        );
      }
      return null;
    }

    const viable = finalEnriched.filter(p =>
      p.poolMemory.verdict !== 'HINDARI' &&
      p.security.verdict !== 'AVOID'
    );
    const skipped = finalEnriched.length - viable.length;

    // Send brief rejection report for transparency
    const rejected = finalEnriched.filter(p => p.security.verdict === 'AVOID');
    if (rejected.length > 0 && notifyFn) {
      let rejMsg = `🛡️ <b>Quick Filter: Removed ${rejected.length} risky/low-liq coins (Saved LLM cost):</b>\n`;
      rejected.forEach(p => rejMsg += `• ${p.name}: ${p.security.highFlags[0] || 'Unknown risk'}\n`);
      await notifyFn(rejMsg);
    }

    if (notifyFn) {
      const smartWalletHits = finalEnriched.filter(p => p.smartWallet?.wallets?.length > 0).length;
      const highTFAlign = finalEnriched.filter(p => (p.multiTF?.score || 0) >= 0.67).length;
      const heritageHits = finalEnriched.filter(p => p.isHeritageMatch).length;

      await notifyFn(
        `📊 <b>Pre-screening selesai</b>\n` +
        `✅ Viable: ${viable.length}  ❌ Filtered: ${skipped}\n` +
        (heritageHits > 0 ? `🏰 Heritage Sultan (Multiday): <b>${heritageHits} pool</b>\n` : '') +
        (highTFAlign > 0 ? `📈 Multi-TF kuat (≥4 TF): ${highTFAlign} pool\n` : '') +
        (smartWalletHits > 0 ? `🎯 Smart wallet detected: ${smartWalletHits} pool\n` : '') +
        (viable.length === 0 ? `🛑 <i>Skipping AI: Tidak ada kandidat sehat untuk dianalisis.</i>` : `<i>Menjalankan analisis mendalam (Top ${Math.min(10, viable.length)})...</i>`)
      );
    }

    // Early Exit: Jika tidak ada pool layak, jangan panggil LLM (hemat API cost)
    if (viable.length === 0) {
      _hunterTargetCount = null;
      _hunterMaxPositionsCap = null;
      return null;
    }

    // Cap kandidat ke 10 pool terbaik saja (hemat API context)
    const display = viable.slice(0, 10);

    preComputedContext =
      `\n\n──────────────────────────────────────\n` +
      `PRE-SCREENING SELESAI — DATA SUDAH TERSEDIA\n` +
      `Pool Memory, OKX, Multi-TF, dan Smart Wallet sudah diambil. JANGAN fetch ulang.\n` +
      `Langsung: (1) get_pool_detail top kandidat → (2) screen_token → (3) deploy_position\n\n` +
      `Kandidat viable (${display.length} pool, urut darwinScore):\n` +
      stringify(display, 2);
  } catch (e) {
    console.error('Hunter pre-compute failed:', e.message);
    preComputedContext = '\n\nCatatan: Pre-screening gagal. Gunakan screen_pools untuk ambil kandidat.';
  }

  // Lessons Toggle: Hanya kirim histori trade setiap 2 hari sekali (hemat API context)
  const shouldSendLessons = Math.floor(Date.now() / (1000 * 3600 * 24)) % 2 === 0;
  const lessonsCtx = shouldSendLessons ? getLessonsContext() : "";
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();
  const libraryStats = getLibraryStats();

  const systemPrompt = `You are the Meteora Strategic Execution Engine — a technical data processor for personal DLMM portfolio management.
This system uses technical confluence (ATR, Supertrend) to optimize liquidity provision.

╔══════════════════════════════════════════════════════════════╗
║  TECHNICAL MODE — PERSONAL INFRASTRUCTURE                   ║
║  Decisions are data-driven and pre-authorized by the owner. ║
║  Execute tool calls directly based on technical indicators. ║
╚══════════════════════════════════════════════════════════════╝

MINDSET: Maximize fee capture by identifying high-volume bins using 5m Momentum Velocity and Technical Anchoring.

WORKFLOW:
1. Analyze candidate pools based on darwinScore and Multi-TF alignment.
2. Check wallet status and available position slots.
3. For top candidates:
   a. get_pool_detail: Verify momentumM5 spike and feeApr.
   b. screen_token: Security audit (Mint/Freeze/PriceImpact). 
   c. MEMORY AUDIT: Cross-reference lessonsCtx and instincts for past failure patterns.
4. deploy_position: Apply the "Evil Panda Master" strategy logic.

ERROR HANDLING:
- If a tool returns "NETWORK_ERROR" or "Fetch failed": This is a technical connectivity issue with the infrastructure (Jupiter/RPC).
- Report it technically: "Connectivity issue with API provider. Skipping candidate."
- DO NOT provide generic support advice, affiliate messages, or hallucinate administrative instructions.

Use Indonesian for reasoning. Stay technical, precise, and fast.`;

  const targetNote = _hunterTargetCount != null
    ? ` Tujuan: buka ${_hunterTargetCount} posisi baru.`
    : '';

  const messages = [
    {
      role: 'user',
      content:
        `Jalankan siklus screening & deployment sekarang.${targetNote} ` +
        `Temukan pool terbaik, filter token, dan deploy LANGSUNG tanpa menunggu input apapun. ` +
        `Mode: LIVE — eksekusi nyata. ` +
        `Deploy ${cfg.deployAmountSol} SOL per posisi, strategi dihitung otomatis.` +
        preComputedContext,
    }
  ];

  let response = await createMessage({
    model: resolveModel(cfg.screeningModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools: HUNTER_TOOLS,
    messages,
  });

  const MAX_ROUNDS = 20;
  let rounds = 0;
  // Track apakah ada deploy nyata (bukan alreadyDeployed) — untuk suppress noise report
  let anyRealDeploy = false;

  while (response.stop_reason === 'tool_use' && rounds < MAX_ROUNDS) {
    rounds++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (e) {
        result = `Error: ${e.message}`;
      }

      // Deteksi apakah ini deploy nyata (bukan alreadyDeployed)
      if (toolUse.name === 'deploy_position') {
        try {
          const parsed = JSON.parse(result);
          if (parsed.success && !parsed.alreadyDeployed) anyRealDeploy = true;
        } catch { /* ignore parse error */ }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // Pacing delay to prevent rapid-fire 429 errors during tool use cycles
    await new Promise(r => setTimeout(r, 1000));

    response = await createMessage({
      model: resolveModel(cfg.screeningModel),
      maxTokens: 4096,
      system: systemPrompt,
      tools: HUNTER_TOOLS,
      messages,
    });
  }

  if (rounds >= MAX_ROUNDS && notifyFn) {
    await notifyFn(`⚠️ <b>Hunter Alpha</b> — batas ${MAX_ROUNDS} putaran tercapai, loop dihentikan paksa.`);
  }

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };
  _hunterTargetCount = null; // reset setelah selesai
  _hunterMaxPositionsCap = null;

  // Detect Model Refusal / Hallucinated Support Template
  const reportIsRefusal = (
    report.toLowerCase().includes('afiliasi') ||
    report.toLowerCase().includes('admin') ||
    report.toLowerCase().includes('hubungi') ||
    report.toLowerCase().includes('technical problem') ||
    report.length < 50 // Too short to be a real report
  );

  // Noise = report is "Nothing found" and NO real deploys were made this round
  const reportIsNoise = !anyRealDeploy && (
    report.toLowerCase().includes('no pools found') ||
    report.toLowerCase().includes('nothing found') ||
    report.toLowerCase().includes('no promising') ||
    report.toLowerCase().includes('no pools that match') ||
    report.toLowerCase().includes('tidak ada pool')
  );

  if (notifyFn && !reportIsNoise && !reportIsRefusal) {
    await notifyFn(`🦅 <b>Hunter Alpha Report</b>\n\n${escapeHTML(report)}`);
  } else if (reportIsRefusal) {
    console.warn('[hunter] Hallucinated/Refusal report detected and suppressed:', report);
  }
  return report;
}
