import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, savePosition } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';


let lastCandidates = [];
let lastReport = null;

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
      return JSON.stringify(info, null, 2);
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
      if (isDryRun()) {
        return JSON.stringify({
          dryRun: true,
          message: `[DRY RUN] Akan deploy ke pool ${input.pool_address} dengan strategi "${input.strategy_name || 'default'}"`,
          reasoning: input.reasoning,
          wouldDeploy: { tokenX: input.token_x_amount, tokenY: input.token_y_amount },
        }, null, 2);
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

export async function runHunterAlpha(notifyFn) {
  const cfg = getConfig();
  const lessonsCtx = getLessonsContext();

  const systemPrompt = `Kamu adalah Hunter Alpha — autonomous pool screening agent untuk Meteora DLMM.

Tugasmu setiap siklus:
1. Screen pool terbaik menggunakan tool screen_pools
2. Evaluasi wallet status — apakah bisa buka posisi baru
3. Jika ada kandidat bagus DAN wallet cukup DAN belum maxPositions, deploy ke pool terbaik
4. Jika tidak ada kondisi yang tepat, jelaskan kenapa tidak deploy
5. Selalu reasoning out loud sebelum ambil keputusan

Mode saat ini: ${isDryRun() ? '🧪 DRY RUN (simulasi, tidak ada transaksi nyata)' : '🔴 LIVE (transaksi nyata)'}
${lessonsCtx}

Selalu gunakan Bahasa Indonesia. Format output dengan emoji untuk readability.`;

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
