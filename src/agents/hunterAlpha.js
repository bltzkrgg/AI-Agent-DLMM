import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, getPoolStats } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';
import { checkMaxDrawdown, validateStrategyForMarket, requestConfirmation } from '../safety/safetyManager.js';
import { matchStrategyToMarket, getLibraryStats } from '../market/strategyLibrary.js';
import { getMarketSnapshot, getOKXData, getOHLCV, getMultiTFScore } from '../market/oracle.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { screenToken, formatScreenResult } from '../market/coinfilter.js';
import { parseTvl } from '../utils/safeJson.js';
import { kv, hr, codeBlock, shortAddr } from '../utils/table.js';
import { calcDynamicRangePct } from '../market/taIndicators.js';
import { formatStrategyAlert } from '../utils/alerts.js';
import { getDarwinWeights, captureSignals } from '../market/signalWeights.js';
import { isOnCooldown, getPoolMemoryContext, recordDeployment } from '../market/poolMemory.js';
import { checkSmartWalletsOnPool, formatSmartWalletSignal } from '../market/smartWallets.js';
import { discoverPools as lpAgentDiscoverPools, enrichPools as lpAgentEnrichPools, isLPAgentEnabled } from '../market/lpAgent.js';

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
    name: 'get_okx_signal',
    description: 'Cek OKX smart money signal untuk token tertentu. Gunakan untuk cross-reference kandidat — SM masih holding = conviction tinggi, SM sudah jual = skip.',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string' },
      },
      required: ['token_mint'],
    },
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
          const [mtf, sw] = await Promise.allSettled([
            getMultiTFScore(p.tokenX, p.address),
            checkSmartWalletsOnPool(p.address),
          ]);
          if (mtf.status === 'fulfilled') multiTFScore = mtf.value.score || 0;
          if (sw.status === 'fulfilled' && sw.value.found) smartWalletSignal = sw.value;
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
          volatility:         `${price.volatility24h}% (${price.volatilityCategory})`,
          binStepFit:         info.binStep >= price.suggestedBinStepMin ? 'OK' : `⚠️ Butuh bin step ≥${price.suggestedBinStepMin}`,
          buyPressure:        `${price.buyPressurePct}% (${price.sentiment})`,
        } : null,
        taSignals: dlmmSnapshot?.ta ? {
          rsi14:          dlmmSnapshot.ta.rsi14,
          rsi2:           dlmmSnapshot.ta.rsi2,
          supertrend:     dlmmSnapshot.ta.supertrend,
          evilPandaEntry: dlmmSnapshot.ta.evilPanda?.entry ?? null,
          evilPandaExit:  dlmmSnapshot.ta.evilPanda?.exit  ?? null,
          bb:             dlmmSnapshot.ta.bb,
          macd:           dlmmSnapshot.ta.macd
            ? { histogram: dlmmSnapshot.ta.macd.histogram, firstGreenAfterRed: dlmmSnapshot.ta.macd.firstGreenAfterRed }
            : null,
          dataSource:     dlmmSnapshot.dataSource,
        } : null,
        strategyRecommendation: strategyMatch ? {
          recommended:     strategyMatch.recommended?.name,
          confidence:      strategyMatch.recommended?.matchScore,
          entryConditions: strategyMatch.recommended?.entryConditions,
          exitConditions:  strategyMatch.recommended?.exitConditions,
          alternatives:    strategyMatch.alternatives?.map(s => s.name),
        } : null,
        deployToken: {
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          isSOL: true,
          note: 'Bot hanya menyimpan SOL — semua deploy adalah Single-Side SOL (tokenX=0, tokenY=SOL)',
        },
        validStrategyNames: ['Single-Side SOL', 'Evil Panda', 'Wave Enjoyer', 'NPC', 'Fee Sniper', 'Spot Balanced', 'Bid-Ask Wide', 'Single-Side Token X', 'Curve Concentrated'],
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
        rugcheck:        result.rugCheckData?.available ? {
          dangerRisks: result.rugCheckData.dangerRisks,
          warnRisks:   result.rugCheckData.warnRisks,
          scoreNorm:   result.rugCheckData.scoreNorm,
          rugged:      result.rugCheckData.rugged,
        } : null,
        mcap:            result.mcap ?? null,
        drawdownPct:     result.drawdownPct ?? null,
        jupiterStrict:   result.jupiterData?.isStrict   || false,
        jupiterVerified: result.jupiterData?.isVerified || false,
        jupiterPrice:    result.jupiterData?.priceUsd   || null,
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

    case 'get_okx_signal': {
      if (!process.env.OKX_API_KEY) {
        return JSON.stringify({ available: false, reason: 'OKX_API_KEY not set — skip signal check' }, null, 2);
      }
      const okx = await getOKXData(input.token_mint);
      if (!okx?.available) {
        return JSON.stringify({ available: false, reason: 'OKX data tidak tersedia untuk token ini' }, null, 2);
      }
      const verdict = okx.smartMoneySelling === true
        ? 'SKIP — smart money sudah jual, potensi dump'
        : okx.smartMoneyBuying === true
        ? 'STRONG — smart money masih akumulasi, conviction tinggi'
        : 'NEUTRAL — tidak ada sinyal smart money yang kuat';
      return JSON.stringify({
        available:          true,
        smartMoneyBuying:   okx.smartMoneyBuying,
        smartMoneySelling:  okx.smartMoneySelling,
        smartMoneySignal:   okx.smartMoneySignal,
        signalStrength:     okx.signalStrength,
        isHoneypot:         okx.isHoneypot,
        riskLevel:          okx.riskLevel,
        dlmmNote:           okx.dlmmNote,
        verdict,
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
      const existingPositions = getOpenPositions();
      if (existingPositions.some(p => p.pool_address === input.pool_address)) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool ${input.pool_address.slice(0, 8)}... sudah ada posisi terbuka — skip duplikat. Pilih pool lain.`,
        }, null, 2);
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

      if (hunterNotifyFn) {
        await hunterNotifyFn(
          `⚡ *Deploying...*\n` +
          `Pool: \`${input.pool_address.slice(0, 8)}...\`\n` +
          `Strategi: ${input.strategy_name || 'Single-Side SOL'}\n` +
          `_${(input.reasoning || '').slice(0, 100)}_`
        );
      }
      // Safety: max drawdown check
      const drawdown = checkMaxDrawdown();
      if (drawdown.triggered) {
        return JSON.stringify({ blocked: true, reason: drawdown.reason }, null, 2);
      }

      // ── Auto-calculate position sizing ───────────────────────
      // Bot hanya punya SOL — selalu Single-Side SOL (tokenX=0, tokenY=full)
      const deployAmountSol = cfg.deployAmountSol || 0.1;
      const tokenXAmount    = 0;
      const tokenYAmount    = deployAmountSol;

      // Ambil pool info untuk harga dan validasi
      const poolInfo = await getPoolInfo(input.pool_address);

      // ── Guard: hanya deploy ke pool TOKEN/SOL ────────────────
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      if (poolInfo.tokenY !== WSOL_MINT) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool tokenY bukan WSOL (${poolInfo.tokenYSymbol || poolInfo.tokenY?.slice(0,8)}) — bot hanya deploy ke pool TOKEN/SOL. Skip pool ini.`,
        }, null, 2);
      }

      // ── Strategy resolution — wajib pakai salah satu strategi aktif ────
      const allStrategies = getAllStrategies();
      const BLOCKED_STRATEGIES = ['Single-Side SOL'];
      const strategy = allStrategies.find(
        s => s.name === input.strategy_name && !BLOCKED_STRATEGIES.includes(s.name)
      );

      if (!strategy) {
        const isBlocked = BLOCKED_STRATEGIES.includes(input.strategy_name);
        return JSON.stringify({
          blocked: true,
          reason: isBlocked
            ? `Strategy "Single-Side SOL" tidak diizinkan. Wajib pilih dari: Evil Panda, Wave Enjoyer, NPC, Fee Sniper.`
            : `Strategy "${input.strategy_name}" tidak ditemukan di library. Pool DISKIP — wajib pilih dari: Evil Panda, Wave Enjoyer, NPC, Fee Sniper.`,
        }, null, 2);
      }

      const stratParams = parseStrategyParameters(strategy);
      const strategyType = strategy?.strategy_type || 'spot';

      // ── Dynamic range — ATR + volatility + trend + BB ────────────
      // Replaces static priceRangePercent from strategy config
      let priceRangePct = stratParams.priceRangePercent || 10;
      try {
        const ohlcv = await getOHLCV(poolInfo.tokenX, input.pool_address);
        if (ohlcv) {
          const epType = (strategy?.type === 'evil_panda' || strategy?.name === 'Evil Panda')
            ? 'evil_panda' : 'single_side_y';
          priceRangePct = calcDynamicRangePct({
            atr14Pct:    ohlcv.atr14?.atrPct     ?? 0,
            range24hPct: ohlcv.range24hPct        ?? 0,
            trend:       ohlcv.trend              ?? 'SIDEWAYS',
            bbBandwidth: ohlcv.ta?.bb?.bandwidth  ?? 0,
            strategyType: epType,
          });
        }
      } catch { /* fallback to static */ }

      // Validate strategy vs pool conditions (volatilitas vs bin step)
      let validation = { valid: true, warning: null };
      try {
        validation = validateStrategyForMarket(strategyType, poolInfo);
        if (!validation.valid && hunterNotifyFn) {
          await hunterNotifyFn(`⚠️ *Strategy Warning*\n\n${validation.warning}`);
        }
      } catch { /* skip */ }

      // Konfirmasi Telegram
      if (cfg.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
        const confirmed = await requestConfirmation(
          hunterNotifyFn,
          hunterBotRef,
          hunterAllowedId,
          `🚀 *Hunter Alpha ingin deploy:*\n\n` +
          `📍 Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
          `📊 Strategi: ${strategy?.name || 'default'}\n` +
          `💰 Deploy: ${deployAmountSol} SOL (Single-Side SOL)\n` +
          `  tokenX: 0 | tokenY: ${tokenYAmount.toFixed(4)} SOL\n\n` +
          `💭 ${input.reasoning}`
        );
        if (!confirmed) {
          return JSON.stringify({ blocked: true, reason: 'Ditolak oleh user.' }, null, 2);
        }
      }

      // ── Pre-deploy opportunity alert ─────────────────────────
      if (hunterNotifyFn) {
        await hunterNotifyFn(formatStrategyAlert({
          strategy:    strategy?.name || 'Single-Side SOL',
          pool:        null,
          poolAddress: input.pool_address,
          reason:      input.reasoning?.slice(0, 120) || '-',
          priority:    strategy?.name === 'Evil Panda' ? 'HIGH'
            : strategy?.name === 'Wave Enjoyer' || strategy?.name === 'Fee Sniper' ? 'MEDIUM'
            : 'LOW',
        }));
      }

      // Execute with dynamic range — lock pool selama TX in-flight
      _deployingPools.add(input.pool_address);
      let result;
      try {
        result = await openPosition(
          input.pool_address,
          tokenXAmount,
          tokenYAmount,
          priceRangePct,
          strategy?.name || null
        );
      } finally {
        _deployingPools.delete(input.pool_address);
      }

      // Notifikasi posisi terbuka dengan detail PnL awal
      if (hunterNotifyFn && result.success) {
        const cfg2    = getConfig();
        const tpTarget = cfg2.takeProfitFeePct ?? 5;
        const slTarget = cfg2.stopLossPct      ?? 5;
        const trailAct = cfg2.trailingTriggerPct ?? 3.0;
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
          kv('Bawah',    `${result.lowerPrice?.toFixed(8) ?? '-'}  (-${priceRangePct}%)`, 9),
          kv('Atas',     `${result.upperPrice?.toFixed(8) ?? '-'}  (entry)`, 9),
          kv('Fee/bin',  `${result.feeRatePct}%`, 9),
          kv('Range',    `${priceRangePct}% | ${result.positions.reduce((s, p) => s + p.binCount, 0)} bins total`, 9),
          hr(40),
          kv('TP',       `+${tpTarget}%  Trail: +${trailAct}%  SL: -${slTarget}%`, 9),
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

        // Capture signals for all positions (use first address for primary signal)
        const poolData = lastCandidates.find(c => c.address === input.pool_address);
        if (poolData) captureSignals(result.positionAddress, poolData);
      }

      return JSON.stringify({ ...result, strategyUsed: strategy?.name, reasoning: input.reasoning }, null, 2);
    }

    default:
      return `Tool tidak dikenali: ${name}`;
  }
}

// ─── Screen-only: get top candidates without running LLM ─────────
// Used by auto-screening flow for batch Telegram approval

export async function getScreeningCandidates(limit = 5) {
  const cfg       = getConfig();
  const thresholds = getThresholds();
  const weights   = getDarwinWeights();
  const minBinStep      = cfg.minBinStep      || 1;
  const minTokenFeesSol = cfg.minTokenFeesSol || 0;

  const rawPools = await getTopPools(limit * 4);
  const filtered = rawPools
    .filter(p => {
      const tvl      = p.liquidityRaw || 0;
      const fees     = p.fees24hRaw   || 0;
      const feeRatio = tvl > 0 ? fees / tvl : 0;
      const binStep  = p.binStep || 0;
      return (
        binStep >= minBinStep && binStep <= 250 &&
        tvl >= thresholds.minTvl &&
        tvl <= thresholds.maxTvl &&
        feeRatio >= thresholds.minFeeActiveTvlRatio &&
        (minTokenFeesSol <= 0 || fees >= minTokenFeesSol) &&
        !isOnCooldown(p.address)
      );
    })
    .map(p => ({ ...p, darwinScore: calculateDarwinScore(p, weights) }))
    .sort((a, b) => b.darwinScore - a.darwinScore)
    .slice(0, limit);

  // Enrich in parallel
  const enriched = await Promise.all(filtered.map(async (p) => {
    const [mtfResult, swResult] = await Promise.allSettled([
      getMultiTFScore(p.tokenX, p.address),
      checkSmartWalletsOnPool(p.address),
    ]);
    const mtf = mtfResult.status === 'fulfilled' ? mtfResult.value : null;
    const sw  = swResult.status  === 'fulfilled' ? swResult.value  : null;

    if (mtf?.score > 0) {
      p.multiTFScore = mtf.score;
      p.darwinScore  = calculateDarwinScore({ ...p, multiTFScore: mtf.score }, weights);
    }

    return {
      address:     p.address,
      name:        p.name,
      darwinScore: parseFloat(p.darwinScore.toFixed(3)),
      tvl:         (p.liquidityRaw || 0).toFixed(0),
      fees24h:     (p.fees24hRaw   || 0).toFixed(2),
      binStep:     p.binStep,
      tokenX:      p.tokenX,
      multiTFScore: mtf?.score ?? 0,
      multiTFBreakdown: mtf?.breakdown ?? null,
      smartWallet: sw?.found ? sw.matches.map(m => m.label) : [],
      scannedAt:   Date.now(),
    };
  }));

  lastCandidates = enriched;
  return enriched.sort((a, b) => b.darwinScore - a.darwinScore);
}

// ─── Main agent loop ─────────────────────────────────────────────

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null, options = {}) {
  hunterNotifyFn = notifyFn;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;
  _hunterTargetCount = options.targetCount ?? null;
  const forcedPool = options.forcedPool ?? null; // pre-selected pool dari approval flow

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
  if (notifyFn) await notifyFn(`🔍 *Screening kandidat pool...*`);

  let preComputedContext = '';
  try {
    const thresholds = getThresholds();
    const weights    = getDarwinWeights(); // adaptive weights dari data nyata
    const rawPools   = await getTopPools(25);

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
      .map(p => ({ ...p, darwinScore: calculateDarwinScore(p, weights) }))
      .sort((a, b) => b.darwinScore - a.darwinScore)
      .slice(0, 7);

    lastCandidates = filtered;

    // Fetch pool memory + OKX + multi-TF + smart wallets in parallel
    const enriched = await Promise.all(filtered.map(async (p) => {
      const [memResult, okxResult, mtfResult, swResult] = await Promise.allSettled([
        Promise.resolve(getPoolStats(p.address)),
        process.env.OKX_API_KEY
          ? getOKXData(p.tokenX).catch(() => null)
          : Promise.resolve(null),
        getMultiTFScore(p.tokenX, p.address),
        checkSmartWalletsOnPool(p.address),
      ]);

      const mem = memResult.status === 'fulfilled' ? memResult.value : null;
      const okx = okxResult.status === 'fulfilled' ? okxResult.value : null;
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
      const okxVerdict = !okx?.available
        ? 'NEUTRAL'
        : okx.smartMoneySelling ? 'SKIP'
        : okx.smartMoneyBuying  ? 'STRONG'
        : 'NEUTRAL';

      const tvl = p.liquidityRaw || 0;
      return {
        address:      p.address,
        name:         p.name,
        darwinScore:  p.darwinScore,
        tvl:          tvl.toFixed(0),
        fees24h:      (p.fees24hRaw || 0).toFixed(2),
        feeToTvlPct:  tvl > 0 ? ((p.fees24hRaw || 0) / tvl * 100).toFixed(2) + '%' : '0%',
        binStep:      p.binStep,
        tokenXMint:   p.tokenX,
        poolMemory:   mem
          ? { winRate: mem.winRate, totalTrades: mem.totalTrades, verdict: memVerdict }
          : { verdict: 'firstTime' },
        okxSignal:    { verdict: okxVerdict },
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
    const viable  = enriched.filter(p => p.poolMemory.verdict !== 'HINDARI' && p.okxSignal.verdict !== 'SKIP');
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

    // Jika ada forced pool dari approval flow, prioritaskan dia di atas
    const forcedPoolNote = forcedPool
      ? `\n⚡ FORCED POOL (user-approved): ${forcedPool} — DEPLOY KE POOL INI DULUAN.\n`
      : '';

    preComputedContext =
      `\n\n──────────────────────────────────────\n` +
      `PRE-SCREENING SELESAI — DATA SUDAH TERSEDIA\n` +
      `Pool Memory, OKX, Multi-TF, dan Smart Wallet sudah diambil. JANGAN fetch ulang.\n` +
      forcedPoolNote +
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

  const systemPrompt = `Kamu adalah Hunter Alpha — autonomous DLMM LP agent untuk Meteora di Solana.

╔══════════════════════════════════════════════════════════════╗
║  MODE AUTONOMOUS — TIDAK ADA INTERAKSI DENGAN USER          ║
║  Kamu HARUS memutuskan dan mengeksekusi SENDIRI.             ║
║  JANGAN tanya jumlah token. JANGAN minta konfirmasi.         ║
║  JANGAN tunggu input siapapun. LANGSUNG pakai tool.          ║
║  Jumlah token sudah dihitung OTOMATIS oleh sistem.           ║
╚══════════════════════════════════════════════════════════════╝

MINDSET: Kamu LP specialist. Profit = FEE, bukan price appreciation.

ALUR KERJA — JALANKAN CEPAT, MAKSIMAL 3 KANDIDAT:
Data pool memory dan OKX sudah tersedia di pesan user — JANGAN fetch ulang.
1. Baca kandidat dari data pre-screening yang sudah dikirim
2. get_wallet_status → cek balance & slot (jika penuh/kurang → STOP total)
3. Pilih TOP 2 kandidat (darwinScore tertinggi, bukan HINDARI/SKIP):
   a. get_pool_detail → baca feeApr, feeVelocity, healthScore, binStep fit
      • eligible = false atau feeApr < 30% → SKIP
      • healthScore < 40 → SKIP
   b. screen_token → Coin Filter WAJIB
      • action = 'SKIP' → kandidat berikutnya
      • action = 'LANJUT DEPLOY' → LANGSUNG deploy_position SEKARANG
4. Selesai — laporkan hasil singkat ke user

STRATEGI — BACA LIBRARY, JANGAN HARDCODE:
  get_pool_detail memberikan rekomendasi strategi dari Strategy Library berdasarkan kondisi market saat ini.
  IKUTI rekomendasinya. Jangan otomatis pakai "Single-Side SOL" kalau library rekomendasikan yang lain.

  STRATEGI TERSEDIA — PILIH BERDASARKAN KONDISI AKTUAL:

  🐼 EVIL PANDA (Priority HIGH)
  • Bin step 80/100/125 | Volume24h >$1M | MC >$250k
  • GATE WAJIB: taSignals.supertrend.justCrossedAbove === true
  • Trend UPTREND | OKX SM buying (bonus)
  • Range: ATR-dynamic (~12-80%) | Exit: RSI(2)>90 + BB upper ATAU MACD first green

  🌊 WAVE ENJOYER (Priority MEDIUM)
  • Price dalam 8% di atas support 24h (priceContext.support)
  • RSI14 antara 35-62 (buyers masuk, belum overbought)
  • Volume ≥ 70% rata-rata | Trend SIDEWAYS atau mild down
  • Range: ATR-dynamic | Exit: jika support broken atau rally +8-15%

  🎯 NPC (Priority LOW)
  • 24h price range >15% (breakout sudah terjadi)
  • ATR saat ini < 12% dari range24h (price sedang konsolidasi)
  • Volume masih elevated ≥ avg | Supertrend masih bullish
  • Range: ATR-dynamic | Hold 4-12 jam

  ⚡ FEE SNIPER (Priority MEDIUM)
  • BB bandwidth < 8% (squeeze/konsolidasi ketat)
  • ATR < 2% | Fee APR pool > 200%
  • Volume sustained ≥ 60% avg | Trend SIDEWAYS
  • Range: 3-5% ultra-tight | Exit: saat BB expand >10%

  ⛔ JIKA TIDAK ADA STRATEGI YANG COCOK → SKIP POOL. Jangan deploy.

LP AGENT SIGNAL (di setiap kandidat pool):
  lpAgent.inLPAgentList = true → pool diakui LP Agent sebagai top performer
  lpAgent.organicScore → organic score menurut LP Agent (0-100, >70 = bagus)
  lpAgent.feeTVLRatioLP → fee/TVL ratio versi LP Agent (cross-check vs DexScreener)
  Pool dari LP Agent dengan inLPAgentList=true = sinyal SMART LP interest — bobot setara smartWallet.

DARWINIAN WEIGHTS:
  TVL (2.5x) + fee/TVL (2.3x) = sinyal kuat. Volume (0.36x) + holders (0.3x) = abaikan.

FILTER TOKEN (dari Coin Filter — DexScreener, RugCheck, Helius, OKX, GeckoTerminal):
  AVOID → SKIP pool. CAUTION/PASS → DEPLOY LANGSUNG.
  RugCheck: warn+danger risks → REJECT. Mcap + ATH drawdown juga di-check.

NAMA STRATEGI — WAJIB PERSIS SALAH SATU DARI 4 INI:
  "Evil Panda" | "Wave Enjoyer" | "NPC" | "Fee Sniper"
  ⚠️ "Single-Side SOL" dan nama lain DIBLOKIR — sistem akan SKIP pool jika dikirim.
  Tidak ada fallback. Jika kondisi pool tidak cocok keempat strategi di atas → SKIP pool.

STRATEGY LIBRARY (${libraryStats.totalStrategies} strategi):
${libraryStats.topStrategies.map(s => `  ${s.name} (${s.type}, ${(s.confidence * 100).toFixed(0)}% conf)`).join('\n')}

Mode: 🔴 LIVE | Deploy: ${cfg.deployAmountSol} SOL/posisi${_hunterTargetCount != null ? ` | Target: ${_hunterTargetCount} posisi baru` : ''}
${lessonsCtx}
${instincts}
${strategyIntel}

Gunakan Bahasa Indonesia untuk laporan akhir. Reasoning singkat, action langsung.`;

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

  if (notifyFn) await notifyFn(`🦅 *Hunter Alpha Report*\n\n${report}`);
  return report;
}
