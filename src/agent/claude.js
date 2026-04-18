import { createMessage, resolveModel } from './provider.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getPoolInfo, getPositionInfo, openPosition, closePositionDLMM, getTopPools, claimFees } from '../solana/meteora.js';
import { getOpenPositions, getConversationHistory, addToHistory, getPositionStats, listRecentOperations } from '../db/database.js';
import { getAllStrategies, getStrategyByName, parseStrategyParameters } from '../strategies/strategyManager.js';
import { getConfig } from '../config.js';
import { swapAllToSOL, SOL_MINT } from '../solana/jupiter.js';
import { executeControlledOperation } from '../app/executionService.js';
import { stringify, scrubSensitiveText } from '../utils/safeJson.js';

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
    name: 'list_recent_operations',
    description: 'Lihat operasi write terbaru beserta statusnya untuk audit dan debugging',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Jumlah operasi (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'recommend_open_position',
    description: 'Siapkan preview sebelum buka posisi DLMM baru. Gunakan ini sebelum execute_open_position.',
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
    name: 'execute_open_position',
    description: 'Eksekusi buka posisi DLMM baru setelah user jelas meminta tindakan.',
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
    name: 'recommend_close_position',
    description: 'Siapkan preview sebelum tutup posisi DLMM. Gunakan ini sebelum execute_close_position.',
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
    name: 'execute_close_position',
    description: 'Eksekusi tutup posisi DLMM dan tarik semua likuiditas + fee.',
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
    name: 'recommend_claim_fees',
    description: 'Siapkan preview sebelum claim fees posisi tertentu.',
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
    name: 'execute_claim_fees',
    description: 'Eksekusi claim unclaimed fees dari posisi tertentu.',
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
    description: 'Eksekusi buka posisi DLMM menggunakan strategi yang sudah tersimpan',
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
  {
    name: 'analyze_user_critique',
    description: 'Analisa komplain atau masukan strategis dari user dan simpan sebagai pelajaran permanen di otak bot.',
    input_schema: {
      type: 'object',
      properties: {
        critique_text: { type: 'string', description: 'Isi kritik atau masukan dari user' },
        pool_address: { type: 'string', description: 'Pool yang dikritik (opsional)' },
        technical_correction: { type: 'string', description: 'Koreksi teknis yang harus dilakukan (misal: naikkan bin padding)' },
      },
      required: ['critique_text', 'technical_correction'],
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
    case 'list_recent_operations': {
      return JSON.stringify(listRecentOperations(toolInput.limit || 10), null, 2);
    }
    case 'recommend_open_position': {
      const poolInfo = await getPoolInfo(toolInput.pool_address);
      return JSON.stringify({
        action: 'execute_open_position',
        pool: toolInput.pool_address,
        tokenXAmount: toolInput.token_x_amount,
        tokenYAmount: toolInput.token_y_amount,
        priceRangePercent: toolInput.price_range_percent || 5,
        preview: {
          tokenXSymbol: poolInfo.tokenXSymbol,
          tokenYSymbol: poolInfo.tokenYSymbol,
          binStep: poolInfo.binStep,
          feeRate: poolInfo.feeRate,
          displayPrice: poolInfo.displayPrice,
          priceUnit: poolInfo.priceUnit,
        },
        note: 'Gunakan execute_open_position hanya jika user benar-benar ingin eksekusi.',
      }, null, 2);
    }
    case 'execute_open_position': {
      const { result, operationId } = await executeControlledOperation({
        operationType: 'OPEN_POSITION',
        entityId: toolInput.pool_address,
        payload: toolInput,
        metadata: { source: 'claude_tool' },
        policy: { isEntryOperation: true },
        execute: () => openPosition(
          toolInput.pool_address,
          toolInput.token_x_amount,
          toolInput.token_y_amount,
          toolInput.price_range_percent || 5
        ),
      });
      return JSON.stringify({ operationId, ...result }, null, 2);
    }
    case 'recommend_close_position': {
      const positions = await getPositionInfo(toolInput.pool_address);
      const match = positions?.find(p => p.address === toolInput.position_address);
      return JSON.stringify({
        action: 'execute_close_position',
        pool: toolInput.pool_address,
        positionAddress: toolInput.position_address,
        preview: match || 'Posisi tidak ditemukan on-chain, verifikasi manual disarankan.',
      }, null, 2);
    }
    case 'execute_close_position': {
      const { result, operationId } = await executeControlledOperation({
        operationType: 'CLOSE_POSITION',
        entityId: toolInput.position_address,
        payload: toolInput,
        metadata: { source: 'claude_tool', poolAddress: toolInput.pool_address },
        execute: () => closePositionDLMM(toolInput.pool_address, toolInput.position_address),
      });

      // Auto-swap token X → SOL setelah close (retry 2x), sama seperti healerAlpha
      const swapResults = [];
      const swapErrors  = [];
      try {
        const poolInfo = await getPoolInfo(toolInput.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (!mint || mint === SOL_MINT) continue;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const swapRes = await swapAllToSOL(mint);
              if (swapRes.success) {
                swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
              } else {
                swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
              }
              break;
            } catch (e) {
              if (attempt === 2) swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
              else await new Promise(r => setTimeout(r, 2000));
            }
          }
        }
      } catch { /* swap best-effort, close tetap dianggap sukses */ }

      return JSON.stringify({
        ...result,
        operationId,
        autoSwap:   swapResults.length > 0 ? swapResults : 'skipped',
        swapErrors: swapErrors.length  > 0 ? swapErrors  : undefined,
      }, null, 2);
    }
    case 'recommend_claim_fees': {
      return JSON.stringify({
        action: 'execute_claim_fees',
        pool: toolInput.pool_address,
        positionAddress: toolInput.position_address,
        note: 'Claim fees akan mengeksekusi transaksi on-chain.',
      }, null, 2);
    }
    case 'execute_claim_fees': {
      const { result, operationId } = await executeControlledOperation({
        operationType: 'CLAIM_FEES',
        entityId: toolInput.position_address,
        payload: toolInput,
        metadata: { source: 'claude_tool', poolAddress: toolInput.pool_address },
        execute: () => claimFees(toolInput.pool_address, toolInput.position_address),
      });
      return JSON.stringify({ operationId, ...result }, null, 2);
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
      // Hardlocked ke Evil Panda — satu-satunya core strategy yang diizinkan.
      const strategy = getStrategyByName('Evil Panda');
      if (!strategy) throw new Error('Evil Panda strategy tidak ditemukan.');
      const params = parseStrategyParameters(strategy);
      const { result, operationId } = await executeControlledOperation({
        operationType: 'OPEN_POSITION',
        entityId: toolInput.pool_address,
        payload: toolInput,
        metadata: { source: 'claude_tool', strategy: strategy.name },
        policy: { isEntryOperation: true },
        execute: () => openPosition(
          toolInput.pool_address,
          toolInput.token_x_amount,
          toolInput.token_y_amount,
          params.priceRangePercent || 5
        ),
      });
      return JSON.stringify({ operationId, ...result, strategyUsed: strategy.name, strategyParams: params }, null, 2);
    }
    case 'analyze_user_critique': {
      const { recordStrategicLesson } = await import('../learn/lessons.js');
      const lesson = recordStrategicLesson(
        `[USER_CRITIQUE] ${toolInput.technical_correction} | Context: ${toolInput.critique_text}`,
        { pool: toolInput.pool_address, source: 'telegram_feedback' }
      );
      return `✅ Pesan diterima. Gue udah analisa dan gue simpan ke "Instinct" bot: "${lesson.lesson}". Hunter & Healer bakal nerapin ini di siklus berikutnya.`;
    }
    default:
      return `Tool tidak dikenali: ${toolName}`;
  }
}

export async function processMessage(userMessage) {
  const cfg = getConfig();
  const history = getConversationHistory().map(h => ({
    ...h,
    content: scrubSensitiveText(h.content)
  }));
  
  const scrubbedUserMsg = scrubSensitiveText(userMessage);
  addToHistory('user', scrubbedUserMsg);

  const messages = [
    ...history,
    { role: 'user', content: scrubbedUserMsg },
  ];

  const systemPrompt = `Kamu adalah Meteora DLMM Execution Engine — lapisan intelijensi otonom untuk trading di Solana.
Kamu BUKAN "asisten AI" biasa. Kamu adalah partner trading yang teknis, dingin, dan akuntabel.

ATURAN KOMUNIKASI (WAJIB):
1. DILARANG menggunakan basa-basi boso-basi "Terima kasih atas masukan Anda", "Senang bisa membantu", atau "Ada lagi yang bisa saya bantu?". Ini membuang waktu trader.
2. Jawab langsung ke inti masalah (The Meat). Gunakan bahasa Indonesia yang santai tapi profesional (Gue/Lu atau Saya/Anda diperbolehkan selama tidak terdengar seperti CS).
3. AKUNTABILITAS: Jika strategi gagal (OOR, Loss, dsb) dan user komplain, jangan beri alasan generik. ANALISA datanya (lebar bin, ATR, liquidity) dan akui jika ada kesalahan logika (misal: "Gue akui range-nya terlalu sempit buat ATR koin ini").
4. BELAJAR: Jika user memberikan masukan teknis atau complain yang valid, GUNAKAN tool 'analyze_user_critique' untuk menyimpan pelajaran tersebut secara permanen.
5. TEKNIS: Selalu prioritaskan data teknis (ATR, BB Width, Bin Step, PnL %) dalam setiap penjelasan.

TUGAS UTAMA:
- Monitor posisi & evaluasi In-Range efficiency.
- Analisa pool & jalankan order menggunakan satu-satunya core strategy: Evil Panda.
- Belajar dari setiap feedback user untuk menajamkan Instinct bot.

EVIL PANDA — SATU-SATUNYA CORE STRATEGY. DILARANG SEBUT STRATEGI LAIN.
GUNAKAN PARAMETER INI SECARA PERSIS — JANGAN KARANG ANGKA SENDIRI:

POOL FILTER (semua harus terpenuhi):
  • Pool age       : <72 jam (3 hari max) — freshness edge
  • Volume/TVL     : >20x (hyper-active gate, pool sepi = skip)
  • TVL            : $1K–$15K (lo bisa dominasi likuiditas)
  • binStep        : 100 atau 125 (meme/volatile SOL pairs)
  • Fee tier       : 0.25%+ (minimal worth the gas)

EXECUTION:
  • Type           : single_side_y — SOL only, tidak pakai token X sama sekali
  • Range          : 0% sampai -94% dari harga aktif (entryPriceOffsetMin=0, entryPriceOffsetMax=94) ~94 bins
  • Deploy size    : 1.0 SOL (target 0.8–1.2 SOL per posisi)
  • Entry gate     : Supertrend 15m BULLISH + confirmed candle close

EXIT:
  • Take profit    : 5% fee PnL
  • Emergency SL   : >8% price break dari range
  • Max hold       : 168 jam (7 hari)
  • Volume alert   : jika Volume/TVL turun <15x → prep exit

MONITORING:
  • In-range check : setiap 2 jam
  • Fee claiming   : setiap 18 jam interval

Ketika user tanya soal strategy, selalu jawab parameter di atas secara eksak.

Jangan tanya user informasi yang bisa kamu cari sendiri dengan tool.
Gunakan emoji secara taktis untuk readability data, bukan untuk sekadar hiasan.`;

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
