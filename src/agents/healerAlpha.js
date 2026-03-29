import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees, getPoolInfo } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnl, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { swapAllToSOL, SOL_MINT } from '../solana/jupiter.js';
import { fetchCandles } from '../market/oracle.js';
import { detectEvilPandaSignals } from '../market/taIndicators.js';

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
  {
    name: 'swap_to_sol',
    description: 'Swap token ke SOL via Jupiter. Gunakan setelah close_position atau claim_fees untuk convert profit ke SOL.',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string', description: 'Mint address token yang akan di-swap ke SOL' },
        reasoning:  { type: 'string' },
      },
      required: ['token_mint', 'reasoning'],
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

          const pnlPct    = match?.pnlPct ?? 0;
          const feeUsdVal = match?.feeUsd ?? 0;
          const isProfit  = pnlPct > 0;
          // Claim saat fee >= 3% dari deployed capital, urgent >= 5% (min floor $0.50)
          const deployedUsd      = pos.deployed_usd || 0;
          const claimThreshold3  = deployedUsd > 0 ? Math.max(deployedUsd * 0.03, 0.50) : (cfg.minFeeClaimUsd ?? 1.0);
          const claimThreshold5  = deployedUsd > 0 ? Math.max(deployedUsd * 0.05, 0.50) : (cfg.minFeeClaimUsd ?? 1.0);
          const minClaimUsd      = claimThreshold3;

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

          let feeVelocity = null;
          let poolTaSignals = null;

          try {
            const analysis = await analyzeMarket(
              pos.token_x,
              pos.pool_address,
              { inRange: match?.inRange, pnlPct }
            );

            feeVelocity   = analysis.snapshot?.pool?.feeVelocity ?? null;
            poolTaSignals = analysis.snapshot?.ta ? {
              rsi14:           analysis.snapshot.ta.rsi14,
              rsi2:            analysis.snapshot.ta.rsi2,
              supertrend:      analysis.snapshot.ta.supertrend,
              evilPandaExit:   analysis.snapshot.ta.evilPanda?.exit ?? null,
              bb:              analysis.snapshot.ta.bb,
              macd:            analysis.snapshot.ta.macd
                ? { histogram: analysis.snapshot.ta.macd.histogram, firstGreenAfterRed: analysis.snapshot.ta.macd.firstGreenAfterRed }
                : null,
            } : null;

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
            shouldClaimFee:        feeUsdVal >= claimThreshold3,
            shouldClaimFeeUrgent:  feeUsdVal >= claimThreshold5,
            shouldClose:    outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes,
            takeProfitHit:  pnlPct >= thresholds.takeProfitFeePct,
            trailingTpHit,
            peakPnl:        tracker.peakPnl,
            trailingActive: tracker.trailingActive,
            pnlPct,
            isProfit,
            feeVelocity,
            poolTaSignals,
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
      const claimResult = await claimFees(input.pool_address, input.position_address);

      // Auto-swap fee tokens ke SOL setelah claim
      const swapResults = [];
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            const swapRes = await swapAllToSOL(mint);
            if (swapRes.success) swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
          }
        }
      } catch { /* swap best-effort */ }

      return JSON.stringify({
        ...claimResult,
        autoSwap: swapResults.length > 0 ? swapResults : 'skipped',
        reasoning: input.reasoning,
      }, null, 2);
    }

    case 'close_position': {
      const closeResult = await closePositionDLMM(input.pool_address, input.position_address);
      outOfRangeTracker.delete(input.position_address);
      peakPnlTracker.delete(input.position_address);

      // Auto-swap returned tokens ke SOL setelah close
      const swapResults = [];
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            const swapRes = await swapAllToSOL(mint);
            if (swapRes.success) swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
          }
        }
      } catch { /* swap best-effort */ }

      return JSON.stringify({
        ...closeResult,
        autoSwap: swapResults.length > 0 ? swapResults : 'skipped',
        reasoning: input.reasoning,
      }, null, 2);
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

    case 'swap_to_sol': {
      const swapResult = await swapAllToSOL(input.token_mint);
      return JSON.stringify({ ...swapResult, reasoning: input.reasoning }, null, 2);
    }

    default:
      return 'Tool tidak dikenali';
  }
}

export async function runHealerAlpha(notifyFn) {
  const cfg = getConfig();

  // ── Skip cycle silently jika tidak ada posisi terbuka ────────
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return null;

  const lessonsCtx = getLessonsContext();
  const thresholds = getThresholds();

  // ── Safety Check: Max Drawdown ────────────────────────────────
  const drawdown = checkMaxDrawdown();
  if (drawdown.triggered) {
    const msg = `⛔ *Healer Alpha FROZEN*\n\n${drawdown.reason}\n\nBot tidak akan membuka posisi baru hari ini. Posisi yang ada tetap dimonitor.`;
    if (notifyFn) await notifyFn(msg);
    return msg;
  }

  // ── Pre-flight: SL + TP + Trailing TP — dengan chart & narasi ──
  //
  // Alur per posisi:
  //   1. Cek apakah ada trigger (SL/TP/Trailing)
  //   2. Jika ya → baca market (chart + narasi + on-chain signals)
  //   3. Baru putuskan: CLOSE atau HOLD berdasarkan kondisi aktual
  //
  // Override rules:
  //   TP hit + BULLISH (conf ≥ 0.70) → jangan close, aktifkan trailing
  //   TP hit + BEARISH/NEUTRAL       → close, lock profit
  //   Trailing hit + BULLISH (≥0.75) → tunda 1 siklus
  //   Trailing hit + BEARISH/NEUTRAL → close
  //   SL hit + BULLISH (conf ≥ 0.65) → hold, tunggu recovery
  //   SL hit + BEARISH/NEUTRAL       → close segera

  for (const pos of openPositions) {
    try {
      const onChain = await getPositionInfo(pos.pool_address);
      const match   = onChain?.find(p => p.address === pos.position_address);
      if (!match) continue;

      const pnlPct = match.pnlPct ?? 0;
      const addr   = pos.position_address;

      // ── Trailing TP state ────────────────────────────────────
      let tracker = peakPnlTracker.get(addr) || { peakPnl: pnlPct, trailingActive: false };
      if (pnlPct > tracker.peakPnl) tracker.peakPnl = pnlPct;
      if (!tracker.trailingActive && pnlPct >= TRAILING_TP_ACTIVATE_PCT) tracker.trailingActive = true;
      const trailingTpHit = tracker.trailingActive && (tracker.peakPnl - pnlPct) >= TRAILING_TP_DROP_PCT;
      peakPnlTracker.set(addr, tracker);

      const slCheck = checkStopLoss(match);
      const tpHit   = pnlPct >= thresholds.takeProfitFeePct;

      // ── Evil Panda confluence exit (overrides TP/SL timing) ──
      let evilPandaExitHit  = false;
      let evilPandaExitMsg  = '';
      if (pos.strategy_used === 'Evil Panda') {
        try {
          const epCandles = await fetchCandles(pos.token_x, '15m', 200, pos.pool_address);
          const epSignals = epCandles ? detectEvilPandaSignals(epCandles) : null;
          if (epSignals?.exit?.triggered) {
            evilPandaExitHit = true;
            evilPandaExitMsg = epSignals.exit.reason;
          }
        } catch { /* best-effort */ }
      }

      // Tidak ada trigger → skip ke posisi berikutnya
      if (!trailingTpHit && !tpHit && !slCheck.triggered && !evilPandaExitHit) continue;

      // ── Baca kondisi chart & narasi sebelum keputusan ────────
      let market = null;
      try {
        market = await analyzeMarket(pos.token_x, pos.pool_address, {
          inRange: match.inRange,
          pnlPct,
        });
      } catch { /* tetap lanjut tanpa market data */ }

      const sig  = market?.signal     || 'NEUTRAL';
      const conf = market?.confidence || 0;
      const thesis = market?.thesis   || '-';
      const keyRisks = market?.keyRisks?.join(', ') || '-';

      // ── Putuskan: CLOSE atau HOLD ─────────────────────────────
      let decision  = 'CLOSE';
      let holdReason = '';

      // Evil Panda exit is unconditional — don't HOLD regardless of chart signal
      if (evilPandaExitHit) {
        decision = 'CLOSE';
      } else if (trailingTpHit) {
        if (sig === 'BULLISH' && conf >= 0.75) {
          decision   = 'HOLD';
          holdReason = `Chart masih BULLISH (${(conf * 100).toFixed(0)}% conf) — tunda close 1 siklus`;
        }
      } else if (tpHit) {
        if (sig === 'BULLISH' && conf >= 0.70) {
          decision   = 'HOLD_TRAIL';  // aktifkan trailing, jangan close dulu
          holdReason = `Chart BULLISH (${(conf * 100).toFixed(0)}% conf) — aktifkan trailing, biarkan profit jalan`;
        }
      } else if (slCheck.triggered) {
        if (sig === 'BULLISH' && conf >= 0.65) {
          decision   = 'HOLD';
          holdReason = `Chart masih BULLISH (${(conf * 100).toFixed(0)}% conf) — hold untuk recovery`;
        }
      }

      // Tentukan label + emoji
      const triggerLabel = evilPandaExitHit ? 'Evil Panda Exit'
        : trailingTpHit                     ? 'Trailing Take Profit'
        : tpHit                             ? 'Take Profit'
        : 'Stop-Loss';
      const triggerEmoji = evilPandaExitHit ? '🐼' : trailingTpHit ? '🎯' : tpHit ? '💰' : '🛑';
      const triggerReason = evilPandaExitHit
        ? evilPandaExitMsg
        : trailingTpHit
        ? `PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`
        : tpHit
        ? `PnL ${pnlPct.toFixed(2)}% ≥ target ${thresholds.takeProfitFeePct}%`
        : slCheck.reason;

      // Sinyal market untuk notif
      const sigLine = market
        ? `📡 Chart: *${sig}* (${(conf * 100).toFixed(0)}%)\n💬 _${thesis}_\n⚠️ Risk: ${keyRisks}`
        : `📡 Chart: data tidak tersedia`;

      // ── HOLD / HOLD_TRAIL ─────────────────────────────────────
      if (decision === 'HOLD') {
        await notifyFn?.(
          `${triggerEmoji} *${triggerLabel} — DITUNDA*\n\n` +
          `📍 \`${addr.slice(0, 8)}...\`\n` +
          `📊 PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n` +
          `${sigLine}\n\n` +
          `⏳ ${holdReason}`
        );
        continue;
      }

      if (decision === 'HOLD_TRAIL') {
        // Aktifkan trailing, jangan close — notif user
        tracker.trailingActive = true;
        peakPnlTracker.set(addr, tracker);
        await notifyFn?.(
          `💰 *Take Profit — Trailing Diaktifkan*\n\n` +
          `📍 \`${addr.slice(0, 8)}...\`\n` +
          `📊 PnL: +${pnlPct.toFixed(2)}% (peak)\n` +
          `${sigLine}\n\n` +
          `⏳ ${holdReason}\n` +
          `_Akan close jika PnL turun ${TRAILING_TP_DROP_PCT}% dari peak_`
        );
        continue;
      }

      // ── CLOSE ─────────────────────────────────────────────────
      await notifyFn?.(
        `${triggerEmoji} *${triggerLabel} — CLOSE*\n\n` +
        `📍 \`${addr.slice(0, 8)}...\`\n` +
        `📊 PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\n` +
        `${sigLine}\n\n` +
        `💭 ${triggerReason}\n\nMenutup posisi...`
      );

      try {
        await closePositionDLMM(pos.pool_address, addr, {
          pnlUsd:      match.pnlUsd || 0,
          pnlPct,
          feeUsd:      match.feeUsd || 0,
          closeReason: triggerLabel.toUpperCase().replace(/ /g, '_'),
        });
        peakPnlTracker.delete(addr);
        outOfRangeTracker.delete(addr);
        recordPnl(match.pnlUsd || 0);

        // Auto-swap token → SOL
        const swapMsgs = [];
        try {
          const poolInfo = await getPoolInfo(pos.pool_address);
          for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
            if (mint && mint !== SOL_MINT) {
              const swapRes = await swapAllToSOL(mint);
              if (swapRes.success) swapMsgs.push(`+${swapRes.outSol} SOL`);
            }
          }
        } catch { /* swap best-effort */ }

        const swapNote = swapMsgs.length > 0 ? `\n🔄 Auto-swap: ${swapMsgs.join(', ')}` : '';
        await notifyFn?.(`✅ Posisi ditutup (${triggerLabel}).${swapNote}`);
      } catch (e) {
        await notifyFn?.(`❌ Gagal close ${triggerLabel}: ${e.message}`);
      }
    } catch { /* skip jika gagal fetch */ }
  }

  // Skip LLM jika pre-flight sudah close semua posisi — hemat API call
  if (getOpenPositions().length === 0) return null;

  const safety   = getSafetyStatus();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();

  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

CATATAN: Stop-loss, Take Profit, dan Trailing TP sudah diproses di pre-flight dengan mempertimbangkan kondisi chart dan narasi.
Posisi yang sampai di loop ini = belum di-close oleh pre-flight (masih aman atau chart bilang HOLD).
Fokus kamu: proactive exit saat market bearish, out-of-range, claim fees, dan keputusan edge case.

ALUR KERJA:
1. get_all_positions → evaluasi semua posisi aktif
2. Untuk setiap posisi:

   PROACTIVE EXIT (profit tapi market bearish):
   - proactiveCloseRecommended = true → WAJIB CLOSE, lalu swap_to_sol untuk tokenX dan tokenY
   - proactiveWarning ada tapi tidak recommended → monitor ketat

   OUT OF RANGE:
   - shouldClose = true DAN marketSignal.signal = BEARISH → close_position, lalu swap_to_sol
   - shouldClose = true DAN marketSignal.signal = BULLISH → HOLD

   STOP LOSS TAMBAHAN (jika pre-flight gagal):
   - pnlPct < -${safety.stopLossPct}% DAN BEARISH → close_position, lalu swap_to_sol
   - pnlPct < -${safety.stopLossPct}% DAN BULLISH confidence > 0.6 → HOLD, tunggu recovery

   EVIL PANDA EXIT — khusus posisi dengan strategi Evil Panda:
   Data tersedia di poolTaSignals — gunakan ini untuk keputusan exit:
   • poolTaSignals.evilPandaExit.triggered = true → EXIT SEGERA (pre-built signal)
   • poolTaSignals.rsi2 > 90 + poolTaSignals.bb.aboveUpper = true → EXIT
   • poolTaSignals.rsi2 > 90 + poolTaSignals.macd.firstGreenAfterRed = true → EXIT
   Harus ada CONFLUENCE ≥2 sinyal untuk exit. Jika hanya 1 sinyal → HOLD.
   feeVelocity dari pool: "increasing" → hold lebih lama, "decreasing" → pertimbangkan exit lebih cepat.
   Jika poolTaSignals = null → gunakan TP normal (+${safety.stopLossPct}% fee APR).

   CLAIM FEES:
   - shouldClaimFeeUrgent = true (fee >= 5% deployed capital) → claim_fees SEGERA
   - shouldClaimFee = true (fee >= 3% deployed capital) → claim_fees
   - Keduanya false → jangan claim, biarkan akumulasi

   NORMAL → STAY

3. Setelah setiap close_position, gunakan swap_to_sol untuk tokenX dan tokenY yang bukan SOL.
4. Berikan reasoning lengkap untuk setiap keputusan.

Safety hari ini: Daily PnL $${safety.dailyPnlUsd} | Drawdown ${safety.drawdownPct}%
Trailing TP: aktif di ${TRAILING_TP_ACTIVATE_PCT}%, close kalau turun ${TRAILING_TP_DROP_PCT}% dari peak
Mode: 🔴 LIVE

${lessonsCtx}
${instincts}
${strategyIntel}

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
