import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';
import { checkMaxDrawdown, validateStrategyForMarket, requestConfirmation } from '../safety/safetyManager.js';
import { matchStrategyToMarket, getLibraryStats } from '../market/strategyLibrary.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { screenToken, formatScreenResult } from '../market/coinfilter.js';
import { parseTvl } from '../utils/safeJson.js';

// ─── State ───────────────────────────────────────────────────────

let lastCandidates = [];
let lastReport = null;
let hunterNotifyFn = null;
let hunterBotRef = null;
let hunterAllowedId = null;

export function getCandidates() { return lastCandidates; }
export function getLastHunterReport() { return lastReport; }

// ─── Darwinian Scoring ───────────────────────────────────────────
// Weights dari 263 closed positions:
//   mcap: 2.5x (strong predictor)  |  fee/TVL: 2.3x (strong)
//   volume: 0.36x (near floor)     |  holderCount: 0.3x (floor/useless)

function calculateDarwinScore(pool, weights) {
  const w = weights || { mcap: 2.5, feeActiveTvlRatio: 2.3, volume: 0.36, holderCount: 0.3 };
  let score = 0;

  // fee/TVL ratio (2.3x) — strong predictor
  const tvl  = pool.liquidityRaw || pool.tvl || 0;
  const fees = pool.fees24hRaw   || 0;
  if (tvl > 0 && fees > 0) {
    const ratio      = fees / tvl;
    const ratioScore = Math.min(ratio / 0.05, 2.0) / 2.0; // 5% ratio = max 1.0
    score += ratioScore * w.feeActiveTvlRatio;
  }

  // volume (0.36x) — near floor, de-emphasize
  const vol = pool.volume24hRaw || 0;
  if (vol > 0) {
    score += Math.min(vol / 500000, 1.0) * w.volume;
  }

  // mcap proxy via TVL (2.5x) — strong predictor
  if (tvl > 0) {
    const mcapScore = tvl < 10000 ? 0.2 : tvl < 50000 ? 0.5 : tvl < 100000 ? 0.8 : 1.0;
    score += mcapScore * w.mcap;
  }

  // holderCount (0.3x) — useless, static contribution
  score += 0.3 * w.holderCount;

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
    description: 'WAJIB sebelum deploy. Screen token untuk deteksi scam/rug via RugCheck, GMGN, dan pattern analysis.',
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
    name: 'deploy_position',
    description: 'Deploy likuiditas ke pool. Hanya boleh dipanggil setelah screen_token verdict PASS atau CAUTION.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari Strategy Library' },
        token_x_amount: { type: 'number' },
        token_y_amount: { type: 'number' },
        reasoning: { type: 'string', description: 'Alasan memilih pool dan strategi ini' },
      },
      required: ['pool_address', 'token_x_amount', 'token_y_amount', 'reasoning'],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────

async function executeTool(name, input) {
  const cfg = getConfig();

  switch (name) {

    case 'screen_pools': {
      const limit = input.limit || 10;
      const pools = await getTopPools(limit * 3); // fetch lebih banyak, filter setelahnya
      const thresholds = getThresholds();
      const weights = cfg.signalWeights || { mcap: 2.5, feeActiveTvlRatio: 2.3, volume: 0.36, holderCount: 0.3 };

      const filtered = pools
        .filter(p => {
          const tvl = parseTvl(p.tvlStr || p.tvl || 0);
          const fees = p.fees24hRaw || 0;
          const feeRatio = tvl > 0 ? fees / tvl : 0;
          const binStep = p.binStep || 0;

          return (
            binStep > 0 &&
            binStep <= 250 &&                                    // Batas bin step
            tvl >= thresholds.minTvl &&
            tvl <= thresholds.maxTvl &&
            feeRatio >= thresholds.minFeeActiveTvlRatio
          );
        })
        .map(p => ({
          ...p,
          darwinScore:     calculateDarwinScore(p, weights),
          feeToTvlRatio:   (() => {
            const tvl = parseTvl(p.tvlStr || p.tvl || 0);
            return tvl > 0 ? ((p.fees24hRaw || 0) / tvl).toFixed(4) : '0';
          })(),
        }))
        .sort((a, b) => b.darwinScore - a.darwinScore)
        .slice(0, limit);

      lastCandidates = filtered;
      return JSON.stringify({
        thresholds,
        filterCriteria: { maxBinStep: 250, minFeeActiveTvlRatio: thresholds.minFeeActiveTvlRatio },
        darwinWeights: weights,
        note: 'Sorted by darwinScore. Prioritaskan mcap proxy (TVL) dan fee/TVL — volume & holders adalah weak signals.',
        candidates: filtered,
      }, null, 2);
    }

    case 'get_pool_detail': {
      const info = await getPoolInfo(input.pool_address);
      let strategyMatch = null;
      try {
        const snapshot = await getMarketSnapshot(info.tokenX, input.pool_address);
        strategyMatch = matchStrategyToMarket(snapshot);
      } catch { /* optional */ }

      return JSON.stringify({
        poolInfo: info,
        strategyRecommendation: strategyMatch ? {
          recommended: strategyMatch.recommended?.name,
          confidence: strategyMatch.recommended?.matchScore,
          entryConditions: strategyMatch.recommended?.entryConditions,
          alternatives: strategyMatch.alternatives?.map(s => s.name),
          currentMarketConditions: strategyMatch.currentConditions,
        } : null,
      }, null, 2);
    }

    case 'screen_token': {
      const result = await screenToken(
        input.token_mint,
        input.token_name || '',
        input.token_symbol || ''
      );
      if (result.verdict === 'AVOID' && hunterNotifyFn) {
        await hunterNotifyFn(`🚫 *Token Diblokir Scam Screener*\n\n${formatScreenResult(result)}`);
      }
      return JSON.stringify({
        verdict:       result.verdict,
        safe:          result.safe,
        rugScore:      result.rugScore,
        lpLockedPct:   result.lpLockedPct,
        highFlags:     result.highFlags.map(f => f.msg),
        mediumFlags:   result.mediumFlags.map(f => f.msg),
        sources:       result.sources,
        gmgnMissing:   !result.sources.gmgn,
        jupiterStrict: result.jupiterData?.isStrict  || false,
        jupiterVerified: result.jupiterData?.isVerified || false,
        jupiterPrice:  result.jupiterData?.priceUsd  || null,
        recommendation: result.verdict === 'AVOID'   ? 'JANGAN DEPLOY'
          : result.verdict === 'RISKY'               ? 'SEBAIKNYA SKIP'
          : result.verdict === 'CAUTION'             ? 'BOLEH TAPI MONITOR KETAT'
          : 'AMAN — lanjut deploy',
      }, null, 2);
    }

    case 'get_wallet_status': {
      const balance = await getWalletBalance();
      const openPos = getOpenPositions();
      return JSON.stringify({
        solBalance: balance,
        openPositions: openPos.length,
        maxPositions: cfg.maxPositions,
        canOpen: parseFloat(balance) >= cfg.minSolToOpen && openPos.length < cfg.maxPositions,
      }, null, 2);
    }

    case 'deploy_position': {
      // Safety: max drawdown check
      const drawdown = checkMaxDrawdown();
      if (drawdown.triggered) {
        return JSON.stringify({ blocked: true, reason: drawdown.reason }, null, 2);
      }

      // Resolve strategy
      const allStrategies = getAllStrategies();
      const strategy = allStrategies.find(s => s.name === input.strategy_name) || allStrategies[0];
      const stratParams = strategy ? parseStrategyParameters(strategy) : { priceRangePercent: 5 };
      const strategyType = strategy?.strategy_type || 'spot';

      // Validate strategy vs market
      let validation = { valid: true, warning: null };
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        validation = validateStrategyForMarket(strategyType, poolInfo);
        if (!validation.valid && hunterNotifyFn) {
          await hunterNotifyFn(`⚠️ *Strategy Warning*\n\n${validation.warning}`);
        }
      } catch { /* skip */ }

      // DRY RUN
      if (isDryRun()) {
        return JSON.stringify({
          dryRun: true,
          message: `[DRY RUN] Akan deploy ke pool ${input.pool_address.slice(0,8)}... dengan strategi "${strategy?.name || 'default'}"`,
          strategyValidation: validation,
          reasoning: input.reasoning,
        }, null, 2);
      }

      // Konfirmasi Telegram
      if (cfg.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
        const confirmed = await requestConfirmation(
          hunterNotifyFn,
          hunterBotRef,
          hunterAllowedId,
          `🚀 *Hunter Alpha ingin deploy:*\n\n` +
          `📍 Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
          `📊 Strategi: ${strategy?.name || 'default'}\n` +
          `💰 X: ${input.token_x_amount} | Y: ${input.token_y_amount}\n\n` +
          `💭 ${input.reasoning}`
        );
        if (!confirmed) {
          return JSON.stringify({ blocked: true, reason: 'Ditolak oleh user.' }, null, 2);
        }
      }

      // Execute
      const result = await openPosition(
        input.pool_address,
        input.token_x_amount,
        input.token_y_amount,
        stratParams.priceRangePercent || 5
      );

      // Notifikasi posisi terbuka dengan detail PnL awal
      if (hunterNotifyFn && result.success) {
        const cfg2 = getConfig();
        const tpTarget  = cfg2.takeProfitFeePct   ?? 5;
        const slTarget  = cfg2.stopLossPct        ?? 5;
        const trailAct  = 3.0; // trailing TP activate threshold

        const openMsg =
          `🚀 *Posisi Dibuka*\n\n` +
          `📍 \`${result.positionAddress.slice(0, 8)}...\`\n` +
          `🏊 Pool: \`${input.pool_address.slice(0, 8)}...\`\n` +
          `📊 Strategi: ${strategy?.name || 'default'}\n\n` +
          `💰 *Deploy:*\n` +
          `  ${result.tokenXSymbol}: ${result.tokenXAmount}\n` +
          `  ${result.tokenYSymbol}: ${result.tokenYAmount}\n\n` +
          `📈 *Range:*\n` +
          `  Entry: ${result.entryPrice?.toFixed(8)}\n` +
          `  Bawah: ${result.lowerPrice?.toFixed(8)} (-${result.priceRangePct}%)\n` +
          `  Atas:  ${result.upperPrice?.toFixed(8)} (+${result.priceRangePct}%)\n` +
          `  Fee/bin: ${result.feeRatePct}%\n\n` +
          `🎯 *Target:*\n` +
          `  TP: +${tpTarget}% | Trailing: aktif di +${trailAct}%\n` +
          `  SL: -${slTarget}%\n\n` +
          `💭 _${input.reasoning}_\n\n` +
          `🔗 [Tx](https://solscan.io/tx/${result.txHash})`;

        await hunterNotifyFn(openMsg);
      }

      return JSON.stringify({ ...result, strategyUsed: strategy?.name, reasoning: input.reasoning }, null, 2);
    }

    default:
      return `Tool tidak dikenali: ${name}`;
  }
}

// ─── Main agent loop ─────────────────────────────────────────────

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null) {
  hunterNotifyFn = notifyFn;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;

  const cfg = getConfig();

  // ── Skip silently jika slot posisi penuh ─────────────────────
  const { getOpenPositions } = await import('../db/database.js');
  const openPos = getOpenPositions();
  if (openPos.length >= cfg.maxPositions) return null;

  // ── Skip silently jika balance tidak cukup ───────────────────
  try {
    const { getWalletBalance } = await import('../solana/wallet.js');
    const balance = await getWalletBalance();
    if (parseFloat(balance) < cfg.minSolToOpen) return null;
  } catch { /* lanjut jika gagal cek balance */ }
  const lessonsCtx = getLessonsContext();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();
  const libraryStats = getLibraryStats();

  const systemPrompt = `Kamu adalah Hunter Alpha — autonomous pool screening & deployment agent untuk Meteora DLMM.

ALUR KERJA SETIAP SIKLUS:
1. screen_pools → dapatkan kandidat pool terbaik
2. get_wallet_status → cek apakah bisa buka posisi baru (jika sudah penuh atau balance kurang, HENTIKAN siklus tanpa deploy)
3. Untuk setiap kandidat menarik:
   a. get_pool_detail → info market + rekomendasi strategi
   b. screen_token → WAJIB, cek scam/rug
   c. Kalau verdict AVOID/RISKY → skip, cari kandidat lain
   d. Kalau verdict CAUTION/PASS → lanjut ke deploy
4. deploy_position → gunakan strategi yang direkomendasikan

DARWINIAN SIGNAL WEIGHTING (dari 263 closed positions — gunakan ini untuk ranking kandidat):
- mcap proxy (TVL): 2.5x — STRONG PREDICTOR. Prioritaskan pool dengan TVL > $50K
- fee/TVL ratio: 2.3x — STRONG PREDICTOR. Fee tinggi relatif ke TVL = pool aktif = kemungkinan profit tinggi
- volume 24h: 0.36x — WEAK SIGNAL. Hampir tidak prediktif, jangan terlalu dipertimbangkan
- holder count: 0.3x — USELESS. Tidak prediktif sama sekali, abaikan sebagai faktor utama

Kandidat sudah di-sort by darwinScore. Fokus pada score tinggi. Pool dengan TVL besar + fee/TVL ratio tinggi = target utama.

ATURAN SCREENING TOKEN (wajib diikuti):
- Coin politik (Trump/Elon/Baron/Melania) → SKIP selalu
- Coin celebrity → SKIP selalu
- "Justice for / Save / RIP" coins → SKIP selalu
- CTO coins → SKIP
- Vampire coins → SKIP selalu
- LP tidak locked > 80% → SKIP
- Top 10 holders > 30% → SKIP
- Dev holding > 1% → hati-hati, > 5% → SKIP
- Insiders > 0% → hati-hati

STRATEGY LIBRARY (${libraryStats.totalStrategies} strategi aktif):
${libraryStats.topStrategies.map(s => `- ${s.name} (${s.type}, ${(s.confidence * 100).toFixed(0)}% confidence)`).join('\n')}

Mode: ${isDryRun() ? '🧪 DRY RUN (tidak ada transaksi nyata)' : '🔴 LIVE'}
${lessonsCtx}
${instincts}
${strategyIntel}

Gunakan Bahasa Indonesia. Reasoning out loud untuk setiap keputusan.`;

  const messages = [
    { role: 'user', content: 'Jalankan siklus screening sekarang.' }
  ];

  let response = await createMessage({
    model: resolveModel(cfg.screeningModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools: HUNTER_TOOLS,
    messages,
  });

  while (response.stop_reason === 'tool_use') {
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

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };

  if (notifyFn) await notifyFn(`🦅 *Hunter Alpha Report*\n\n${report}`);
  return report;
}
