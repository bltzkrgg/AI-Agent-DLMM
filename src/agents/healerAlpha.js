import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees, getPoolInfo } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, closePositionWithPnl, saveNotification } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnl, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { swapAllToSOL, SOL_MINT } from '../solana/jupiter.js';
import { fetchCandles, fetchMultiTFOHLCV } from '../market/oracle.js';
import { detectEvilPandaSignals, computeSupertrend, computeRSI, computeFibLevels, detectGreenCandleAtResistance, detectExitContext } from '../market/taIndicators.js';
import { kv, hr, codeBlock, formatPnl, shortAddr, shortStrat } from '../utils/table.js';
import { formatStrategyAlert } from '../utils/alerts.js';
import { recordClose } from '../market/poolMemory.js';

// Trailing TP thresholds — baca dari config (configurable via /setconfig)
// Fallback ke defaults jika config belum tersedia
function getTrailingConfig() {
  const cfg = getConfig();
  return {
    activatePct: cfg.trailingTriggerPct ?? 3.0,
    dropPct:     cfg.trailingDropPct    ?? 1.5,
  };
}

let lastReport = null;
export function getLastHealerReport() { return lastReport; }

// Track saat posisi keluar dari range
const outOfRangeTracker = new Map(); // positionAddress → timestamp

// Track peak PnL per posisi untuk trailing take profit
const peakPnlTracker = new Map(); // positionAddress → { peakPnl, trailingActive }

// ─── Post-Close 5-Minute Monitor ─────────────────────────────────
// Setelah posisi ditutup + swap selesai, kirim update balance setiap
// menit selama 5 menit untuk konfirmasi SOL sudah masuk & stabil.

export function startPostCloseMonitor(poolAddress, pnlPct, notifyFn) {
  if (!notifyFn) return;
  let elapsed = 0;
  const interval = setInterval(async () => {
    elapsed++;
    try {
      const balance = await getWalletBalance();
      const balSol  = parseFloat(balance).toFixed(4);
      const icon    = elapsed < 5 ? '⏱' : '✅';
      const msg     = elapsed < 5
        ? `${icon} *Post-Close Monitor* T+${elapsed}m\n\nBalance: \`${balSol} SOL\`\n_Monitoring... (${5 - elapsed}m lagi)_`
        : `${icon} *Post-Close Monitor Selesai*\n\nBalance final: \`${balSol} SOL\`\nPool: \`${poolAddress?.slice(0, 12)}...\`\nPnL: \`${pnlPct >= 0 ? '+' : ''}${pnlPct?.toFixed(2) || '?'}%\``;
      await notifyFn(msg);
    } catch { /* best-effort */ }
    if (elapsed >= 5) clearInterval(interval);
  }, 60_000); // setiap 1 menit
}

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
    description: 'Tutup posisi dan tarik semua likuiditas + fees. Token X dan SOL dikembalikan ke wallet — best-effort swap ke SOL setelahnya.',
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
    name: 'zap_out',
    description: 'Tutup posisi + langsung swap SEMUA token ke SOL via Jupiter dengan retry otomatis (3 percobaan). Gunakan ini saat: (1) user minta "zap out", (2) exit agresif/darurat, (3) close_position sebelumnya gagal swap. Lebih reliable daripada close_position untuk memastikan semua return ter-convert ke SOL.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address:     { type: 'string' },
        position_address: { type: 'string' },
        reasoning:        { type: 'string', description: 'Alasan zap out' },
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

          // Deteksi posisi ditutup manual
          if (!match && Array.isArray(onChain)) {
            closePositionWithPnl(pos.position_address, {
              pnlUsd: 0, pnlPct: 0, feesUsd: 0, closeReason: 'MANUAL_CLOSE',
            });
            outOfRangeTracker.delete(pos.position_address);
            peakPnlTracker.delete(pos.position_address);
            return { ...pos, manualClose: true, status: 'closed', closeReason: 'MANUAL_CLOSE' };
          }

          // ── Out-of-range tracking ────────────────────────────
          let outOfRangeMins = null;
          let outOfRangeBins = null;
          if (match && !match.inRange) {
            const trackedAt = outOfRangeTracker.get(pos.position_address);
            if (!trackedAt) {
              outOfRangeTracker.set(pos.position_address, Date.now());
            } else {
              outOfRangeMins = Math.floor((Date.now() - trackedAt) / 60000);
            }
            // Bin-based OOR: estimate distance in bins from active bin
            if (match.activeBinId != null && (match.lowerBinId != null || match.upperBinId != null)) {
              const lowerBin = match.lowerBinId ?? match.activeBinId;
              const upperBin = match.upperBinId ?? match.activeBinId;
              if (match.activeBinId < lowerBin) {
                outOfRangeBins = lowerBin - match.activeBinId;
              } else if (match.activeBinId > upperBin) {
                outOfRangeBins = match.activeBinId - upperBin;
              }
            }
          } else {
            outOfRangeTracker.delete(pos.position_address);
          }

          // PnL on-chain: (currentValueSol - deployed_sol) / deployed_sol * 100
          const deployedSol   = pos.deployed_sol || 0;
          const currentValSol = match?.currentValueSol ?? 0;
          const pnlPct = deployedSol > 0 && currentValSol > 0
            ? parseFloat(((currentValSol - deployedSol) / deployedSol * 100).toFixed(2))
            : 0;
          const feeCollSol = match?.feeCollectedSol ?? 0;
          const isProfit   = pnlPct > 0;
          // Claim saat fee >= 3% dari deployed capital (dalam SOL), urgent >= 5%
          // min floor 0.005 SOL (~$0.50 at $100/SOL) untuk menghindari dust claim
          const deployedSolFee     = pos.deployed_sol || 0;
          const claimThreshold3Sol = deployedSolFee > 0 ? Math.max(deployedSolFee * 0.03, 0.005) : 0.01;
          const claimThreshold5Sol = deployedSolFee > 0 ? Math.max(deployedSolFee * 0.05, 0.005) : 0.02;

          // ── Trailing Take Profit tracking ────────────────────
          // Terinspirasi dari Meridian: track peak PnL, aktifkan trailing
          const addr = pos.position_address;
          let tracker = peakPnlTracker.get(addr) || { peakPnl: pnlPct, trailingActive: false };

          // Update peak
          if (pnlPct > tracker.peakPnl) {
            tracker.peakPnl = pnlPct;
          }

          // Aktifkan trailing kalau sudah reach threshold (dari config)
          const trailingCfg = getTrailingConfig();
          if (!tracker.trailingActive && pnlPct >= trailingCfg.activatePct) {
            tracker.trailingActive = true;
          }

          // Cek apakah trailing TP terpicu
          const trailingTpHit = tracker.trailingActive &&
            (tracker.peakPnl - pnlPct) >= trailingCfg.dropPct;

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
            shouldClaimFee:        feeCollSol >= claimThreshold3Sol,
            shouldClaimFeeUrgent:  feeCollSol >= claimThreshold5Sol,
            feeCollectedSol:       feeCollSol,
            shouldClose: (
              (outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes) ||
              (outOfRangeBins !== null && cfg.outOfRangeBinsToClose > 0 && outOfRangeBins >= cfg.outOfRangeBinsToClose)
            ),
            outOfRangeBins,
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
      // Ambil PnL on-chain sebelum close untuk akurasi pencatatan
      let pnlData = { closeReason: (input.reasoning || 'AGENT_CLOSE').toUpperCase().replace(/ /g, '_') };
      try {
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          pnlData.pnlUsd  = parseFloat((currentVal - deployedSol).toFixed(6));
          pnlData.pnlPct  = deployedSol > 0 ? parseFloat(((currentVal - deployedSol) / deployedSol * 100).toFixed(2)) : 0;
          pnlData.feeUsd  = match.feeCollectedSol ?? 0;
        }
      } catch { /* best-effort, tetap close */ }

      const closeResult = await closePositionDLMM(input.pool_address, input.position_address, pnlData);
      outOfRangeTracker.delete(input.position_address);
      peakPnlTracker.delete(input.position_address);

      // Record ke pool memory
      recordClose(input.pool_address, {
        pnlPct: pnlData.pnlPct || 0,
        reason:  pnlData.closeReason || 'AGENT_CLOSE',
      });

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      // Auto-swap returned tokens ke SOL setelah close (retry 3x)
      const swapResults = [];
      const swapErrors  = [];
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const swapRes = await swapAllToSOL(mint);
                if (swapRes.success) {
                  swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
                } else {
                  swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
                }
                break;
              } catch (e) {
                if (attempt === 3) swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
                else await new Promise(r => setTimeout(r, 2000 * attempt));
              }
            }
          }
        }
      } catch { /* swap best-effort */ }

      // Notifikasi swap + mulai post-close monitor
      if (_healerNotifyFn) {
        const totalSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          _healerNotifyFn(
            `🔄 *Auto-Swap Selesai*\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: \`+${totalSol.toFixed(4)} SOL\`\n` +
            `_5 menit monitoring dimulai..._`
          ).catch(() => {});
        } else if (swapErrors.length > 0) {
          _healerNotifyFn(
            `⚠️ *Auto-Swap Gagal*\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: ${swapErrors.map(e => e.error || e.mint).join(', ')}\n` +
            `_Lakukan swap manual di Jupiter/Meteora._`
          ).catch(() => {});
        }
        startPostCloseMonitor(input.pool_address, pnlData.pnlPct || 0, _healerNotifyFn);
      }

      return JSON.stringify({
        ...closeResult,
        pnlRecorded: pnlData,
        autoSwap:    swapResults.length > 0 ? swapResults : 'skipped',
        swapErrors:  swapErrors.length > 0  ? swapErrors  : undefined,
        reasoning:   input.reasoning,
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

    case 'zap_out': {
      // Zap Out = close position + guaranteed swap semua token ke SOL
      // Ambil PnL on-chain sebelum close
      let zapPnlData = { closeReason: 'ZAP_OUT' };
      try {
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          zapPnlData.pnlUsd = parseFloat((currentVal - deployedSol).toFixed(6));
          zapPnlData.pnlPct = deployedSol > 0 ? parseFloat(((currentVal - deployedSol) / deployedSol * 100).toFixed(2)) : 0;
          zapPnlData.feeUsd = match.feeCollectedSol ?? 0;
        }
      } catch { /* best-effort */ }

      const closeResult = await closePositionDLMM(input.pool_address, input.position_address, zapPnlData);
      outOfRangeTracker.delete(input.position_address);
      peakPnlTracker.delete(input.position_address);

      // Record ke pool memory
      recordClose(input.pool_address, {
        pnlPct: zapPnlData.pnlPct || 0,
        reason:  zapPnlData.closeReason || 'ZAP_OUT',
      });

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      const swapResults = [];
      const swapErrors  = [];
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (!mint || mint === SOL_MINT) continue;
          // Retry 3x dengan backoff
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const swapRes = await swapAllToSOL(mint);
              if (swapRes.success) {
                swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol, txHash: swapRes.txHash });
              } else {
                swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
              }
              break;
            } catch (e) {
              if (attempt === 3) swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
              else await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
        }
      } catch (e) {
        swapErrors.push({ error: e.message });
      }

      const totalSwappedSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);

      // Notifikasi hasil + mulai post-close monitor
      if (_healerNotifyFn) {
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          _healerNotifyFn(
            `⚡ *Zap Out Selesai*\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: \`+${totalSwappedSol.toFixed(4)} SOL\`\n` +
            `_5 menit monitoring dimulai..._`
          ).catch(() => {});
        } else if (swapErrors.length > 0) {
          _healerNotifyFn(
            `⚠️ *Zap Out — Swap Gagal*\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: ${swapErrors.map(e => e.error || e.mint).join(', ')}\n` +
            `_Lakukan swap manual di Jupiter/Meteora._`
          ).catch(() => {});
        } else {
          // Semua di-skip (balance 0 — kemungkinan single-side SOL yang belum OOR)
          _healerNotifyFn(
            `✅ *Zap Out Selesai*\n\nPosisi ditutup. Semua dana sudah dalam bentuk SOL.\n_5 menit monitoring dimulai..._`
          ).catch(() => {});
        }
        startPostCloseMonitor(input.pool_address, zapPnlData.pnlPct || 0, _healerNotifyFn);
      }

      return JSON.stringify({
        ...closeResult,
        zapOut: true,
        swapResults,
        swapErrors: swapErrors.length > 0 ? swapErrors : null,
        totalSwappedSol: parseFloat(totalSwappedSol.toFixed(6)),
        reasoning: input.reasoning,
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

// ─── Simpan notify function untuk dipakai di tool executor ───────
let _healerNotifyFn = null;

export async function runHealerAlpha(notifyFn) {
  _healerNotifyFn = notifyFn || null;
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

  // Smart skip: track apakah ada posisi yang butuh LLM evaluation.
  // Jika semua posisi healthy (in-range, fees rendah, PnL normal) → skip LLM call.
  let _healerNeedsLLM = false;

  for (const pos of openPositions) {
    try {
      const onChain = await getPositionInfo(pos.pool_address);
      const match   = onChain?.find(p => p.address === pos.position_address);

      // Deteksi posisi ditutup manual: on-chain berhasil diambil tapi posisi tidak ada
      if (!match && Array.isArray(onChain)) {
        closePositionWithPnl(pos.position_address, {
          pnlUsd: 0, pnlPct: 0, feesUsd: 0, closeReason: 'MANUAL_CLOSE',
        });
        outOfRangeTracker.delete(pos.position_address);
        peakPnlTracker.delete(pos.position_address);
        const manualLines = [
          kv('Posisi',   shortAddr(pos.position_address), 10),
          kv('Pool',     shortAddr(pos.pool_address), 10),
          kv('Strategi', shortStrat(pos.strategy_used || '-'), 10),
          hr(40),
          kv('Deploy',   `${(pos.deployed_sol || 0).toFixed(4)}◎`, 10),
          kv('Status',   'Ditutup manual — tidak ada di chain', 10),
        ];
        await notifyFn?.(
          `⚠️ *Posisi Ditutup Manual*\n\n${codeBlock(manualLines)}\n\n_Posisi tidak ditemukan on-chain. Status diperbarui ke CLOSED._`
        );
        continue;
      }

      if (!match) continue; // on-chain error / network issue, skip siklus ini

      // PnL on-chain: (currentValueSol - deployed_sol) / deployed_sol * 100
      const _deployedSol   = pos.deployed_sol || 0;
      const _currentValSol = match.currentValueSol ?? 0;
      const pnlPct = _deployedSol > 0 && _currentValSol > 0
        ? parseFloat(((_currentValSol - _deployedSol) / _deployedSol * 100).toFixed(2))
        : 0;
      const pnlSol = parseFloat((_currentValSol - _deployedSol).toFixed(6));
      const addr   = pos.position_address;

      // ── Trailing TP state ────────────────────────────────────
      const trailCfg = getTrailingConfig();
      let tracker = peakPnlTracker.get(addr) || { peakPnl: pnlPct, trailingActive: false };
      if (pnlPct > tracker.peakPnl) tracker.peakPnl = pnlPct;
      if (!tracker.trailingActive && pnlPct >= trailCfg.activatePct) tracker.trailingActive = true;
      const trailingTpHit = tracker.trailingActive && (tracker.peakPnl - pnlPct) >= trailCfg.dropPct;
      peakPnlTracker.set(addr, tracker);

      const slCheck = checkStopLoss({ pnlPct });
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

      // ── Multi-TF exit check ───────────────────────────────────
      // Aktif saat posisi sudah profit ≥ 1% — cek confluence exit 15m + 1h + 4h
      // Exit jika 2+ TF masing-masing ≥ 2 sinyal, atau total sinyal ≥ 4
      let multiTFExitHit = false;
      let multiTFExitMsg = '';
      if (pnlPct >= 1.0) {
        try {
          const multiTF = await fetchMultiTFOHLCV(pos.token_x, pos.pool_address);
          const tfs = Object.values(multiTF);
          if (tfs.length >= 2) {
            const tfsFiring = tfs.filter(tf => tf.exitSignals >= 2);
            const totalSigs = tfs.reduce((s, tf) => s + tf.exitSignals, 0);
            if (tfsFiring.length >= 2 || totalSigs >= 4) {
              multiTFExitHit = true;
              multiTFExitMsg = `Exit confluence: ${tfsFiring.map(tf => tf.label + '(' + tf.exitSignals + ')').join(' + ')}`;
            }
          }
        } catch { /* best-effort, skip jika gagal */ }
      }

      // ── Exit Strategy: Fibonacci + Green Candle Rule ─────────
      let fibExitHit  = false;
      let fibExitMsg  = '';
      let exitContext = null;
      try {
        const fibCandles = await fetchCandles(pos.token_x, '15m', 100, pos.pool_address);
        if (fibCandles && fibCandles.length >= 20) {
          exitContext = detectExitContext(fibCandles, pnlPct);
          const fibLevels   = computeFibLevels(fibCandles, 50);
          const greenCandle = detectGreenCandleAtResistance(fibCandles, fibLevels);
          if (greenCandle?.triggered) {
            fibExitHit = true;
            fibExitMsg = `[${exitContext || 'NORMAL'}] ${greenCandle.reason}`;
          }
        }
      } catch { /* best-effort */ }

      // Tidak ada trigger → flag apakah posisi ini butuh LLM, lalu skip
      if (!trailingTpHit && !tpHit && !slCheck.triggered && !evilPandaExitHit && !multiTFExitHit && !fibExitHit) {
        // Posisi butuh LLM jika: out of range, fees tinggi, atau mendekati SL
        if (!match?.inRange) _healerNeedsLLM = true;
        const feePct = (match?.feeCollectedSol || 0) / (pos.deployed_sol || 0.001);
        if (feePct >= 0.03) _healerNeedsLLM = true;
        if (pnlPct <= -(thresholds.stopLossPct * 0.6)) _healerNeedsLLM = true;
        continue;
      }

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

      // Evil Panda + Multi-TF + Fib exit are unconditional — don't HOLD
      if (evilPandaExitHit || multiTFExitHit || fibExitHit) {
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
        : multiTFExitHit                    ? 'Multi-TF Exit'
        : fibExitHit                        ? 'Fib Resistance Exit'
        : trailingTpHit                     ? 'Trailing Take Profit'
        : tpHit                             ? 'Take Profit'
        : 'Stop-Loss';
      const triggerEmoji = evilPandaExitHit ? '🐼'
        : multiTFExitHit                    ? '📊'
        : fibExitHit                        ? '📐'
        : trailingTpHit                     ? '🎯'
        : tpHit                             ? '💰'
        : '🛑';
      const triggerReason = evilPandaExitHit
        ? evilPandaExitMsg
        : multiTFExitHit
        ? multiTFExitMsg
        : fibExitHit
        ? fibExitMsg
        : trailingTpHit
        ? `PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`
        : tpHit
        ? `PnL ${pnlPct.toFixed(2)}% ≥ target ${thresholds.takeProfitFeePct}%`
        : slCheck.reason;

      // ── Terminal-style indicator table ───────────────────────────
      // PnL display — SOL-based (USD API tidak tersedia)
      const _pnlDisplay = `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)}◎  ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
      const _rangeTag   = match.inRange ? 'IN RANGE  ✅' : 'OUT RANGE ⚠️';
      const _trailTag   = tracker.trailingActive
        ? `ON  peak=${tracker.peakPnl.toFixed(2)}%`
        : 'OFF';

      // Bangun tabel indikator lengkap
      const W = 10; // lebar key column
      const _posLines = [
        kv('Posisi',   shortAddr(addr), W),
        kv('Strategi', shortStrat(pos.strategy_used || '-'), W),
        kv('Range',    _rangeTag, W),
        hr(40),
        kv('Deploy',   `${_deployedSol.toFixed(4)}◎`, W),
        kv('Value',    `${_currentValSol.toFixed(4)}◎`, W),
        kv('PnL',      _pnlDisplay, W),
        kv('Peak',     `${tracker.peakPnl >= 0 ? '+' : ''}${tracker.peakPnl.toFixed(2)}%`, W),
        kv('Trailing', _trailTag, W),
        kv('Fees',     `+${(match.feeCollectedSol || 0).toFixed(4)}◎`, W),
      ];

      // Market analysis section
      const _mktLines = market
        ? [
            hr(40),
            kv('Signal',   `${sig}  (${(conf * 100).toFixed(0)}% conf)`, W),
            kv('Thesis',   (thesis || '-').slice(0, 32), W),
            kv('Risk',     (market?.keyRisks?.[0] || '-').slice(0, 32), W),
          ]
        : [hr(40), kv('Market', 'data tidak tersedia', W)];

      // Trigger section
      const _trigLines = [
        hr(40),
        kv('Trigger',  triggerLabel, W),
        kv('Decision', decision, W),
      ];

      const _fullTable = [..._posLines, ..._mktLines, ..._trigLines];

      // ── HOLD ─────────────────────────────────────────────────────
      if (decision === 'HOLD') {
        const lines = [
          ..._fullTable,
          hr(40),
          `Alasan   : ${(holdReason || '-').slice(0, 38)}`,
        ];
        await notifyFn?.(
          `${triggerEmoji} *${triggerLabel} — DITUNDA*\n\n${codeBlock(lines)}`
        );
        continue;
      }

      // ── HOLD_TRAIL ───────────────────────────────────────────────
      if (decision === 'HOLD_TRAIL') {
        tracker.trailingActive = true;
        peakPnlTracker.set(addr, tracker);
        const lines = [
          ..._fullTable,
          hr(40),
          kv('Trail', `close ≤ ${(tracker.peakPnl - trailCfg.dropPct).toFixed(2)}%`, W),
        ];
        await notifyFn?.(
          `💰 *Take Profit — Trailing Diaktifkan*\n\n${codeBlock(lines)}`
        );
        continue;
      }

      // ── CLOSE ─────────────────────────────────────────────────────
      const preCloseLines = [
        ..._fullTable,
        hr(40),
        kv('Alasan', (triggerReason || '-').slice(0, 38), W),
      ];
      await notifyFn?.(
        `${triggerEmoji} *${triggerLabel} — CLOSE*\n\n${codeBlock(preCloseLines)}\n\n_Menutup posisi..._`
      );

      try {
        await closePositionDLMM(pos.pool_address, addr, {
          pnlUsd:      pnlSol, // SOL proxy — USD API tidak tersedia
          pnlPct,
          feeUsd:      match.feeCollectedSol || 0,
          closeReason: triggerLabel.toUpperCase().replace(/ /g, '_'),
        });
        peakPnlTracker.delete(addr);
        outOfRangeTracker.delete(addr);
        recordPnl(pnlSol);

        // Record ke pool memory
        recordClose(pos.pool_address, {
          pnlPct:   pnlPct,
          reason:   triggerLabel.toUpperCase().replace(/ /g, '_'),
        });

        // Auto-swap token → SOL (retry 2x)
        const swapMsgs = [];
        let totalSwappedSol = 0;
        try {
          const poolInfo = await getPoolInfo(pos.pool_address);
          for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
            if (mint && mint !== SOL_MINT) {
              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  const swapRes = await swapAllToSOL(mint);
                  if (swapRes.success) {
                    swapMsgs.push(`+${swapRes.outSol.toFixed(4)}◎`);
                    totalSwappedSol += swapRes.outSol;
                  }
                  break;
                } catch {
                  if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
                }
              }
            }
          }
        } catch { /* swap best-effort */ }

        // Notifikasi swap + mulai 5-menit monitor
        if (swapMsgs.length > 0) {
          await notifyFn?.(
            `🔄 *Auto-Swap Selesai*\n\nToken → SOL: ${swapMsgs.join(', ')}\nTotal: \`+${totalSwappedSol.toFixed(4)} SOL\`\n_5 menit monitoring dimulai..._`
          );
          startPostCloseMonitor(pos.pool_address, pnlPct, notifyFn);
        }

        const closedLines = [
          kv('Posisi',   shortAddr(addr), W),
          kv('Strategi', shortStrat(pos.strategy_used || '-'), W),
          hr(40),
          kv('Deploy',   `${_deployedSol.toFixed(4)}◎`, W),
          kv('Return',   `${_currentValSol.toFixed(4)}◎`, W),
          kv('PnL',      _pnlDisplay, W),
          kv('Fees',     `+${(match?.feeCollectedSol || 0).toFixed(4)}◎`, W),
          hr(40),
          kv('Trigger',  triggerLabel, W),
          ...(swapMsgs.length > 0 ? [hr(40), kv('Swap', swapMsgs.join(', '), W)] : []),
        ];
        await notifyFn?.(`✅ *Posisi Ditutup*\n\n${codeBlock(closedLines)}`);

        // ── Post-close opportunity scan — apakah pool ini masih layak re-entry? ──
        try {
          const epCandles = await fetchCandles(pos.token_x, '15m', 100, pos.pool_address);
          if (epCandles && epCandles.length >= 35) {
            const closes   = epCandles.map(c => c.c);
            const highs    = epCandles.map(c => c.h);
            const lows     = epCandles.map(c => c.l);
            const st       = computeSupertrend(highs, lows, closes, 10, 3);
            const rsi14Val = computeRSI(closes, 14);
            const last96   = epCandles.slice(-96);
            const low24h   = Math.min(...last96.map(c => c.l));
            const curPrice = closes[closes.length - 1];
            const distPct  = low24h > 0 ? ((curPrice - low24h) / low24h) * 100 : 99;

            // Check re-entry conditions
            if (st?.isBullish && distPct >= 0 && distPct <= 12 && rsi14Val >= 35 && rsi14Val <= 65) {
              await notifyFn?.(formatStrategyAlert({
                strategy:    pos.strategy_used || 'Wave Enjoyer',
                pool:        null,
                poolAddress: pos.pool_address,
                reason:      `Re-entry setelah close — Supertrend masih BULLISH | Price ${distPct.toFixed(1)}% di atas support | RSI14=${rsi14Val?.toFixed(0)}`,
                priority:    'MEDIUM',
              }));
            }
          }
        } catch { /* best-effort, jangan crash */ }
      } catch (e) {
        await notifyFn?.(`❌ Gagal close ${triggerLabel}: ${e.message}`);
      }
    } catch { /* skip jika gagal fetch */ }
  }

  // Skip LLM jika pre-flight sudah close semua posisi — hemat API call
  if (getOpenPositions().length === 0) return null;

  // Smart skip: semua posisi healthy (in-range, fees rendah, PnL normal) — skip LLM
  if (!_healerNeedsLLM) return null;

  const safety   = getSafetyStatus();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();

  const trailCfgForPrompt = getTrailingConfig();
  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

CATATAN: Stop-loss, Take Profit, Trailing TP, Evil Panda Exit, Multi-TF Exit, dan Fib Resistance Exit
sudah diproses di pre-flight dengan mempertimbangkan kondisi chart dan narasi.
Posisi yang sampai di loop ini = belum di-close oleh pre-flight (masih aman atau chart bilang HOLD).
Fokus kamu: proactive exit saat market bearish, out-of-range, claim fees, dan keputusan edge case.

DUA MODE CLOSE:
   • close_position — tutup posisi, best-effort swap. Untuk kondisi normal.
   • zap_out — tutup posisi + guaranteed swap ke SOL (retry 3x). Gunakan untuk:
     - User minta "zap out" atau "keluar bersih"
     - Exit darurat (SL agresif, proactive BEARISH tinggi)
     - Konfirmasi bahwa close_position sebelumnya gagal swap
   Jangan panggil swap_to_sol secara terpisah setelah close_position atau zap_out — sudah ditangani otomatis.

DLMM EXIT STRATEGY FRAMEWORK:
Setiap posisi memiliki exitContext (dari pre-flight) — gunakan ini untuk menentukan agresivitas exit:

  TOP_ENTRY: Entered dekat recent high — position sangat sensitif terhadap reversal.
    → Exit lebih agresif. Jika harga stagnant >2 siklus atau market BEARISH → close segera.
    → Target profit kecil (1-3%), jangan tunggu TP normal.

  LATE_ENTRY: Entered setelah rally, harga masih tinggi tapi momentum melemah.
    → Exit saat first sign of weakness. Trailing TP lebih ketat dari biasanya.
    → Jika RSI > 70 + volume turun → close, jangan tunggu konfirmasi penuh.

  POST_DUMP_SIDEWAYS: Harga sudah dump dari entry, sekarang konsolidasi.
    → Tunggu bounce ke Fibonacci resistance terdekat untuk exit dengan PnL less-bad.
    → Jika sideways >4 siklus tanpa bounce → OVER_DUMP territory, close untuk stop bleeding.

  OVER_DUMP: PnL ≤ -20%, harga jauh di bawah entry.
    → EXIT DARURAT. Jangan tunggu recovery. zap_out segera.
    → Override semua HOLD logic kecuali jika ada news catalyst + volume spike.

GREEN CANDLE RULE (pre-flight sudah handle ini):
  Jika posisi sudah di-close karena "Fib Resistance Exit" → jangan re-evaluate, sudah benar.
  Jika data exitContext tersedia di posisi → pertimbangkan dalam keputusan exit.

RUG EMERGENCY BYPASS:
  Jika marketSignal.signal = BEARISH DAN confidence > 0.85 DAN pnlPct < -5%
  → Bypass semua exit logic — zap_out SEGERA tanpa menunggu sinyal lain.
  Ini adalah emergency exit, prioritas tertinggi.

ALUR KERJA:
1. get_all_positions → evaluasi semua posisi aktif
2. Untuk setiap posisi:

   PROACTIVE EXIT (profit tapi market bearish):
   - proactiveCloseRecommended = true → WAJIB zap_out (exit bersih ke SOL)
   - proactiveWarning ada tapi tidak recommended → monitor ketat

   OUT OF RANGE:
   - shouldClose = true DAN marketSignal.signal = BEARISH → zap_out
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
Trailing TP: aktif di ${trailCfgForPrompt.activatePct}%, close kalau turun ${trailCfgForPrompt.dropPct}% dari peak
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

  // Track action tools — report hanya dikirim jika ada close/claim yang terjadi
  const ACTION_TOOLS = new Set(['close_position', 'zap_out', 'claim_fees']);
  const actionsCalled = new Set();

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults   = [];

    for (const toolUse of toolUseBlocks) {
      if (ACTION_TOOLS.has(toolUse.name)) actionsCalled.add(toolUse.name);
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

  // Kirim LLM report HANYA jika ada tindakan nyata (close/zap/claim) yang diambil
  // Saat semua posisi HOLD — tidak ada notif, healer tetap diam
  if (actionsCalled.size > 0 && notifyFn) {
    await notifyFn(`🩺 *Healer Alpha*\n\n${report}`);
  }

  return report;
}
