import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, updatePositionStatus, saveNotification } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';


let lastReport = null;
export function getLastHealerReport() { return lastReport; }

// Track when positions went out of range
const outOfRangeTracker = new Map(); // positionAddress -> timestamp

const HEALER_TOOLS = [
  {
    name: 'get_all_positions',
    description: 'Ambil semua posisi terbuka beserta status on-chain terkini (in/out of range, unclaimed fees, PnL)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'claim_fees',
    description: 'Klaim unclaimed fees dari posisi tertentu',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        position_address: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['pool_address', 'position_address', 'reasoning'],
    },
  },
  {
    name: 'close_position',
    description: 'Tutup posisi dan tarik semua likuiditas + fees',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
        position_address: { type: 'string' },
        reasoning: { type: 'string', description: 'Alasan menutup: TAKE_PROFIT, OUT_OF_RANGE, STOP_LOSS, REBALANCE' },
      },
      required: ['pool_address', 'position_address', 'reasoning'],
    },
  },
  {
    name: 'get_wallet_balance',
    description: 'Cek balance wallet saat ini',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

async function executeTool(name, input) {
  const cfg = getConfig();
  const thresholds = getThresholds();

  switch (name) {
    case 'get_all_positions': {
      const dbPositions = getOpenPositions();
      if (dbPositions.length === 0) return 'Tidak ada posisi terbuka saat ini.';

      const enriched = await Promise.all(dbPositions.map(async (pos) => {
        try {
          const onChain = await getPositionInfo(pos.pool_address);
          const match = onChain?.find(p => p.address === pos.position_address);

          let outOfRangeMins = null;
          if (match && !match.inRange) {
            const trackedAt = outOfRangeTracker.get(pos.position_address);
            if (!trackedAt) {
              outOfRangeTracker.set(pos.position_address, Date.now());
            } else {
              outOfRangeMins = Math.floor((Date.now() - trackedAt) / 60000);
            }
          } else {
            outOfRangeTracker.delete(pos.position_address);
          }

          const minClaimUsd = cfg.minFeeClaimUsd ?? cfg.minClaimFeeUsd ?? 1.0;

          return {
            ...pos,
            onChain: match || null,
            outOfRangeMins,
            shouldClaimFee: (match?.feeUsd || 0) >= minClaimUsd,
            shouldClose: outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes,
            takeProfitHit: (match?.feePctOfDeployed || 0) >= thresholds.takeProfitFeePct,
          };
        } catch (e) {
          return { ...pos, error: e.message };
        }
      }));

      return JSON.stringify({ positions: enriched, thresholds }, null, 2);
    }

    case 'claim_fees': {
      if (isDryRun()) {
        return JSON.stringify({
          dryRun: true,
          message: `[DRY RUN] Akan claim fees dari posisi ${input.position_address}`,
          reasoning: input.reasoning,
        }, null, 2);
      }

      const result = await claimFees(input.pool_address, input.position_address);
      return JSON.stringify({ ...result, reasoning: input.reasoning }, null, 2);
    }

    case 'close_position': {
      if (isDryRun()) {
        return JSON.stringify({
          dryRun: true,
          message: `[DRY RUN] Akan tutup posisi ${input.position_address}`,
          reasoning: input.reasoning,
        }, null, 2);
      }

      const result = await closePositionDLMM(input.pool_address, input.position_address);
      outOfRangeTracker.delete(input.position_address);
      return JSON.stringify({ ...result, reasoning: input.reasoning }, null, 2);
    }

    case 'get_wallet_balance': {
      const balance = await getWalletBalance();
      return `Balance: ${balance} SOL`;
    }

    default:
      return 'Tool tidak dikenali';
  }
}

export async function runHealerAlpha(notifyFn) {
  const cfg = getConfig();
  const lessonsCtx = getLessonsContext();
  const thresholds = getThresholds();

  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

Tugasmu setiap siklus:
1. Ambil semua posisi terbuka dengan tool get_all_positions
2. Untuk setiap posisi, evaluasi:
   - Apakah in range? Kalau out of range > ${thresholds.outOfRangeWaitMinutes} menit → CLOSE
   - Apakah unclaimed fees sudah cukup untuk di-claim?
   - Apakah take profit target (${thresholds.takeProfitFeePct}% dari modal) sudah tercapai? → CLOSE
3. Eksekusi keputusan: STAY, CLAIM_FEES, atau CLOSE
4. Berikan reasoning jelas untuk setiap keputusan

Mode saat ini: ${isDryRun() ? '🧪 DRY RUN (simulasi)' : '🔴 LIVE (transaksi nyata)'}
${lessonsCtx}

Selalu gunakan Bahasa Indonesia. Be decisive — kalau kondisi terpenuhi, langsung eksekusi.`;

  const messages = [
    { role: 'user', content: 'Jalankan siklus manajemen posisi sekarang. Evaluasi semua posisi dan ambil tindakan yang diperlukan.' }
  ];

  let response = await createMessage({
    model: resolveModel(cfg.managementModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools: HEALER_TOOLS,
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
      model: resolveModel(cfg.managementModel),
      maxTokens: 4096,
      system: systemPrompt,
      tools: HEALER_TOOLS,
      messages,
    });
  }

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };

  if (notifyFn) {
    await notifyFn(`🩺 *Healer Alpha Report*\n\n${report}`);
  }

  return report;
}
