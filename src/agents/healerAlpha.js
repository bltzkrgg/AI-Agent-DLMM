import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, isDryRun, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnl, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';

// ─── Trailing Take Profit Config ──────────────────────────────────
// Terinspirasi dari Meridian: aktifkan trailing setelah profit mencapai
// threshold, tutup kalau PnL turun X% dari peak.
const TRAILING_TP_ACTIVATE_PCT = 3.0;  // Aktifkan trailing saat PnL >= 3%
const TRAILING_TP_DROP_PCT     = 1.5;  // Close kalau turun 1.5% dari peak

let lastReport = null;
export function getLastHealerReport() { return lastReport; }

// Track saat posisi keluar dari range
const outOfRangeTracker = new Map(); // positionAddress → timestamp

// Track peak PnL per posisi untuk trailing take profit
const peakPnlTracker = new Map(); // positionAddress → { peakPnl, trailingActive }

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
        pool_address:     { type: 'string' },
        position_address: { type: 'string' },
        reasoning:        { type: 'string' },
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
        pool_address:     { type: 'string' },
        position_address: { type: 'string' },
        reasoning:        { type: 'string', description: 'Alasan menutup: TAKE_PROFIT, TRAILING_TP, OUT_OF_RANGE, STOP_LOSS, REBALANCE' },
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
    description: 'Analisa kondisi market untuk token tertentu. Gunakan SEBELUM memutuskan HOLD atau CLOSE saat posisi rugi.',
    input_schema: {
      type: 'object',
      properties: {
        token_mint:      { type: 'string' },
        pool_address:    { type: 'string' },
        current_pnl_pct: { type: 'number' },
        in_range:        { type: 'boolean' },
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
          const match   = onChain?.find(p => p.address === pos.position_address);

          // ── Out-of-range tracking ────────────────────────────
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

          const pnlPct   = match?.pnlPct ?? 0;
          const feeUsdVal = match?.feeUsd ?? 0;
          const isProfit  = pnlPct > 0;
          const minClaimUsd = cfg.minFeeClaimUsd ?? cfg.minClaimFeeUsd ?? 1.0;

          // ── Trailing Take Profit tracking ────────────────────
          // Terinspirasi dari Meridian: track peak PnL, aktifkan trailing
          const addr = pos.position_address;
          let tracker = peakPnlTracker.get(addr) || { peakPnl: pnlPct, trailingActive: false };

          // Update peak
          if (pnlPct > tracker.peakPnl) {
            tracker.peakPnl = pnlPct;
          }

          // Aktifkan trailing kalau sudah reach threshold
          if (!tracker.trailingActive && pnlPct >= TRAILING_TP_ACTIVATE_PCT) {
            tracker.trailingActive = true;
          }

          // Cek apakah trailing TP terpicu
          const trailingTpHit = tracker.trailingActive &&
            (tracker.peakPnl - pnlPct) >= TRAILING_TP_DROP_PCT;

          peakPnlTracker.set(addr, tracker);

          // ── Market Analysis ──────────────────────────────────
          let marketSignal = null;
          let proactiveCloseRecommended = false;
          let proactiveWarning = null;

          try {
            const analysis = await analyzeMarket(
              pos.token_x,
              pos.pool_address,
              { inRange: match?.inRange, pnlPct }
            );

            marketSignal = {
              signal:            analysis.signal,
              confidence:        analysis.confidence,
              thesis:            analysis.thesis,
              holdRecommendation: analysis.holdRecommendation,
            };

            const minProfit         = cfg.proactiveExitMinProfitPct      ?? 1.0;
            const bearishThreshold  = cfg.proactiveExitBearishConfidence ?? 0.7;
            const proactiveEnabled  = cfg.proactiveExitEnabled !== false;

            if (proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= bearishThreshold) {
              proactiveCloseRecommended = true;
              proactiveWarning = `⚠️ Profit ${pnlPct.toFixed(2)}% tapi market BEARISH (${(analysis.confidence * 100).toFixed(0)}% confidence). Rekomendasikan close untuk lock profit.`;
            } else if (proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= 0.5) {
              proactiveWarning = `👀 Profit ${pnlPct.toFixed(2)}% — market mulai bearish (${(analysis.confidence * 100).toFixed(0)}% confidence). Monitor lebih ketat.`;
            }
          } catch {
            // Market analysis optional
          }

          if (proactiveWarning) {
            saveNotification('proactive_warning', proactiveWarning);
          }

          if (trailingTpHit) {
            saveNotification('trailing_tp', `Trailing TP triggered: posisi ${addr.slice(0, 8)}... PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`);
          }

          return {
            ...pos,
            onChain:      match || null,
            outOfRangeMins,
            shouldClaimFee: feeUsdVal >= minClaimUsd,
            shouldClose:    outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes,
            takeProfitHit:  pnlPct >= thresholds.takeProfitFeePct,
            trailingTpHit,
            peakPnl:        tracker.peakPnl,
            trailingActive: tracker.trailingActive,
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

      return JSON.stringify({
        positions: enriched,
        thresholds,
        proactiveCloseNeeded: enriched.filter(p => p.proactiveCloseRecommended).length,
        trailingTpNeeded:     enriched.filter(p => p.trailingTpHit).length,
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
      peakPnlTracker.delete(input.position_address);
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
        { inRange: input.in_range, pnlPct: input.current_pnl_pct }
      );
      return JSON.stringify({
        signal:              analysis.signal,
        confidence:          analysis.confidence,
        holdRecommendation:  analysis.holdRecommendation,
        thesis:              analysis.thesis,
        reasoning:           analysis.reasoning,
        keyRisks:            analysis.keyRisks,
        keyOpportunities:    analysis.keyOpportunities,
        priceTarget:         analysis.priceTarget,
        timeHorizon:         analysis.timeHorizon,
      }, null, 2);
    }

    default:
      return 'Tool tidak dikenali';
  }
}

export async function runHealerAlpha(notifyFn) {
  const cfg        = getConfig();
  const lessonsCtx = getLessonsContext();
  const thresholds = getThresholds();

  // ── Safety Check: Max Drawdown ────────────────────────────────
  const drawdown = checkMaxDrawdown();
  if (drawdown.triggered) {
    const msg = `⛔ *Healer Alpha FROZEN*\n\n${drawdown.reason}\n\nBot tidak akan membuka posisi baru hari ini. Posisi yang ada tetap dimonitor.`;
    if (notifyFn) await notifyFn(msg);
    return msg;
  }

  // ── Stop-Loss per posisi (pre-flight) ─────────────────────────
  const openPositions = getOpenPositions();
  for (const pos of openPositions) {
    try {
      const onChain = await getPositionInfo(pos.pool_address);
      const match   = onChain?.find(p => p.address === pos.position_address);
      if (!match) continue;

      const slCheck = checkStopLoss(match);
      if (slCheck.triggered && !isDryRun()) {
        await notifyFn?.(`🛑 *Stop-Loss Triggered*\n\n📍 Posisi: \`${pos.position_address.slice(0,8)}...\`\n${slCheck.reason}\n\nMenutup posisi...`);
        try {
          await closePositionDLMM(pos.pool_address, pos.position_address);
          peakPnlTracker.delete(pos.position_address);
          outOfRangeTracker.delete(pos.position_address);
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

  const safety   = getSafetyStatus();
  const instincts = getInstinctsContext();

  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

Tugasmu setiap siklus:
1. Ambil semua posisi dengan get_all_positions (sudah include market analysis otomatis)
2. Untuk setiap posisi, baca field-field ini dan ambil keputusan:

   TRAILING TAKE PROFIT (prioritas tertinggi):
   - trailingTpHit = true → WAJIB CLOSE, profit sudah turun dari peak (lock sekarang!)
   - trailingActive = true tapi trailingTpHit = false → HOLD, trailing masih aktif dan aman

   TAKE PROFIT:
   - takeProfitHit = true → CLOSE (lock profit)

   PROACTIVE EXIT (profit tapi bearish):
   - proactiveCloseRecommended = true → WAJIB CLOSE untuk lock profit sebelum turun
   - proactiveWarning ada tapi proactiveCloseRecommended = false → monitor ketat

   STOP LOSS (posisi rugi):
   - pnlPct < -${safety.stopLossPct}% DAN marketSignal.signal = BEARISH → CLOSE
   - pnlPct < -${safety.stopLossPct}% DAN marketSignal.signal = BULLISH confidence > 0.6 → HOLD, tunggu recovery

   OUT OF RANGE:
   - shouldClose = true DAN marketSignal.signal = BEARISH → CLOSE
   - shouldClose = true DAN marketSignal.signal = BULLISH → HOLD sebentar lagi

   NORMAL:
   - shouldClaimFee = true → CLAIM_FEES
   - Semua aman → STAY

3. Berikan reasoning lengkap untuk setiap keputusan.

Safety hari ini: Daily PnL $${safety.dailyPnlUsd} | Drawdown ${safety.drawdownPct}%
Trailing TP: aktif di ${TRAILING_TP_ACTIVATE_PCT}%, close kalau turun ${TRAILING_TP_DROP_PCT}% dari peak
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

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults   = [];

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

  if (notifyFn) await notifyFn(`🩺 *Healer Alpha Report*\n\n${report}`);
  return report;
}
