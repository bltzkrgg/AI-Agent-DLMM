import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnl, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';


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
  {
    name: 'analyze_market',
    description: 'Analisa kondisi market untuk token tertentu — price action, volume, on-chain signals, sentiment. Gunakan ini SEBELUM memutuskan HOLD atau CLOSE saat posisi rugi.',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string', description: 'Mint address token X dari posisi' },
        pool_address: { type: 'string', description: 'Alamat pool' },
        current_pnl_pct: { type: 'number', description: 'PnL posisi saat ini dalam persen' },
        in_range: { type: 'boolean', description: 'Apakah posisi in range?' },
      },
      required: ['token_mint', 'pool_address'],
    },
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
          // pnlPct = actual profit/loss on principal (from Meteora PnL API)
          // feePctOfDeployed = fees earned (separate from pnl)
          const pnlPct = match?.pnlPct ?? 0;
          const feeUsdVal = match?.feeUsd ?? 0;
          const isProfit = pnlPct > 0;

          // ── Proactive Market Analysis ──────────────────────────
          // Jalankan untuk SEMUA posisi, bukan hanya yang rugi
          let marketSignal = null;
          let proactiveCloseRecommended = false;
          let proactiveWarning = null;

          try {
            const analysis = await analyzeMarket(
              pos.token_x,      // mint address token X
              pos.pool_address,
              { inRange: match?.inRange, pnlPct }
            );

            marketSignal = {
              signal: analysis.signal,
              confidence: analysis.confidence,
              thesis: analysis.thesis,
              holdRecommendation: analysis.holdRecommendation,
            };

            // Kalau lagi profit tapi chart bearish confidence > threshold → rekomendasikan close
            const minProfit = cfg.proactiveExitMinProfitPct ?? 1.0;
            const bearishThreshold = cfg.proactiveExitBearishConfidence ?? 0.7;
            const proactiveEnabled = cfg.proactiveExitEnabled !== false;

            if (proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= bearishThreshold) {
              proactiveCloseRecommended = true;
              proactiveWarning = `⚠️ Profit ${pnlPct.toFixed(2)}% tapi market BEARISH (${(analysis.confidence * 100).toFixed(0)}% confidence). Rekomendasikan close untuk lock profit.`;
            }

            // Warning zone: bearish tapi confidence 50-threshold
            if (proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= 0.5 && analysis.confidence < bearishThreshold) {
              proactiveWarning = `👀 Profit ${pnlPct.toFixed(2)}% — market mulai bearish (${(analysis.confidence * 100).toFixed(0)}% confidence). Monitor lebih ketat.`;
            }
          } catch {
            // Market analysis optional, tidak crash kalau gagal
          }

          return {
            ...pos,
            onChain: match || null,
            outOfRangeMins,
            shouldClaimFee: (match?.feeUsd || 0) >= minClaimUsd,
            shouldClose: outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes,
            takeProfitHit: pnlPct >= thresholds.takeProfitFeePct,
            pnlPct,
            isProfit,
            marketSignal,
            proactiveCloseRecommended,
            proactiveWarning,
          };
        } catch (e) {
          return { ...pos, error: e.message };
        }
      }));

      // Kirim warning untuk posisi yang perlu perhatian
      const warnings = enriched.filter(p => p.proactiveWarning);
      for (const pos of warnings) {
        saveNotification('proactive_warning', pos.proactiveWarning);
      }

      return JSON.stringify({
        positions: enriched,
        thresholds,
        proactiveCloseNeeded: enriched.filter(p => p.proactiveCloseRecommended).length,
      }, null, 2);
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

    case 'analyze_market': {
      const analysis = await analyzeMarket(
        input.token_mint,
        input.pool_address,
        {
          inRange: input.in_range,
          pnlPct: input.current_pnl_pct,
        }
      );
      return JSON.stringify({
        signal: analysis.signal,
        confidence: analysis.confidence,
        holdRecommendation: analysis.holdRecommendation,
        thesis: analysis.thesis,
        reasoning: analysis.reasoning,
        keyRisks: analysis.keyRisks,
        keyOpportunities: analysis.keyOpportunities,
        priceTarget: analysis.priceTarget,
        timeHorizon: analysis.timeHorizon,
      }, null, 2);
    }

    default:
      return 'Tool tidak dikenali';
  }
}

export async function runHealerAlpha(notifyFn) {
  const cfg = getConfig();
  const lessonsCtx = getLessonsContext();
  const thresholds = getThresholds();

  // ── Safety Check: Max Drawdown ──────────────────────────────
  const drawdown = checkMaxDrawdown();
  if (drawdown.triggered) {
    const msg = `⛔ *Healer Alpha FROZEN*\n\n${drawdown.reason}\n\nBot tidak akan membuka posisi baru hari ini. Posisi yang ada tetap dimonitor.`;
    if (notifyFn) await notifyFn(msg);
    return msg;
  }

  // ── Safety Check: Stop-Loss per posisi (pre-flight) ─────────
  const openPositions = getOpenPositions();
  for (const pos of openPositions) {
    try {
      const onChain = await getPositionInfo(pos.pool_address);
      const match = onChain?.find(p => p.address === pos.position_address);
      if (!match) continue;

      const slCheck = checkStopLoss(match);
      if (slCheck.triggered && !isDryRun()) {
        await notifyFn?.(`🛑 *Stop-Loss Triggered*\n\n📍 Posisi: \`${pos.position_address.slice(0,8)}...\`\n${slCheck.reason}\n\nMenutup posisi...`);
        try {
          await closePositionDLMM(pos.pool_address, pos.position_address);
          recordPnl(match.pnlUsd || 0);
          await notifyFn?.(`✅ Posisi berhasil ditutup via stop-loss.`);
        } catch (e) {
          await notifyFn?.(`❌ Gagal close stop-loss: ${e.message}`);
        }
      } else if (slCheck.triggered && isDryRun()) {
        await notifyFn?.(`🧪 [DRY RUN] Stop-loss akan triggered: ${slCheck.reason}`);
      }
    } catch { /* skip jika gagal fetch */ }
  }

  const safety = getSafetyStatus();
  const instincts = getInstinctsContext();
  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

Tugasmu setiap siklus:
1. Ambil semua posisi dengan get_all_positions (sudah include market analysis otomatis)
2. Untuk setiap posisi, baca field-field ini dan ambil keputusan:

   TAKE PROFIT:
   - takeProfitHit = true → CLOSE (lock profit)

   PROACTIVE EXIT (profit tapi bearish):
   - proactiveCloseRecommended = true → WAJIB CLOSE untuk lock profit sebelum turun
   - proactiveWarning ada tapi proactiveCloseRecommended = false → monitor, belum perlu close

   STOP LOSS (posisi rugi):
   - pnlPct < -${safety.stopLossPct}% DAN marketSignal.signal = BEARISH → CLOSE
   - pnlPct < -${safety.stopLossPct}% DAN marketSignal.signal = BULLISH confidence > 0.6 → HOLD, tunggu recovery

   OUT OF RANGE:
   - shouldClose = true DAN marketSignal.signal = BEARISH → CLOSE
   - shouldClose = true DAN marketSignal.signal = BULLISH → HOLD sebentar lagi

   NORMAL:
   - shouldClaimFee = true → CLAIM_FEES
   - Semua aman → STAY

3. Berikan reasoning lengkap untuk setiap keputusan, terutama kalau HOLD meski rugi.

Safety hari ini: Daily PnL $${safety.dailyPnlUsd} | Drawdown ${safety.drawdownPct}%
Mode: ${isDryRun() ? '🧪 DRY RUN' : '🔴 LIVE'}

${lessonsCtx}
${instincts}

Gunakan Bahasa Indonesia. Selalu explain kenapa HOLD atau CLOSE.`;

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
