import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, savePosition } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';
import { checkMaxDrawdown, validateStrategyForMarket, requestConfirmation, getSafetyStatus } from '../safety/safetyManager.js';
import { matchStrategyToMarket, getLibraryStats } from '../market/strategyLibrary.js';
import { getMarketSnapshot } from '../market/oracle.js';
import { getInstinctsContext } from '../market/memory.js';


let lastCandidates = [];
let lastReport = null;
let hunterNotifyFn = null;
let hunterBotRef = null;
let hunterAllowedId = null;

export function getCandidates() { return lastCandidates; }
export function getLastHunterReport() { return lastReport; }

const HUNTER_TOOLS = [
  {
    name: 'screen_pools',
    description: 'Screen pool Meteora DLMM terbaik berdasarkan threshold yang dikonfigurasi',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Jumlah kandidat yang diambil (default 10)' },
        category: { type: 'string', description: 'Kategori pool: trending, new, stable' },
      },
      required: [],
    },
  },
  {
    name: 'get_pool_detail',
    description: 'Ambil detail lengkap pool tertentu sebelum deploy',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'get_wallet_status',
    description: 'Cek balance wallet dan jumlah posisi terbuka saat ini',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'deploy_position',
    description: 'Deploy likuiditas ke pool terpilih menggunakan strategi terbaik',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari daftar strategi tersedia' },
        token_x_amount: { type: 'number' },
        token_y_amount: { type: 'number' },
        reasoning: { type: 'string', description: 'Alasan memilih pool dan strategi ini' },
      },
      required: ['pool_address', 'token_x_amount', 'token_y_amount', 'reasoning'],
    },
  },
];

async function executeTool(name, input) {
  const cfg = getConfig();

  switch (name) {
    case 'screen_pools': {
      const pools = await getTopPools(input.limit || 10);
      const thresholds = getThresholds();

      // Filter berdasarkan threshold
      const filtered = pools.filter(p => {
        const tvl = parseFloat(p.tvl?.replace(/[$M]/g, '') || 0) * 1e6;
        return tvl >= thresholds.minTvl && tvl <= thresholds.maxTvl;
      });

      lastCandidates = filtered;
      return JSON.stringify({ thresholds, candidates: filtered }, null, 2);
    }

    case 'get_pool_detail': {
      const info = await getPoolInfo(input.pool_address);

      // Get market snapshot and match strategy
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
          reason: strategyMatch.recommended?.entryConditions,
          alternatives: strategyMatch.alternatives?.map(s => s.name),
          currentMarketConditions: strategyMatch.currentConditions,
        } : null,
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
      // ── Safety: Drawdown check ──────────────────────────────
      const drawdown = checkMaxDrawdown();
      if (drawdown.triggered) {
        return JSON.stringify({ blocked: true, reason: drawdown.reason }, null, 2);
      }

      // ── Safety: Validasi strategi vs market ─────────────────
      let strategyType = 'spot';
      let stratParams = { priceRangePercent: 5 };
      const strategies = getAllStrategies();
      const strategy = strategies.find(s => s.name === input.strategy_name) || strategies[0];
      if (strategy) {
        strategyType = strategy.strategy_type;
        stratParams = parseStrategyParameters(strategy);
      }

      // Ambil pool info untuk validasi
      let validation = { valid: true, warning: null, recommendation: strategyType };
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        validation = validateStrategyForMarket(strategyType, poolInfo);
      } catch { /* skip validasi jika gagal fetch */ }

      if (!validation.valid) {
        const warningMsg = `${validation.warning}\n\n💡 Rekomendasi: gunakan strategi tipe \`${validation.recommendation}\``;
        if (isDryRun()) {
          return JSON.stringify({
            dryRun: true,
            strategyWarning: warningMsg,
            message: `[DRY RUN] Deploy dicegah oleh validasi strategi`,
            reasoning: input.reasoning,
          }, null, 2);
        }
        // Di live mode, lanjut tapi dengan warning di notifikasi
        if (hunterNotifyFn) await hunterNotifyFn(`⚠️ *Strategy Validation Warning*\n\n${warningMsg}`);
      }

      if (isDryRun()) {
        return JSON.stringify({
          dryRun: true,
          message: `[DRY RUN] Akan deploy ke pool ${input.pool_address} dengan strategi "${strategy?.name || 'default'}"`,
          strategyValidation: validation,
          reasoning: input.reasoning,
          wouldDeploy: { tokenX: input.token_x_amount, tokenY: input.token_y_amount },
        }, null, 2);
      }

      // ── Safety: Konfirmasi Telegram ─────────────────────────
      const cfg2 = getConfig();
      if (cfg2.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
        const confirmMsg =
          `🚀 *Hunter Alpha ingin deploy posisi baru:*\n\n` +
          `📍 Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
          `📊 Strategi: ${strategy?.name || 'default'}\n` +
          `💰 Token X: ${input.token_x_amount} | Token Y: ${input.token_y_amount}\n\n` +
          `💭 Reasoning: ${input.reasoning}`;

        const confirmed = await requestConfirmation(
          hunterNotifyFn, hunterBotRef, hunterAllowedId, confirmMsg
        );

        if (!confirmed) {
          return JSON.stringify({ blocked: true, reason: 'Ditolak oleh user via Telegram.' }, null, 2);
        }
      }

      const strategies = getAllStrategies();
      const strategy = strategies.find(s => s.name === input.strategy_name) || strategies[0];
      const params = strategy ? parseStrategyParameters(strategy) : { priceRangePercent: 5 };

      const result = await openPosition(
        input.pool_address,
        input.token_x_amount,
        input.token_y_amount,
        params.priceRangePercent || 5
      );

      return JSON.stringify({ ...result, reasoning: input.reasoning, strategyUsed: strategy?.name }, null, 2);
    }

    default:
      return 'Tool tidak dikenali';
  }
}

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null) {
  hunterNotifyFn = notifyFn;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;
  const cfg = getConfig();
  const lessonsCtx = getLessonsContext();
  const instincts = getInstinctsContext();
  const libraryStats = getLibraryStats();

  const systemPrompt = `Kamu adalah Hunter Alpha — autonomous pool screening & deployment agent untuk Meteora DLMM.

Tugasmu setiap siklus:
1. Screen pool terbaik dengan screen_pools
2. Cek wallet status dengan get_wallet_status
3. Untuk setiap kandidat pool menarik, gunakan get_pool_detail — ini akan otomatis:
   - Analisa kondisi market pool tersebut
   - Merekomendasikan strategi terbaik dari Strategy Library
4. Pilih pool + strategi terbaik, lalu deploy

STRATEGY LIBRARY (${libraryStats.totalStrategies} strategi tersedia):
${libraryStats.topStrategies.map(s => `- ${s.name} (${s.type}, confidence: ${(s.confidence * 100).toFixed(0)}%)`).join('\n')}

Cara pilih strategi:
- Gunakan rekomendasi dari get_pool_detail (sudah di-match ke kondisi market)
- Kalau confidence rekomendasi > 0.6 → pakai otomatis
- Kalau confidence < 0.6 atau kondisi tidak jelas → pilih Spot Balanced sebagai default
- JANGAN gunakan single-side kalau whale risk HIGH

Mode: ${isDryRun() ? '🧪 DRY RUN' : '🔴 LIVE'}
${lessonsCtx}
${instincts}

Gunakan Bahasa Indonesia. Explain strategi apa yang dipilih dan kenapa.`;

  const messages = [
    { role: 'user', content: 'Jalankan siklus screening pool sekarang. Screen kandidat terbaik, evaluasi kondisi, dan ambil keputusan deploy jika tepat.' }
  ];

  let response = await createMessage({
    model: resolveModel(cfg.screeningModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools: HUNTER_TOOLS,
    messages,
  });

  // ReAct loop
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

  if (notifyFn) {
    await notifyFn(`🦅 *Hunter Alpha Report*\n\n${report}`);
  }

  return report;
}
