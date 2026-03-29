import { createMessage, resolveModel } from './provider.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getPoolInfo, getPositionInfo, openPosition, closePositionDLMM, getTopPools, claimFees } from '../solana/meteora.js';
import { getOpenPositions, getConversationHistory, addToHistory, getPositionStats } from '../db/database.js';
import { getAllStrategies, getStrategyByName, parseStrategyParameters } from '../strategies/strategyManager.js';
import { getConfig } from '../config.js';

const tools = [
  {
    name: 'get_wallet_balance',
    description: 'Ambil balance SOL di wallet bot',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pool_info',
    description: 'Ambil informasi pool DLMM Meteora: harga aktif, token pair, fee rate, bin step',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string', description: 'Alamat pool Meteora' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'get_position_info',
    description: 'Cek posisi DLMM yang sedang buka di pool tertentu, termasuk status in/out of range',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string', description: 'Alamat pool Meteora' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'get_open_positions',
    description: 'Lihat semua posisi yang sedang terbuka di database lokal beserta statistik performa',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_position',
    description: 'Buka posisi DLMM baru di pool Meteora',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string', description: 'Alamat pool Meteora' },
        token_x_amount: { type: 'number', description: 'Jumlah Token X yang mau dimasukkan' },
        token_y_amount: { type: 'number', description: 'Jumlah Token Y yang mau dimasukkan' },
        price_range_percent: { type: 'number', description: 'Range harga dalam persen (default: 5)' },
      },
      required: ['pool_address', 'token_x_amount', 'token_y_amount'],
    },
  },
  {
    name: 'close_position',
    description: 'Tutup posisi DLMM dan tarik semua likuiditas + fee',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string', description: 'Alamat pool Meteora' },
        position_address: { type: 'string', description: 'Alamat posisi yang mau ditutup' },
      },
      required: ['pool_address', 'position_address'],
    },
  },
  {
    name: 'claim_fees',
    description: 'Klaim unclaimed fees dari posisi tertentu',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        position_address: { type: 'string' },
      },
      required: ['pool_address', 'position_address'],
    },
  },
  {
    name: 'get_top_pools',
    description: 'Analisa pool DLMM terbaik berdasarkan fee APR dan volume',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Jumlah pool yang ditampilkan (default: 5)' },
      },
      required: [],
    },
  },
  {
    name: 'list_strategies',
    description: 'Lihat semua strategi DLMM yang tersedia',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_position_with_strategy',
    description: 'Buka posisi DLMM menggunakan strategi yang sudah tersimpan',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari /strategies' },
        token_x_amount: { type: 'number' },
        token_y_amount: { type: 'number' },
      },
      required: ['pool_address', 'strategy_name', 'token_x_amount', 'token_y_amount'],
    },
  },
];

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'get_wallet_balance': {
      const balance = await getWalletBalance();
      return `Balance wallet: ${balance} SOL`;
    }
    case 'get_pool_info': {
      const info = await getPoolInfo(toolInput.pool_address);
      return JSON.stringify(info, null, 2);
    }
    case 'get_position_info': {
      const positions = await getPositionInfo(toolInput.pool_address);
      if (!positions || positions.length === 0) return 'Tidak ada posisi terbuka di pool ini.';
      return JSON.stringify(positions, null, 2);
    }
    case 'get_open_positions': {
      const openPos = getOpenPositions();
      const stats = getPositionStats();
      if (openPos.length === 0) return 'Tidak ada posisi terbuka saat ini.';
      return JSON.stringify({ positions: openPos, stats }, null, 2);
    }
    case 'open_position': {
      const result = await openPosition(
        toolInput.pool_address,
        toolInput.token_x_amount,
        toolInput.token_y_amount,
        toolInput.price_range_percent || 5
      );
      return JSON.stringify(result, null, 2);
    }
    case 'close_position': {
      const result = await closePositionDLMM(toolInput.pool_address, toolInput.position_address);
      return JSON.stringify(result, null, 2);
    }
    case 'claim_fees': {
      const result = await claimFees(toolInput.pool_address, toolInput.position_address);
      return JSON.stringify(result, null, 2);
    }
    case 'get_top_pools': {
      const pools = await getTopPools(toolInput.limit || 5);
      return JSON.stringify(pools, null, 2);
    }
    case 'list_strategies': {
      const strategies = getAllStrategies();
      if (strategies.length === 0) return 'Belum ada strategi tersimpan.';
      return JSON.stringify(strategies.map(s => ({
        name: s.name,
        description: s.description,
        type: s.strategy_type,
        parameters: parseStrategyParameters(s),
        hasCustomLogic: !!s.logic,
        createdBy: s.created_by,
      })), null, 2);
    }
    case 'open_position_with_strategy': {
      const strategy = getStrategyByName(toolInput.strategy_name);
      if (!strategy) throw new Error(`Strategi "${toolInput.strategy_name}" tidak ditemukan.`);
      const params = parseStrategyParameters(strategy);
      const result = await openPosition(
        toolInput.pool_address,
        toolInput.token_x_amount,
        toolInput.token_y_amount,
        params.priceRangePercent || 5
      );
      return JSON.stringify({ ...result, strategyUsed: strategy.name, strategyParams: params }, null, 2);
    }
    default:
      return `Tool tidak dikenali: ${toolName}`;
  }
}

export async function processMessage(userMessage) {
  const cfg = getConfig();
  const history = getConversationHistory();
  addToHistory('user', userMessage);

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const systemPrompt = `Kamu adalah AI trading assistant untuk Meteora DLMM di Solana.
Kamu bisa membantu user untuk:
- Monitor posisi DLMM (cek apakah in/out of range)
- Analisa pool terbaik berdasarkan APR dan volume
- Buka dan tutup posisi DLMM
- Klaim fees dari posisi
- Cek balance wallet

ATURAN WAJIB:
- Saat user minta tutup/close posisi: LANGSUNG panggil get_open_positions terlebih dahulu untuk dapat pool_address dan position_address. JANGAN pernah tanya user soal alamat — cari sendiri dari data yang ada.
- Saat user minta klaim fee: LANGSUNG panggil get_open_positions terlebih dahulu.
- Jangan tanya user informasi yang bisa kamu cari sendiri dengan tool.

Selalu gunakan bahasa Indonesia. Jelaskan setiap aksi yang kamu lakukan dengan jelas.
Kalau ada error, jelaskan dengan bahasa yang mudah dipahami.
Format angka dengan rapi dan tambahkan emoji yang relevan untuk readability.`;

  let response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });

  // Agentic loop
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
      model: resolveModel(cfg.generalModel),
      maxTokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  addToHistory('assistant', finalText);
  return finalText;
}
