import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance, getConnection } from '../solana/wallet.js';
import { PublicKey } from '@solana/web3.js';
import { getOpenPositions, getPoolStats, closePositionWithPnl } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';
import { getStrategyProfile } from '../strategies/profiles.js';
import { checkMaxDrawdown, validateStrategyForMarket, requestConfirmation } from '../safety/safetyManager.js';
import { matchStrategyToMarket, getLibraryStats } from '../market/strategyLibrary.js';
import { fetchCandles, getMarketSnapshot, getOHLCV } from '../market/oracle.js';
import { getMultiTFScore } from '../market/multiTF.js';
import { getSocialSignals, getTokenSocialScore } from '../market/socialScanner.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { screenToken, formatScreenResult } from '../market/coinfilter.js';
import { parseTvl } from '../utils/safeJson.js';
import { kv, hr, codeBlock, shortAddr } from '../utils/table.js';
import { formatStrategyAlert } from '../utils/alerts.js';
import { getDarwinWeights, captureSignals } from '../market/signalWeights.js';
import { isOnCooldown, getPoolMemoryContext, recordDeployment } from '../market/poolMemory.js';
import { checkSmartWalletsOnPool, formatSmartWalletSignal } from '../market/smartWallets.js';
import { executeControlledOperation } from '../app/executionService.js';
import { discoverPools as lpAgentDiscoverPools, enrichPools as lpAgentEnrichPools, isLPAgentEnabled } from '../market/lpAgent.js';
import { runEvolutionCycle } from '../learn/evolve.js';

// ─── State ───────────────────────────────────────────────────────

let lastCandidates = [];
let lastReport = null;
let hunterNotifyFn = null;
let hunterBotRef = null;
let hunterAllowedId = null;
let _hunterTargetCount = null; // jumlah posisi yang ingin dibuka dalam 1 run /entry
const _deployingPools  = new Set(); // lock sementara selama TX in-flight

export function getCandidates() { return lastCandidates; }
export function getLastHunterReport() { return lastReport; }

async function evaluateStrategyReadiness({ strategyName, poolInfo, poolAddress }) {
  const profile = getStrategyProfile(strategyName);
  if (!profile) {
    return { ok: true, profile: null, priceRangePct: null, deployOptions: {} };
  }

  // Snapshot-only market data (consolidated API)
  const ohlcv = await getOHLCV(poolInfo.tokenX, poolAddress).catch(() => null);

  const blockers = [];
  const notes = [];

  if (!ohlcv) {
    blockers.push('Market snapshot tidak tersedia');
  } else {
    if (strategyName === 'Evil Panda') {
      if (!profile.allowedBinSteps?.includes(poolInfo.binStep)) {
        blockers.push(`bin step ${poolInfo.binStep} tidak termasuk EP-eligible (${profile.allowedBinSteps.join('/')})`);
      }
      
      // Multi-TF Momentum Logic (5m vs 1h)
      // UPTREND confirmed if m5 > 1.5% and h1 > 0
      const isBullishM5 = (ohlcv.priceChangeM5 || 0) > (profile.entry?.momentumTriggerM5 || 1.5);
      const isBullishH1 = (ohlcv.priceChangeH1 || 0) > 0;
      
      // ELASTIC MODE: If M5 is cold but H1 is breaking out (>5%) AND Fee APR is high (>1000%)
      const isElasticH1 = (ohlcv.priceChangeH1 || 0) > 5.0 && (poolInfo.feeApr || 0) > 1000;
      
      if (!isBullishM5 && !isElasticH1) {
        blockers.push(`momentum 5m sepi (${(ohlcv.priceChangeM5 || 0).toFixed(2)}%) dan tidak ada H1 breakout untuk Elastic Mode`);
      } else if (!isBullishM5 && isElasticH1) {
        notes.push('⚠️ ELASTIC MODE: M5 sepi, tapi H1 breakout (>5%) + High Fee detected.');
      }
      
      if (ohlcv.trend === 'DOWNTREND' && !isBullishM5 && !isElasticH1) {
        blockers.push('trend global DOWNTREND dan tidak ada momentum/elastic signal');
      }

      notes.push(`m5: ${(ohlcv.priceChangeM5 || 0).toFixed(2)}% | h1: ${(ohlcv.priceChangeH1 || 0).toFixed(2)}% | trend: ${ohlcv.trend}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    notes,
    profile,
    ohlcv15m: ohlcv, // preserved field name for compatibility
    priceRangePct: profile.deploy?.lowerRangeGuidePct || null,
    deployOptions: {
      fixedBinsBelow: profile.deploy?.fixedBinsBelow,
      rangeLabel: profile.deploy?.label,
    },
  };
}

// ─── Darwinian Scoring ───────────────────────────────────────────
// Weights di-load dari signalWeights.js (auto-recalibrated dari data nyata).
// Fallback ke defaults jika belum ada data.

function calculateDarwinScore(pool, weightsOverride) {
  const w = weightsOverride || getDarwinWeights();
  let score = 0;

  // fee/TVL ratio — strong predictor
  const tvl  = pool.liquidityRaw || pool.tvl || 0;
  const fees = pool.fees24hRaw   || 0;
  if (tvl > 0 && fees > 0) {
    const ratio      = fees / tvl;
    const ratioScore = Math.min(ratio / 0.05, 2.0) / 2.0; // 5% ratio = max 1.0
    score += ratioScore * (w.feeActiveTvlRatio || 2.3);
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

  // Social Signal bonus
  if (pool.socialSignal) {
    const socialWeight = cfg.socialSignalWeight || 1.5;
    const intensityBonus = (pool.socialSignal.intensity || 5) / 10;
    score *= (socialWeight + intensityBonus);
  }

  return parseFloat(score.toFixed(4));
}

// ─── Tools ───────────────────────────────────────────────────────

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
        pool_address:  { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari Strategy Library' },
        reasoning:     { type: 'string', description: 'Alasan memilih pool dan strategi ini (DLMM-specific: fee APR, range fit, volatilitas)' },
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
  const cfg = getConfig();

  switch (name) {

    case 'screen_pools': {
      const limit = input.limit || 10;
      const thresholds = getThresholds();
      const weights    = getDarwinWeights();

      // ── LP Agent: discover top pools (1 API call, cached 10 menit) ──
      // Berjalan paralel dengan getTopPools untuk hemat waktu
      const [dexPools, lpAgentPools] = await Promise.allSettled([
        getTopPools(limit * 3),
        isLPAgentEnabled()
          ? lpAgentDiscoverPools({
              pageSize:        50,
              vol24hMin:       cfg.minVolume24h || 100000,
              organicScoreMin: cfg.minOrganic   || 50,
              binStepMin:      cfg.minBinStep   || 1,
              binStepMax:      250,
              feeTVLInterval:  '1h',
            })
          : Promise.resolve([]),
      ]);

      const rawDex = dexPools.status === 'fulfilled' ? (dexPools.value || []) : [];
      const rawLP  = lpAgentPools.status === 'fulfilled' ? (lpAgentPools.value || []) : [];

      // Merge: LP Agent pools tidak ada di DexScreener → tambahkan sebagai kandidat baru
      // Pool yang sudah ada di DexScreener → tidak di-double
      const dexAddresses  = new Set(rawDex.map(p => p.address));
      const lpAgentOnly   = rawLP.filter(p => p.address && !dexAddresses.has(p.address)).map(p => ({
        address:      p.address,
        name:         p.name || p.tokenXSymbol ? `${p.tokenXSymbol}-SOL` : '',
        tokenX:       p.tokenX,
        tokenY:       p.tokenY,
        tvl:          p.tvl,
        fees24hRaw:   p.vol24h * (p.feeTVLRatio || 0),
        binStep:      p.binStep,
        _fromLPAgent: true,
      }));
      const combined = [...rawDex, ...lpAgentOnly];

      // ── Satu call enrichment LP Agent untuk semua kandidat ──
      // enrich pools SETELAH merge, zero extra API calls (pakai cache)
      const allAddresses = combined.map(p => p.address).filter(Boolean);
      const lpEnrichMap  = isLPAgentEnabled()
        ? await lpAgentEnrichPools(allAddresses).catch(() => ({}))
        : {};

      // Filter dasar
      const minBinStep      = cfg.minBinStep      || 1;
      const minTokenFeesSol = cfg.minTokenFeesSol || 0;
      const preFiltered = combined.filter(p => {
        const tvl      = parseTvl(p.tvlStr || p.tvl || 0);
        const fees     = p.fees24hRaw || 0;
        const feeRatio = tvl > 0 ? fees / tvl : 0;
        const binStep  = p.binStep || 0;
        return (
          binStep >= minBinStep &&
          binStep <= 250 &&
          tvl >= thresholds.minTvl &&
          tvl <= thresholds.maxTvl &&
          feeRatio >= thresholds.minFeeActiveTvlRatio &&
          (minTokenFeesSol <= 0 || fees >= minTokenFeesSol) &&
          !isOnCooldown(p.address)
        );
      });

      // Enrich: multi-TF + smart wallet + LP Agent data (parallel, best-effort)
      const enriched = await Promise.all(preFiltered.map(async p => {
        let multiTFScore = 0;
        let smartWalletSignal = null;
        let poolMemCtx = '';
        try {
          const [mtf, sw, ss] = await Promise.allSettled([
            getMultiTFScore(p.tokenX, p.address),
            checkSmartWalletsOnPool(p.address),
            getTokenSocialScore(p.tokenX || p.tokenY)
          ]);
          if (mtf.status === 'fulfilled') multiTFScore = mtf.value.score || 0;
          if (sw.status === 'fulfilled' && sw.value.found) smartWalletSignal = sw.value;
          if (ss.status === 'fulfilled' && ss.value) pool.socialSignal = ss.value;
          poolMemCtx = getPoolMemoryContext(p.address);
        } catch { /* best-effort */ }

        const lpData = lpEnrichMap[p.address] || { inLPAgentList: false };

        return {
          ...p,
          multiTFScore,
          smartWallet: smartWalletSignal
            ? { found: true, wallets: smartWalletSignal.matches.map(m => m.label), confidence: smartWalletSignal.confidence }
            : null,
          poolMemory:   poolMemCtx || undefined,
          lpAgent:      lpData,   // { inLPAgentList, organicScore, feeTVLRatioLP, vol24hLP }
          darwinScore:  calculateDarwinScore({ ...p, multiTFScore }, weights),
          feeToTvlRatio: (() => {
            const tvl = parseTvl(p.tvlStr || p.tvl || 0);
            return tvl > 0 ? ((p.fees24hRaw || 0) / tvl).toFixed(4) : '0';
          })(),
        };
      }));

      const filtered = enriched
        .sort((a, b) => b.darwinScore - a.darwinScore)
        .slice(0, limit);

      lastCandidates = filtered;

      const lpNote = isLPAgentEnabled()
        ? `LP Agent: ${rawLP.length} pools discovered, ${lpAgentOnly.length} tambahan baru, enrich ${allAddresses.length} pool.`
        : 'LP Agent: disabled (LP_AGENT_API_KEY tidak diset).';

      // Trim kandidat — hapus field verbose yang tidak dibutuhkan LLM untuk keputusan
      const trimmedCandidates = filtered.map(p => ({
        address:        p.address,
        name:           p.name || '',
        binStep:        p.binStep,
        tvl:            typeof p.tvl === 'number' ? Math.round(p.tvl) : p.tvlStr,
        fees24h:        p.fees24hRaw ? parseFloat(p.fees24hRaw.toFixed(2)) : undefined,
        feeToTvlRatio:  p.feeToTvlRatio,
        darwinScore:    p.darwinScore ? parseFloat(p.darwinScore.toFixed(3)) : undefined,
        multiTFScore:   p.multiTFScore || undefined,
        smartWallet:    p.smartWallet || undefined,
        poolMemory:     p.poolMemory  || undefined,
        lpAgent:        p.lpAgent?.inLPAgentList
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
      let strategyMatch = null;
      let dlmmSnapshot = null;
      try {
        dlmmSnapshot = await getMarketSnapshot(info.tokenX, input.pool_address);
        strategyMatch = matchStrategyToMarket(dlmmSnapshot);
      } catch { /* optional */ }

      const pool = dlmmSnapshot?.pool;
      const price = dlmmSnapshot?.price;

      return JSON.stringify({
        poolInfo: info,
        dlmmEconomics: pool ? {
          feeApr:         `${pool.feeApr}% (${pool.feeAprCategory})`,
          feeVelocity:    pool.feeVelocity,
          feeTvlRatioPct: `${(pool.feeTvlRatio * 100).toFixed(3)}%/hari`,
          tvl:            pool.tvl,
          volume24h:      pool.volume24h,
          healthScore:    dlmmSnapshot?.healthScore,
          eligible:       pool.feeAprCategory !== 'LOW' && pool.feeTvlRatio > 0.01,
        } : null,
        priceContext: price ? {
          trend:              price.trend,
          momentumM5:         price.priceChangeM5,
          volatility:         `${price.volatility24h}% (${price.volatilityCategory})`,
          binStepFit:         info.binStep >= price.suggestedBinStepMin ? 'OK' : `⚠️ Butuh bin step ≥${price.suggestedBinStepMin}`,
          buyPressure:        `${price.buyPressurePct}% (${price.sentiment})`,
        } : null,
        strategyRecommendation: strategyMatch ? {
          recommended:     'Evil Panda (Adaptive)',
          confidence:      strategyMatch.recommended?.matchScore,
          entryConditions: 'm5 Momentum + h1 Trend Alignment',
          exitConditions:  'Evil Panda Confluence',
        } : null,
        validStrategyNames: ['Evil Panda'],
      }, null, 2);
    }

    case 'screen_token': {
      if (hunterNotifyFn) {
        const label = input.token_symbol || input.token_name || input.token_mint.slice(0, 8);
        await hunterNotifyFn(`🔬 *Coin Filter*: Screening \`${label}\`...`);
      }
      const result = await screenToken(
        input.token_mint,
        input.token_name || '',
        input.token_symbol || ''
      );
      if (result.verdict === 'AVOID' && hunterNotifyFn) {
        await hunterNotifyFn(`🚫 *Token Ditolak Coin Filter*\n\n${formatScreenResult(result)}`);
      }
      return JSON.stringify({
        verdict:         result.verdict,
        eligible:        result.eligible,
        highFlags:       result.highFlags.map(f => f.msg),
        mediumFlags:     result.mediumFlags.map(f => f.msg),
        priceImpact:     result.priceImpact,
        sources:         result.sources,
        action: result.verdict === 'AVOID'
          ? 'SKIP — cari kandidat lain'
          : 'LANJUT DEPLOY — jumlah token dihitung otomatis',
      }, null, 2);
    }

    case 'get_wallet_status': {
      const balance = await getWalletBalance();
      const openPos = getOpenPositions();
      // Jika run dari /entry dengan targetCount, hitung batas berdasarkan posisi yang akan dibuka
      const effectiveMax = _hunterTargetCount != null
        ? openPos.length + _hunterTargetCount
        : cfg.maxPositions;
      return JSON.stringify({
        solBalance: balance,
        openPositions: openPos.length,
        maxPositions: effectiveMax,
        targetCount: _hunterTargetCount,
        canOpen: parseFloat(balance) >= (cfg.deployAmountSol + (cfg.gasReserve ?? 0.02)) && openPos.length < effectiveMax,
        requiredSol: parseFloat((cfg.deployAmountSol + (cfg.gasReserve ?? 0.02)).toFixed(4)),
      }, null, 2);
    }

    case 'get_pool_memory': {
      const stats = getPoolStats(input.pool_address);
      if (!stats) {
        return JSON.stringify({ firstTime: true, message: 'Belum pernah deploy ke pool ini.' }, null, 2);
      }
      const verdict = stats.winRate < 40
        ? 'HINDARI — win rate rendah, histori buruk di pool ini'
        : stats.winRate < 60
        ? 'HATI-HATI — win rate di bawah rata-rata'
        : 'OK — histori positif di pool ini';
      return JSON.stringify({ ...stats, verdict }, null, 2);
    }

    case 'deploy_position': {
      // ── Guard: cegah deploy duplikat ke pool yang sama ──────────
      let existingPositions = getOpenPositions();
      const existingForPool   = existingPositions.find(p => p.pool_address === input.pool_address);
      if (existingForPool) {
        // Ada di DB — verifikasi on-chain dulu. DB bisa stale jika position ditutup
        // di luar bot (manual close, expired, dll) tanpa DB di-update.
        let accountExists = true;
        try {
          const conn    = getConnection();
          const pubkey  = new PublicKey(existingForPool.position_address);
          const info    = await conn.getAccountInfo(pubkey);
          accountExists = info !== null;
        } catch { /* best-effort — kalau gagal, anggap masih ada (safe default) */ }

        if (!accountExists) {
          // Account sudah tidak ada on-chain → DB stale → bersihkan dan izinkan deploy baru
          console.log(`[hunter] DB stale: posisi ${existingForPool.position_address} tidak ada on-chain, bersihkan dan izinkan re-deploy`);
          try {
            closePositionWithPnl(existingForPool.position_address, {
              pnlUsd: 0, pnlPct: 0, feesUsd: 0, closeReason: 'MANUAL_CLOSE', lifecycleState: 'closed_reconciled',
            });
          } catch { /* best-effort */ }
          // Re-fetch setelah cleanup agar slot count akurat
          existingPositions = getOpenPositions();
          // Tidak return di sini — lanjut ke deploy baru di bawah
        } else {
          // Posisi benar-benar masih ada on-chain → tolak duplikat
          return JSON.stringify({
            success:         true,
            alreadyDeployed: true,
            positionAddress: existingForPool.position_address,
            pool_address:    input.pool_address,
            strategyUsed:    existingForPool.strategy_used,
            note:            'SUDAH_ADA — skip diam-diam, lanjut kandidat berikutnya.',
          }, null, 2);
        }
      }

      // ── Guard: TX in-flight (deploy sedang berjalan untuk pool ini) ──
      if (_deployingPools.has(input.pool_address)) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool ${input.pool_address.slice(0, 8)}... sedang dalam proses deploy — tunggu TX selesai. Jangan retry.`,
        }, null, 2);
      }

      // ── Guard: slot posisi penuh ─────────────────────────────────
      const effectiveMaxPos = _hunterTargetCount != null
        ? existingPositions.length + _hunterTargetCount
        : cfg.maxPositions;
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
        return JSON.stringify({ blocked: true, reason: drawdown.reason }, null, 2);
      }

      // ── Auto-calculate position sizing ──────────────────────────
      const deployAmountSol = cfg.deployAmountSol || 0.1;
      const tokenXAmount    = 0;
      const tokenYAmount    = deployAmountSol;

      // Ambil pool info + validasi sebelum lock
      const poolInfo = await getPoolInfo(input.pool_address);

      // Guard: hanya deploy ke pool TOKEN/SOL
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      if (poolInfo.tokenY !== WSOL_MINT) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool tokenY bukan WSOL (${poolInfo.tokenYSymbol || poolInfo.tokenY?.slice(0,8)}) — bot hanya deploy ke pool TOKEN/SOL. Skip pool ini.`,
        }, null, 2);
      }

      // Strategy validation sebelum lock
      const strategy = getAllStrategies().find(s => s.name === 'Evil Panda');

      if (!strategy) {
        return JSON.stringify({
          blocked: true,
          reason: `Strategy "${input.strategy_name}" tidak valid. Gunakan salah satu dari: Evil Panda (utama), Wave Enjoyer (cadangan 1), NPC (cadangan 2). Pool DISKIP — jangan retry dengan nama lain.`,
        }, null, 2);
      }

      const stratParams = parseStrategyParameters(strategy);
      const strategyType = strategy?.strategy_type || 'spot';
      const strategyProfile = getStrategyProfile(strategy.name);

      let strategyEval = null;
      try {
        strategyEval = await evaluateStrategyReadiness({
          strategyName: strategy.name,
          poolInfo,
          poolAddress: input.pool_address,
        });
      } catch { /* best-effort */ }

      if (strategyEval && !strategyEval.ok) {
        return JSON.stringify({
          blocked: true,
          reason: `Strategy ${strategy.name} tidak valid untuk kondisi saat ini: ${strategyEval.blockers.join(' | ')}`,
          strategyNotes: strategyEval.notes,
        }, null, 2);
      }

      // Dynamic range — gunakan profile strategy lebih dulu, baru fallback generic.
      // Range — use strategy profile or default
      let targetPriceRangePct = strategyEval?.priceRangePct ?? stratParams.priceRangePercent ?? 10;
      const deployOptions = strategyEval?.deployOptions || {};

      // Strategy vs pool warning (non-blocking)
      try {
        const validation = validateStrategyForMarket(strategyType, poolInfo);
        if (!validation.valid && hunterNotifyFn) {
          await hunterNotifyFn(`⚠️ *Strategy Warning*\n\n${validation.warning}`);
        }
      } catch { /* skip */ }

      // ── Semua validasi lulus — sekarang lock dan kirim "Deploying..." ──
      _deployingPools.add(input.pool_address);

      if (hunterNotifyFn) {
        await hunterNotifyFn(
          `⚡ *Deploying...*\n` +
          `Pool: \`${input.pool_address.slice(0, 8)}...\`\n` +
          `Strategi: ${strategy.name}\n` +
          `_${(input.reasoning || '').slice(0, 100)}_`
        );
      }

      // Semua kode setelah lock dibungkus try/finally agar lock SELALU dilepas
      let result;
      try {
        // Konfirmasi Telegram (di sini karena butuh lock untuk cegah race)
        if (cfg.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
          const confirmed = await requestConfirmation(
            hunterNotifyFn,
            hunterBotRef,
            hunterAllowedId,
            `🚀 *Hunter Alpha ingin deploy:*\n\n` +
            `📍 Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
            `📊 Strategi: ${strategy.name}\n` +
            `💰 Deploy: ${deployAmountSol} SOL (Single-Side SOL)\n` +
            `  tokenX: 0 | tokenY: ${tokenYAmount.toFixed(4)} SOL\n\n` +
            `💭 ${input.reasoning}`
          );
          if (!confirmed) {
            // Kirim notif batal agar user tidak bingung kenapa "Deploying..." tanpa follow-up
            if (hunterNotifyFn) {
              await hunterNotifyFn(`❌ *Deploy Dibatalkan*\n\nUser tidak menyetujui deploy ke pool \`${input.pool_address.slice(0,8)}...\``).catch(() => {});
            }
            return JSON.stringify({ blocked: true, reason: 'Ditolak oleh user.' }, null, 2);
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
            policy: { isEntryOperation: true },
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
              `❌ *Deploy Gagal*\n\n` +
              `Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
              `Error: ${deployErr.message}\n` +
              `_Cek wallet balance dan Meteora UI untuk memastikan posisi tidak terbuat._`
            ).catch(() => {});
          }
          throw deployErr; // re-throw agar AI tahu dan bisa report
        }
      } finally {
        _deployingPools.delete(input.pool_address);
      }

      // Notifikasi & recording — dikurung try/catch agar error Telegram
      // tidak membuat tool return Error dan memicu AI retry ke pool yang sama
      try {
        if (hunterNotifyFn && result.success) {
          const cfg2    = getConfig();
          const tpTarget = strategyProfile?.exit?.takeProfitPct ?? cfg2.takeProfitFeePct ?? 5;
          const slTarget = strategyProfile?.exit?.emergencyStopLossPct ?? cfg2.stopLossPct ?? 5;
          const trailAct = strategyProfile?.exit?.trailingTriggerPct ?? cfg2.trailingTriggerPct ?? 3.0;
          const nPos     = result.positionCount ?? 1;

          const details = [
            kv('Posisi',   nPos > 1
              ? `${nPos}x chunks (${result.positions.map(p => shortAddr(p.address, 4, 4)).join(', ')})`
              : shortAddr(result.positionAddress, 4, 4), 9),
            kv('Pool',     shortAddr(input.pool_address, 4, 4), 9),
            kv('Strategi', strategy?.name || 'default', 9),
            kv('Deploy',   `${deployAmountSol} SOL (${nPos > 1 ? `${nPos} positions` : 'Single-Side'})`, 9),
            ...(nPos > 1 ? result.positions.map((p, i) =>
              kv(`Chunk${i+1}`, `${p.yAmountSol.toFixed(4)}◎ @ ${p.binCount} bins`, 9)
            ) : []),
            hr(40),
            kv('Entry',    result.entryPrice?.toFixed(8)  ?? '-', 9),
            kv('Bawah',    `${result.lowerPrice?.toFixed(8) ?? '-'}  (-${targetPriceRangePct}%)`, 9),
            kv('Atas',     `${result.upperPrice?.toFixed(8) ?? '-'}  (entry)`, 9),
            kv('Fee/bin',  `${result.feeRatePct}%`, 9),
            kv('Range',    `${deployOptions.fixedBinsBelow ? `${result.binsBelow + 1} bins` : `${targetPriceRangePct}%`} | ${result.positions.reduce((s, p) => s + p.binCount, 0)} bins total`, 9),
            hr(40),
            kv('TP',       `+${tpTarget}%  Trail: +${trailAct}%  SL: -${slTarget}%`, 9),
            ...(strategyEval?.notes?.length ? [kv('Setup', strategyEval.notes.join(' | ').slice(0, 40), 9)] : []),
          ];

          const txLinks = result.txHashes.slice(0, 3)
            .map((h, i) => `[Tx${result.txHashes.length > 1 ? i + 1 : ''}](https://solscan.io/tx/${h})`)
            .join(' · ');

          const openMsg =
            `🚀 *Posisi Dibuka${nPos > 1 ? ` (${nPos} Chunks)` : ''}*\n\n` +
            codeBlock(details) + '\n' +
            `💭 _${input.reasoning}_\n\n` +
            `🔗 ${txLinks}`;

          await hunterNotifyFn(openMsg);
        }

        // Record deploy ke pool memory + capture signals untuk Darwinian learning
        if (result.success && result.positionAddress) {
          recordDeployment(input.pool_address);
          const poolData = lastCandidates.find(c => c.address === input.pool_address);
          if (poolData) captureSignals(result.positionAddress, poolData);
        }
      } catch (notifErr) {
        // Notifikasi/recording gagal — JANGAN propagate error ini.
        // Posisi sudah berhasil di-deploy & tersimpan di DB.
        console.warn('[hunter] Post-deploy notification failed:', notifErr.message);
      }

      return JSON.stringify({ ...result, strategyUsed: strategy?.name, reasoning: input.reasoning }, null, 2);
    }

    case 'get_social_signals': {
      const signals = await getSocialSignals();
      return JSON.stringify({
        source: 'Meridian Social Hivemind',
        signals: signals.slice(0, 15),
        note: 'Gunakan mint address ini untuk memanggil screen_token jika belum ada di screen_pools.'
      }, null, 2);
    }

    case 'run_evolution': {
      const updates = await runEvolutionCycle();
      return JSON.stringify({
        success: !!updates,
        appliedUpdates: updates || 'No updates needed at this cycle (performance stable).',
        summary: updates ? 'Thresholds adjusted based on recent trade performance.' : 'Current thresholds are optimal.'
      }, null, 2);
    }

    default:
      return `Tool tidak dikenali: ${name}`;
  }
}

// ─── Screen-only: get top candidates without running LLM ─────────
// Used by auto-screening flow for batch Telegram approval


// ─── Main agent loop ─────────────────────────────────────────────

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null, options = {}) {
  hunterNotifyFn = notifyFn;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;
  _hunterTargetCount = options.targetCount ?? null;

  const cfg = getConfig();

  // ── Skip silently jika slot posisi penuh ─────────────────────
  const openPos = getOpenPositions();
  const effectiveMax = _hunterTargetCount != null
    ? openPos.length + _hunterTargetCount
    : cfg.maxPositions;
  if (openPos.length >= effectiveMax) {
    _hunterTargetCount = null;
    return null;
  }

  // ── Skip silently jika balance tidak cukup ───────────────────
  try {
    const balance = await getWalletBalance();
    if (parseFloat(balance) < (cfg.deployAmountSol + (cfg.gasReserve ?? 0.02))) {
      _hunterTargetCount = null;
      return null;
    }
  } catch { /* lanjut jika gagal cek balance */ }

  // ── PRE-COMPUTE: parallelkan pool screening sebelum LLM loop ─
  // Mengurangi LLM round trips dari 40+ menjadi ~6-8.
  // getTopPools + pool memory + OKX dijalankan sekaligus, bukan satu per satu oleh LLM.
  if (notifyFn) await notifyFn(`🔍 *Screening kandidat pool...*\n📡 _Social Awareness: Active (Meridian Feed)_`);

  let preComputedContext = '';
  try {
    const thresholds = getThresholds();
    const weights    = getDarwinWeights(); // adaptive weights dari data nyata
    const [rawPools, socialSignals] = await Promise.all([
      getTopPools(25),
      getSocialSignals().catch(() => [])
    ]);

    const filtered = rawPools
      .filter(p => {
        const tvl      = p.liquidityRaw || 0;
        const fees     = p.fees24hRaw   || 0;
        const feeRatio = tvl > 0 ? fees / tvl : 0;
        const binStep  = p.binStep || 0;
        return (
          binStep > 0 && binStep <= 250 &&
          tvl >= thresholds.minTvl     &&
          tvl <= thresholds.maxTvl     &&
          feeRatio >= thresholds.minFeeActiveTvlRatio &&
          !isOnCooldown(p.address) // skip pool sedang cooldown
        );
      })
      .map(p => {
        // Map social signal if available
        const socialMatch = socialSignals.find(s => s.mint === p.tokenX);
        if (socialMatch) p.socialSignal = socialMatch;
        return { ...p, darwinScore: calculateDarwinScore(p, weights) };
      })
      .sort((a, b) => b.darwinScore - a.darwinScore)
      .slice(0, 7);

    lastCandidates = filtered;

    // Fetch pool memory + multi-TF + smart wallets in parallel
    const enriched = await Promise.all(filtered.map(async (p) => {
      const [memResult, mtfResult, swResult] = await Promise.allSettled([
        Promise.resolve(getPoolStats(p.address)),
        getMultiTFScore(p.tokenX, p.address),
        checkSmartWalletsOnPool(p.address),
      ]);

      const mem = memResult.status === 'fulfilled' ? memResult.value : null;
      const mtf = mtfResult.status === 'fulfilled' ? mtfResult.value : null;
      const sw  = swResult.status  === 'fulfilled' ? swResult.value  : null;

      // Update darwinScore dengan multiTFScore
      if (mtf?.score > 0) {
        p.multiTFScore = mtf.score;
        p.darwinScore  = calculateDarwinScore({ ...p, multiTFScore: mtf.score }, weights);
      }

      const memVerdict = !mem
        ? 'firstTime'
        : mem.winRate < 40 ? 'HINDARI'
        : mem.winRate < 60 ? 'HATI-HATI'
        : 'OK';

      const tvl = p.liquidityRaw || 0;
      return {
        address:      p.address,
        name:         p.name,
        darwinScore:  p.darwinScore,
        tvl:          tvl.toFixed(0),
        fees24h:      (p.fees24hRaw || 0).toFixed(2),
        socialHype:   p.socialSignal ? `🔥 Discord Impact: ${p.socialSignal.intensity}/10` : 'Neutral',
        feeToTvlPct:  tvl > 0 ? ((p.fees24hRaw || 0) / tvl * 100).toFixed(2) + '%' : '0%',
        binStep:      p.binStep,
        tokenXMint:   p.tokenX,
        poolMemory:   mem
          ? { winRate: mem.winRate, totalTrades: mem.totalTrades, verdict: memVerdict }
          : { verdict: 'firstTime' },
        multiTF:      mtf ? {
          score: mtf.score,
          bullishTFs: `${mtf.bullishCount}/${mtf.validCount}`,
          breakdown: Object.entries(mtf.breakdown || {})
            .map(([tf, d]) => `${tf}:${d.bullish ? '✅' : '❌'}`).join(' '),
        } : null,
        smartWallet: sw?.found
          ? { wallets: sw.matches.map(m => m.label), confidence: sw.confidence }
          : null,
      };
    }));

    // Filter obvious rejects sebelum dikirim ke LLM
    const viable  = enriched.filter(p => p.poolMemory.verdict !== 'HINDARI');
    const skipped = enriched.length - viable.length;

    if (notifyFn) {
      const smartWalletHits = enriched.filter(p => p.smartWallet?.wallets?.length > 0).length;
      const highTFAlign     = enriched.filter(p => (p.multiTF?.score || 0) >= 0.67).length;
      await notifyFn(
        `📊 *Pre-screening selesai*\n` +
        `✅ Viable: ${viable.length}  ❌ Filtered: ${skipped}\n` +
        (highTFAlign > 0 ? `📈 Multi-TF kuat (≥4 TF): ${highTFAlign} pool\n` : '') +
        (smartWalletHits > 0 ? `🎯 Smart wallet detected: ${smartWalletHits} pool\n` : '') +
        `_Menjalankan analisis mendalam..._`
      );
    }

    const display = viable.length > 0 ? viable : enriched.slice(0, 3);

    preComputedContext =
      `\n\n──────────────────────────────────────\n` +
      `PRE-SCREENING SELESAI — DATA SUDAH TERSEDIA\n` +
      `Pool Memory, OKX, Multi-TF, dan Smart Wallet sudah diambil. JANGAN fetch ulang.\n` +
      `Langsung: (1) get_pool_detail top kandidat → (2) screen_token → (3) deploy_position\n\n` +
      `Kandidat viable (${display.length} pool, urut darwinScore):\n` +
      JSON.stringify(display, null, 2);
  } catch (e) {
    console.error('Hunter pre-compute failed:', e.message);
    preComputedContext = '\n\nCatatan: Pre-screening gagal. Gunakan screen_pools untuk ambil kandidat.';
  }

  const lessonsCtx = getLessonsContext();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();
  const libraryStats = getLibraryStats();

  const systemPrompt = `Kamu adalah Adaptive Evil Panda Specialist — autonomous DLMM agent untuk Meteora.
Bot ini tidak lagi menggunakan strategi kaku, melainkan menggunakan "Instinct" dari trade sebelumnya dan "5m Momentum Velocity".

╔══════════════════════════════════════════════════════════════╗
║  MODE AUTONOMOUS — TIDAK ADA INTERAKSI DENGAN USER          ║
║  Kamu ADAPTIF. Pelajari kegagalan masa lalu agar tidak rugi.║
║  JANGAN tanya konfirmasi. LANGSUNG pakai tool.              ║
║  Gunakan HANYA strategi "Evil Panda".                       ║
╚══════════════════════════════════════════════════════════════╝

MINDSET: Kamu mengejar FEE di pool yang sedang "pumping" volume-nya di timeframe 5 menit.

ALUR KERJA — ADAPTIVE EVIL PANDA SPECIALIST:
1. Baca kandidat dari data pre-screening (darwinScore).
2. get_wallet_status → cek balance & slot.
3. Untuk TOP 3 kandidat:
   a. get_pool_detail → Wajib cek: momentumM5 (harus green/spike) dan feeApr (>100% preferred).
   b. get_pool_memory → Jika pool ini punya histori "HINDARI", buang langsung.
   c. screen_token → SECURITY WALLS (Auto Check):
      • Mint/Freeze Authority aktif? → REJECT (AVOID)
      • Price Impact > 0.5%? → REJECT (AVOID)
   d. MEMORY CHECK (Instincts):
      • Baca lessonsCtx dan instincts. Jika pattern pool ini mirip kegagalan sebelumnya (pm-lessons), JANGAN masuk.
4. deploy_position → Gunakan "Evil Panda".

⚠️ ATURAN STRATEGI "EVIL PANDA":
- Target: Pool dengan Bin Step 80-200.
- Trigger: Momentum 5m > 1.5% (UPTREND) atau > 3% (PUMPING).
- Focus: Fee APR tinggi (>2000%) lebih diutamakan jika momentum stabil.

⚠️ POST-MORTEM LEARNING:
Bot ini secara otomatis melakukan analisa "Kenapa Loss" setiap kali trade selesai.
Gunakan data di bawah (${lessonsCtx}) sebagai "Suara Hati" kamu saat memilih pool.

Mode: 🔴 LIVE ALPHA | Strategi: EVIL PANDA ONLY
${lessonsCtx}
${instincts}
${strategyIntel}

Gunakan Bahasa Indonesia. Reasoning tajam, eksekusi cepat.`;

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

    response = await createMessage({
      model: resolveModel(cfg.screeningModel),
      maxTokens: 4096,
      system: systemPrompt,
      tools: HUNTER_TOOLS,
      messages,
    });
  }

  if (rounds >= MAX_ROUNDS && notifyFn) {
    await notifyFn(`⚠️ *Hunter Alpha* — batas ${MAX_ROUNDS} putaran tercapai, loop dihentikan paksa.`);
  }

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };
  _hunterTargetCount = null; // reset setelah selesai

  // Hanya kirim report jika ada deploy nyata ATAU report mengandung informasi penting
  // (bukan sekadar "posisi sudah ada / skip"). Cegah notifikasi spam yang confusing.
  const reportIsNoise = !anyRealDeploy && (
    report.toLowerCase().includes('sudah ada') ||
    report.toLowerCase().includes('already') ||
    report.toLowerCase().includes('sudah aktif') ||
    report.toLowerCase().includes('skip') ||
    report.trim().length < 30
  );

  if (notifyFn && !reportIsNoise) {
    await notifyFn(`🦅 *Hunter Alpha Report*\n\n${report}`);
  }
  return report;
}
