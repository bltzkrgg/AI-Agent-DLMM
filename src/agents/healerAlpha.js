'use strict';

import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees, getPoolInfo, getSolPriceUsd } from '../solana/meteora.js';
import { getConnection, getWallet, getWalletBalance } from '../solana/wallet.js';
import { PublicKey } from '@solana/web3.js';
import { getOpenPositions, closePositionWithPnl, saveNotification, updatePositionLifecycle } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnlUsd, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { swapAllToSOL, SOL_MINT } from '../solana/jupiter.js';
import { getMarketSnapshot, getOHLCV } from '../market/oracle.js';
import { fetchWithTimeout, withRetry, withExponentialBackoff } from '../utils/safeJson.js';
import { kv, hr, codeBlock, formatPnl, shortAddr, shortStrat } from '../utils/table.js';
import { recordClose } from '../market/poolMemory.js';
import { executeControlledOperation } from '../app/executionService.js';
import { getWalletPositions, isLPAgentEnabled, getPoolSmartMoney } from '../market/lpAgent.js';
import { resolvePnlSnapshot } from '../app/pnl.js';
import { clearPositionRuntimeState, getPositionRuntimeState, updatePositionRuntimeState } from '../app/positionRuntimeState.js';
import { resolvePositionSnapshot } from '../app/positionSnapshot.js';
import { getStrategy } from '../strategies/strategyManager.js';
import { analyzeTradeResult } from '../learn/failureAnalysis.js';
import { calculateRSI, calculateSupertrend } from '../utils/ta.js';

// Verifikasi apakah position account benar-benar tidak ada on-chain.
// Dipakai sebelum mark MANUAL_CLOSE — cegah false positive dari RPC glitch.
async function positionAccountExists(positionAddress) {
  try {
    const info = await getConnection().getAccountInfo(new PublicKey(positionAddress));
    return info !== null;
  } catch {
    return true; // gagal cek → asumsikan masih ada (safe default)
  }
}

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

async function getLpPnlMap() {
  const pnlMap = new Map();
  if (!isLPAgentEnabled()) return pnlMap;

  try {
    const owner = getWallet()?.publicKey?.toString?.();
    if (!owner) return pnlMap;
    const lpPositions = await getWalletPositions(owner);
    if (!Array.isArray(lpPositions)) return pnlMap;
    for (const position of lpPositions) {
      if (position?.address && Number.isFinite(position.pnlPct)) {
        pnlMap.set(position.address, position.pnlPct);
      }
    }
  } catch { /* best-effort */ }

  return pnlMap;
}

function clearPositionState(positionAddress) {
  clearPositionRuntimeState(positionAddress);
}

function getPositionAgeMinutes(position) {
  const createdAt = new Date(position.created_at).getTime();
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
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

export async function executeTool(name, input, notifyFn = null) {
  const currentNotify = notifyFn || _healerNotifyFn;
  const cfg = getConfig();
  const thresholds = getThresholds();

  switch (name) {
    case 'get_all_positions': {
      const dbPositions = getOpenPositions();
      if (dbPositions.length === 0) return 'Tidak ada posisi terbuka saat ini.';
      const lpPnlMap = await getLpPnlMap();

      const enriched = await Promise.all(dbPositions.map(async (pos) => {
        try {
          const onChain = await getPositionInfo(pos.pool_address);
          const match   = onChain?.find(p => p.address === pos.position_address);

          // Deteksi posisi ditutup manual
          // Hanya mark MANUAL_CLOSE jika account benar-benar tidak ada on-chain.
          // onChain = [] bisa terjadi karena RPC glitch (false positive) — verifikasi dulu.
          if (!match && Array.isArray(onChain)) {
            const stillExists = await positionAccountExists(pos.position_address);
            if (stillExists) {
              // Account masih ada — getPositionInfo gagal karena RPC, bukan manual close
              return { ...pos, status: 'open', rpcError: true };
            }
            await closePositionWithPnl(pos.position_address, {
              pnlUsd: 0, pnlPct: 0, feesUsd: 0, pnlSol: 0, feesSol: 0, closeReason: 'MANUAL_CLOSE', lifecycleState: 'closed_reconciled',
            });
            // Trigger post-mortem silently for manual close (optional)
            analyzeTradeResult({ ...pos, pnl_pct: 0, close_reason: 'MANUAL_CLOSE' }).catch(() => {});
            clearPositionState(pos.position_address);
            return { ...pos, manualClose: true, status: 'closed', closeReason: 'MANUAL_CLOSE' };
          }

          // ── Out-of-range tracking ────────────────────────────
          let outOfRangeMins = null;
          let outOfRangeBins = null;
          const runtimeState = getPositionRuntimeState(pos.position_address);
          if (match && !match.inRange) {
            const trackedAt = runtimeState.oorSince;
            if (!trackedAt) {
              updatePositionRuntimeState(pos.position_address, { oorSince: Date.now() });
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
            updatePositionRuntimeState(pos.position_address, { oorSince: null });
          }

          const snapshot = resolvePositionSnapshot({
            dbPosition: pos,
            livePosition: match,
            providerPnlPct: lpPnlMap.get(pos.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
          });
          const pnlPct = snapshot.pnlPct;
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
          let tracker = {
            peakPnl: runtimeState.peakPnlPct ?? pnlPct,
            trailingActive: runtimeState.trailingActive === true,
          };

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

          updatePositionRuntimeState(addr, {
            peakPnlPct: tracker.peakPnl,
            trailingActive: tracker.trailingActive,
          });

          // ── Smart Money Tracking (Meteora Native) ────────────
          let smartMoney = null;
          if (cfg.useSmartWalletRanges || cfg.useSocialSignals) {
            smartMoney = await getPoolSmartMoney(pos.pool_address).catch(() => null);
          }

          let marketSignal = null;
          let proactiveCloseRecommended = false;
          let proactiveWarning = null;

          try {
            const analysis = await analyzeMarket(
              pos.token_x,
              pos.pool_address,
              { inRange: match?.inRange, pnlPct }
            );

            const hTotalVol = (analysis.snapshot?.ohlcv?.buyVolume || 0) + (analysis.snapshot?.ohlcv?.sellVolume || 0);
            const hVolDelta = hTotalVol > 0 ? (analysis.snapshot?.ohlcv?.buyVolume || 0) / hTotalVol : 0.5;
            const stTrend   = analysis.snapshot?.ta?.supertrend?.trend || 'UNKNOWN';

            marketSignal = {
              signal:            analysis.signal,
              confidence:        analysis.confidence,
              thesis:            analysis.thesis,
              holdRecommendation: analysis.holdRecommendation,
            };

            const minProfit         = cfg.proactiveExitMinProfitPct      ?? 1.0;
            const bearishThreshold  = cfg.proactiveExitBearishConfidence ?? 0.7;
            const proactiveEnabled  = cfg.proactiveExitEnabled !== false;
            
            // ── Technical Sniper Exit (Evil Panda / Confluence) ──────
            const taExit = analysis.snapshot?.ta?.['Evil Panda']?.exit || analysis.snapshot?.ta?.[pos.strategy_used]?.exit;
            const preset = cfg.activePreset;
            if (preset === 'rsi_plus_supertrend' || preset === 'rsi_reversal' || pos.strategy_used === 'Evil Panda') {
              // Sniper Technical Exit:
              // - Jika Trend Reversal (Bearish), WAJIB exit secepatnya untuk cut loss / lock profit.
              // - Jika Overbought (RSI), exit kalau profit >= 0.1%.
              const isSupertrendBearish = stTrend === 'BEARISH';
              if (taExit?.triggered || isSupertrendBearish) {
                const isReversal = isSupertrendBearish || taExit?.reason?.includes('Trend Flip') || taExit?.reason?.includes('Bearish');
                if (isReversal || pnlPct >= 0.1) {
                  proactiveCloseRecommended = true;
                  proactiveWarning = `🎯 TECHNICAL EXIT: ${taExit?.reason || 'Market Berubah Bearish'} (PnL: ${pnlPct.toFixed(2)}%).`;
                }
              }
            }

            if (!proactiveCloseRecommended && proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= bearishThreshold) {
              proactiveCloseRecommended = true;
              proactiveWarning = `⚠️ Profit ${pnlPct.toFixed(2)}% tapi market BEARISH (${(analysis.confidence * 100).toFixed(0)}% confidence). Rekomendasikan close untuk lock profit.`;
            } else if (!proactiveCloseRecommended && proactiveEnabled && isProfit && pnlPct >= minProfit && analysis.signal === 'BEARISH' && analysis.confidence >= 0.5) {
              proactiveWarning = `👀 Profit ${pnlPct.toFixed(2)}% — market mulai bearish (${(analysis.confidence * 100).toFixed(0)}% confidence). Monitor lebih ketat.`;
            }

            // ── Panic Dump Guard ──
            const isPanda   = pos.strategy_used === 'Evil Panda';

            // Panda Resilience: Only panic if Volume Dump CONFORMS with Bearish Trend.
            // If Bullish, we hold and accumulate (up to -40% SL).
            if (!proactiveCloseRecommended && hVolDelta < 0.40 && pnlPct < -1.5) {
               if (stTrend === 'BEARISH') {
                 proactiveCloseRecommended = true;
                 proactiveWarning = `🚨 PANIC DUMP CONFIRMED: Trend Bearish + Sell pressure ${(100 - hVolDelta * 100).toFixed(0)}%. Kabur total (PnL: ${pnlPct.toFixed(2)}%).`;
               } else if (!isPanda) {
                 // Non-Panda strategies might still want to cut earlier
                 proactiveCloseRecommended = true;
                 proactiveWarning = `🚨 PANIC DUMP DETECTED: Sell pressure ${(100-hVolDelta*100).toFixed(0)}%. Proactive close for safety (PnL: ${pnlPct.toFixed(2)}%).`;
               }
            }

            // ── Unified Stop Loss Guard (Maha Bersih v20) ──
            const strategyProfile = getStrategy(pos.strategy_used);
            const strategySl = strategyProfile?.exit?.emergencyStopLossPct;
            
            const slCheck = checkStopLoss({ ...pos, pnlPct }, strategySl);
            
            if (!proactiveCloseRecommended && slCheck.triggered) {
              proactiveCloseRecommended = true;
              proactiveWarning = `💀 EMERGENCY STOP LOSS: ${slCheck.reason}`;
            }

            // ── Hard Take Profit Guard (Sentinel v61) ──
            const strategyTp = strategyProfile?.exit?.takeProfitPct || 0;
            if (!proactiveCloseRecommended && strategyTp > 0 && pnlPct >= strategyTp) {
              proactiveCloseRecommended = true;
              proactiveWarning = `💰 HARD TAKE PROFIT: Keuntungan mencapai target ${strategyTp}% (PnL: ${pnlPct.toFixed(2)}%). Closing to lock profit and re-anchor.`;
            }
          } catch {
            // Market analysis optional
          }

          if (proactiveWarning) {
            await saveNotification('proactive_warning', proactiveWarning);
          }

          if (trailingTpHit) {
            await saveNotification('trailing_tp', `Trailing TP triggered: posisi ${addr.slice(0, 8)}... PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`);
          }

          return {
            ...pos,
            onChain:      match || null,
            outOfRangeMins,
            shouldClaimFee:        feeCollSol >= claimThreshold3Sol,
            shouldClaimFeeUrgent:  feeCollSol >= claimThreshold5Sol,
            feeCollectedSol:       feeCollSol,
            oorThresholdExceeded: (
              (outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes) ||
              (outOfRangeBins !== null && cfg.outOfRangeBinsToClose > 0 && outOfRangeBins >= cfg.outOfRangeBinsToClose)
            ),
            outOfRangeBins,
            pnlPct,
            pnlSol: snapshot.pnlSol,
            pnlSource: snapshot.pnlSource,
            lifecycleState: snapshot.lifecycleState,
            isProfit,
            trailingTpHit,
            peakPnl: tracker.peakPnl,
            trailingActive: tracker.trailingActive,
            marketSignal,
            proactiveCloseRecommended,
            proactiveWarning,
            smartMoney, // { smartLpCount, avgSmartEfficiency, isTrending, consensusRange }
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
      const { result: claimResult } = await executeControlledOperation({
        operationType: 'CLAIM_FEES',
        entityId: input.position_address,
        payload: input,
        metadata: { source: 'healer_tool', poolAddress: input.pool_address },
        execute: () => claimFees(input.pool_address, input.position_address),
      });

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah claim
      await new Promise(r => setTimeout(r, 3000));

      // Auto-swap fee tokens ke SOL setelah claim (retry 3x dengan backoff)
      const swapResults = [];
      const swapErrors  = [];
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            try {
              const swapRes = await withExponentialBackoff(
                () => swapAllToSOL(mint),
                { maxRetries: 3, baseDelay: 2000 }
              );
              if (swapRes.success) {
                swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
              } else {
                swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
              }
            } catch (e) {
              swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
            }
          }
        }
      } catch { /* swap best-effort */ }

      // Notifikasi jika swap gagal
      if (swapErrors.length > 0 && currentNotify) {
        currentNotify(
          `⚠️ *Auto-Swap Gagal (Claim Fees)*\n\n` +
          `Fee sudah di-claim, tapi token belum dikonversi ke SOL.\n` +
          `Error: ${swapErrors.map(e => e.error || e.mint).join(', ')}\n` +
          `_Lakukan swap manual di Jupiter/Meteora._`
        ).catch(() => {});
      }

      return JSON.stringify({
        ...claimResult,
        autoSwap:   swapResults.length > 0 ? swapResults : 'skipped',
        swapErrors: swapErrors.length  > 0 ? swapErrors  : undefined,
        reasoning:  input.reasoning,
      }, null, 2);
    }

    case 'close_position': {
      // Ambil PnL on-chain sebelum close untuk akurasi pencatatan
      let pnlData = { closeReason: (input.reasoning || 'AGENT_CLOSE').toUpperCase().replace(/ /g, '_') };
      try {
        const lpPnlMap = await getLpPnlMap();
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          const pnl = resolvePnlSnapshot({
            deployedSol,
            currentValueSol: currentVal,
            providerPnlPct: lpPnlMap.get(input.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
          });
          const solPriceUsd = await getSolPriceUsd().catch(() => 150);
          pnlData.pnlUsd  = parseFloat((pnl.pnlSol * solPriceUsd).toFixed(2));
          pnlData.pnlPct  = pnl.pnlPct;
          pnlData.pnlSol  = pnl.pnlSol;
          pnlData.feeUsd  = parseFloat(((match.feeCollectedSol ?? 0) * solPriceUsd).toFixed(2));
          pnlData.feeSol  = match.feeCollectedSol || 0;
        }
      } catch { /* best-effort, tetap close */ }

      await updatePositionLifecycle(input.position_address, 'closing');

      let closeResult;
      try {
        ({ result: closeResult } = await executeControlledOperation({
          operationType: 'CLOSE_POSITION',
          entityId: input.position_address,
          payload: { ...input, pnlData },
          metadata: { source: 'healer_tool', poolAddress: input.pool_address },
          execute: () => closePositionDLMM(input.pool_address, input.position_address, {
            ...pnlData,
            lifecycleState: 'closed_pending_swap',
          }),
        }));
      } catch (error) {
        if (getOpenPositions().some(p => p.position_address === input.position_address)) {
          await updatePositionLifecycle(input.position_address, 'open');
        }
        throw error;
      }
      clearPositionState(input.position_address);

      // Trigger Auto-Post-Mortem
      analyzeTradeResult({
        pool_address: input.pool_address,
        position_address: input.position_address,
        pnl_pct: pnlData.pnlPct || 0,
        pnl_usd: pnlData.pnlUsd || 0,
        strategy_used: pnlData.strategyUsed || 'EVIL_PANDA',
        close_reason: pnlData.closeReason || 'AGENT_CLOSE',
        range_efficiency_pct: 50, // default
      }, currentNotify).catch(e => console.error('Post-Mortem error:', e.message));

      // Record ke pool memory — best-effort, jangan gagalkan response jika throw
      try {
        await recordClose(input.pool_address, {
          pnlPct: pnlData.pnlPct || 0,
          reason:  pnlData.closeReason || 'AGENT_CLOSE',
        });
      } catch { /* best-effort */ }

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      // Auto-swap returned tokens ke SOL setelah close (retry 3x)
      const swapResults = [];
      const swapErrors  = [];
      let lifecycleState = 'closed_reconciled';
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            try {
              const swapRes = await withExponentialBackoff(
                () => swapAllToSOL(mint),
                { maxRetries: 3, baseDelay: 2000 }
              );
              if (swapRes.success) {
                swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
              } else {
                swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
              }
            } catch (e) {
              swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
            }
          }
        }
      } catch { /* swap best-effort */ }

      if (swapErrors.length > 0) lifecycleState = 'manual_review';
      await updatePositionLifecycle(input.position_address, lifecycleState);

      // Notifikasi swap + mulai post-close monitor
      if (currentNotify) {
        const totalSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          currentNotify(
            `🔄 *Auto-Swap Selesai*\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: \`+${totalSol.toFixed(4)} SOL\``
          ).catch(() => {});
        } else if (swapErrors.length > 0) {
          currentNotify(
            `⚠️ *Auto-Swap Gagal*\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: ${swapErrors.map(e => e.error || e.mint).join(', ')}\n` +
            `_Lakukan swap manual di Jupiter/Meteora._`
          ).catch(() => {});
        }
      }

      return JSON.stringify({
        ...closeResult,
        lifecycleState,
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
        const lpPnlMap = await getLpPnlMap();
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          const pnl = resolvePnlSnapshot({
            deployedSol,
            currentValueSol: currentVal,
            providerPnlPct: lpPnlMap.get(input.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
          });
          const solPriceUsd = await getSolPriceUsd().catch(() => 150);
          zapPnlData.pnlUsd = parseFloat((pnl.pnlSol * solPriceUsd).toFixed(2));
          zapPnlData.pnlPct = pnl.pnlPct;
          zapPnlData.pnlSol = pnl.pnlSol;
          zapPnlData.feeUsd = parseFloat(((match.feeCollectedSol ?? 0) * solPriceUsd).toFixed(2));
          zapPnlData.feeSol = match.feeCollectedSol || 0;
        }
      } catch { /* best-effort */ }

      await updatePositionLifecycle(input.position_address, 'closing');

      let closeResult;
      try {
        ({ result: closeResult } = await executeControlledOperation({
          operationType: 'ZAP_OUT',
          entityId: input.position_address,
          payload: { ...input, pnlData: zapPnlData },
          metadata: { source: 'healer_tool', poolAddress: input.pool_address },
          execute: () => closePositionDLMM(input.pool_address, input.position_address, {
            ...zapPnlData,
            lifecycleState: 'closed_pending_swap',
          }),
        }));
      } catch (error) {
        if (getOpenPositions().some(p => p.position_address === input.position_address)) {
          await updatePositionLifecycle(input.position_address, 'open');
        }
        throw error;
      }
      clearPositionState(input.position_address);

      // Trigger Auto-Post-Mortem
      analyzeTradeResult({
        pool_address: input.pool_address,
        position_address: input.position_address,
        pnl_pct: zapPnlData.pnlPct || 0,
        pnl_usd: zapPnlData.pnlUsd || 0,
        strategy_used: zapPnlData.strategyUsed || 'EVIL_PANDA',
        close_reason: 'ZAP_OUT',
        range_efficiency_pct: 50,
      }, currentNotify).catch(e => console.error('Zap Out Post-Mortem error:', e.message));

      // Record ke pool memory — best-effort, jangan gagalkan response jika throw
      try {
        await recordClose(input.pool_address, {
          pnlPct: zapPnlData.pnlPct || 0,
          reason:  zapPnlData.closeReason || 'ZAP_OUT',
        });
      } catch { /* best-effort */ }

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      const swapResults = [];
      const swapErrors  = [];
      let lifecycleState = 'closed_reconciled';
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (!mint || mint === SOL_MINT) continue;
          try {
            const swapRes = await withExponentialBackoff(
              () => swapAllToSOL(mint),
              { maxRetries: 3, baseDelay: 2000 }
            );
            if (swapRes.success) {
              swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol, txHash: swapRes.txHash });
            } else {
              swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
            }
          } catch (e) {
            swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
          }
        }
      } catch (e) {
        swapErrors.push({ error: e.message });
      }

      const totalSwappedSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);
      if (swapErrors.length > 0) lifecycleState = 'manual_review';
      await updatePositionLifecycle(input.position_address, lifecycleState);

      // Notifikasi hasil + mulai post-close monitor
      if (currentNotify) {
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          currentNotify(
            `⚡ *Zap Out Selesai*\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: \`+${totalSwappedSol.toFixed(4)} SOL\``
          ).catch(() => {});
        } else if (swapErrors.length > 0) {
          currentNotify(
            `⚠️ *Zap Out — Swap Gagal*\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: ${swapErrors.map(e => e.error || e.mint).join(', ')}\n` +
            `_Lakukan swap manual di Jupiter/Meteora._`
          ).catch(() => {});
        } else {
          // Semua di-skip (balance 0 — kemungkinan single-side SOL yang belum OOR)
          currentNotify(
            `✅ *Zap Out Selesai*\n\nPosisi ditutup. Semua dana sudah dalam bentuk SOL.`
          ).catch(() => {});
        }
      }

      return JSON.stringify({
        ...closeResult,
        zapOut: true,
        lifecycleState,
        swapResults,
        swapErrors: swapErrors.length > 0 ? swapErrors : null,
        totalSwappedSol: parseFloat(totalSwappedSol.toFixed(6)),
        reasoning: input.reasoning,
      }, null, 2);
    }

    case 'swap_to_sol': {
      const { result: swapResult } = await executeControlledOperation({
        operationType: 'SWAP_TO_SOL',
        entityId: input.token_mint,
        payload: input,
        metadata: { source: 'healer_tool' },
        execute: () => swapAllToSOL(input.token_mint),
      });
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
  const lpPnlMap = await getLpPnlMap();

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
      // Verifikasi via getAccountInfo dulu — onChain=[] bisa dari RPC glitch
      if (!match && Array.isArray(onChain)) {
        const stillExists = await positionAccountExists(pos.position_address);
        if (stillExists) {
          // Account masih ada — RPC glitch, bukan manual close → skip siklus ini
          continue;
        }
        await closePositionWithPnl(pos.position_address, {
          pnlUsd: 0, pnlPct: 0, feesUsd: 0, pnlSol: 0, feesSol: 0, closeReason: 'MANUAL_CLOSE', lifecycleState: 'closed_reconciled',
        });
        clearPositionState(pos.position_address);
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

      const _deployedSol   = pos.deployed_sol || 0;
      const _currentValSol = match.currentValueSol ?? 0;
      const snapshot = resolvePositionSnapshot({
        dbPosition: pos,
        livePosition: match,
        providerPnlPct: lpPnlMap.get(pos.position_address),
      });
      const pnlPct = snapshot.pnlPct;
      const pnlSol = snapshot.pnlSol;
      const addr   = pos.position_address;
      const runtimeState = getPositionRuntimeState(addr);
      const strategyProfile = getStrategy(pos.strategy_used || '');
      const positionAgeMin = getPositionAgeMinutes(pos);
      const exitMode = strategyProfile?.exit?.mode || 'default';
      const trailCfg = getTrailingConfig();
      const strategyTakeProfitPct = strategyProfile?.exit?.takeProfitPct ?? thresholds.takeProfitFeePct;
      const strategyTriggerPct = strategyProfile?.exit?.trailingTriggerPct ?? trailCfg.activatePct;
      const strategyDropPct = strategyProfile?.exit?.trailingDropPct ?? trailCfg.dropPct;
      const emergencyStopLossPct = strategyProfile?.exit?.emergencyStopLossPct ?? thresholds.stopLossPct;

      // ── Trailing TP state ────────────────────────────────────
      let tracker = {
        peakPnl: runtimeState.peakPnlPct ?? pnlPct,
        trailingActive: runtimeState.trailingActive === true,
      };
      if (pnlPct > tracker.peakPnl) tracker.peakPnl = pnlPct;
      if (!tracker.trailingActive && pnlPct >= strategyTriggerPct) tracker.trailingActive = true;
      const trailingTpHit = tracker.trailingActive && (tracker.peakPnl - pnlPct) >= strategyDropPct;
      updatePositionRuntimeState(addr, {
        peakPnlPct: tracker.peakPnl,
        trailingActive: tracker.trailingActive,
      });

      const slTriggered = pnlPct <= -Math.abs(emergencyStopLossPct);
      const slCheck = {
        triggered: slTriggered,
        reason: `PnL ${pnlPct.toFixed(2)}% <= emergency stop loss -${Math.abs(emergencyStopLossPct).toFixed(2)}%`,
      };
      const tpHit   = pnlPct >= strategyTakeProfitPct;

      const supportBreakForWave = pos.strategy_used === 'Wave Enjoyer' && !match.inRange;
      const npcTooOld = pos.strategy_used === 'NPC'
        && strategyProfile?.exit?.holdMaxMinutes
        && positionAgeMin >= strategyProfile.exit.holdMaxMinutes;
      const waveReadyForReview = pos.strategy_used === 'Wave Enjoyer'
        && positionAgeMin >= (strategyProfile?.exit?.holdMinMinutes || 10);
      const npcReadyForReview = pos.strategy_used === 'NPC'
        && positionAgeMin >= (strategyProfile?.exit?.holdMinMinutes || 30);

      const strategyTriggerHit = supportBreakForWave || npcTooOld;

      // Tidak ada trigger → flag apakah posisi ini butuh LLM, lalu skip
      if (!trailingTpHit && !tpHit && !slCheck.triggered && !strategyTriggerHit) {
        // Posisi butuh LLM jika: out of range, fees tinggi, atau mendekati SL
        if (!match?.inRange) _healerNeedsLLM = true;
        const feePct = (match?.feeCollectedSol || 0) / (pos.deployed_sol || 0.001);
        if (feePct >= 0.03) _healerNeedsLLM = true;
        if (pnlPct <= -(thresholds.stopLossPct * 0.6)) _healerNeedsLLM = true;
        if (waveReadyForReview || npcReadyForReview) _healerNeedsLLM = true;
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

      if (exitMode === 'evil_panda_confluence' && sig === 'BULLISH' && conf >= 0.5) {
        decision = 'HOLD';
        holdReason = 'Evil Panda menunggu konfirmasi bearish sebelum exit.';
      }

      if (exitMode === 'retracement_scalp' && supportBreakForWave) {
        decision = 'CLOSE';
      }

      if (exitMode === 'post_spike_consolidation' && npcTooOld) {
        decision = 'CLOSE';
      }

      if (trailingTpHit) {
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
        // SNIPER REBIRTH: Mode trend_confirmed won't SL if trend is still BULLISH
        const needsTrendConf = exitMode === 'evil_panda_confluence' || exitMode === 'trend_confirmed';
        if (needsTrendConf && sig === 'BULLISH') {
          decision = 'HOLD';
          holdReason = `Strategy Aware: Tren masih BULLISH — nunggu recovery di jaring Panda.`;
        } else if (sig === 'BULLISH' && conf >= 0.65) {
          decision   = 'HOLD';
          holdReason = `Chart masih BULLISH (${(conf * 100).toFixed(0)}% conf) — hold untuk recovery`;
        }
      } else if (!match?.inRange) {
        // Logika Adaptive OOR
        if (market?.oorDecision === 'EXTEND' && (outOfRangeMins || 0) < 60) {
          decision   = 'HOLD';
          holdReason = `Adaptive OOR: Chart BULLISH, nunggu re-entry (${outOfRangeMins}/60m max)`;
        } else if (market?.oorDecision === 'PANIC_EXIT') {
          decision   = 'CLOSE';
          _healerNotifyFn?.(`🚨 *PANIC EXIT* @ ${pos.pool_address.slice(0, 8)}\nOOR + Bearish Breakdown detected (conf ${(market.confidence * 100).toFixed(0)}%).`).catch(() => {});
        } else if (outOfRangeMins >= thresholds.outOfRangeWaitMinutes) {
          decision   = 'CLOSE';
        } else {
          decision   = 'HOLD';
          holdReason = `Menunggu timer OOR standard (${outOfRangeMins}/${thresholds.outOfRangeWaitMinutes}m)`;
        }
      }

      // Tentukan label + emoji
      const triggerLabel = supportBreakForWave               ? 'Wave Support Break'
        : npcTooOld                         ? 'NPC Time Exit'
        : trailingTpHit                     ? 'Trailing Take Profit'
        : tpHit                             ? 'Take Profit'
        : 'Stop-Loss';
      const triggerEmoji = supportBreakForWave               ? '🌊'
        : npcTooOld                         ? '🧠'
        : trailingTpHit                     ? '🎯'
        : tpHit                             ? '💰'
        : '🛑';
      const triggerReason = supportBreakForWave
        ? `Wave Enjoyer support invalidated setelah ${positionAgeMin}m`
        : npcTooOld
        ? `NPC telah melewati hold window ${strategyProfile?.exit?.holdMaxMinutes}m`
        : trailingTpHit
        ? `PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`
        : tpHit
        ? `PnL ${pnlPct.toFixed(2)}% ≥ target ${strategyTakeProfitPct}%`
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
        kv('Umur',     `${positionAgeMin}m`, W),
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
        updatePositionRuntimeState(addr, {
          peakPnlPct: tracker.peakPnl,
          trailingActive: tracker.trailingActive,
        });
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
        const solPriceUsd = await getSolPriceUsd().catch(() => 150);
        const realizedPnlUsd = parseFloat((pnlSol * solPriceUsd).toFixed(2));
        const realizedFeesUsd = parseFloat((((match.feeCollectedSol || 0) * solPriceUsd)).toFixed(2));
        await updatePositionLifecycle(addr, 'closing');
        await closePositionDLMM(pos.pool_address, addr, {
          pnlUsd:      realizedPnlUsd,
          pnlPct,
          feeUsd:      realizedFeesUsd,
          pnlSol:      pnlSol,
          feeSol:      match.feeCollectedSol || 0,
          closeReason: triggerLabel.toUpperCase().replace(/ /g, '_'),
          lifecycleState: 'closed_pending_swap',
        });
        clearPositionState(addr);

        // DB updates — best-effort: jangan kirim "❌ Gagal close" kalau ini yang throw
        try { await recordPnlUsd(realizedPnlUsd); } catch { /* best-effort */ }
        try {
          await recordClose(pos.pool_address, {
            pnlPct: pnlPct,
            reason: triggerLabel.toUpperCase().replace(/ /g, '_'),
          });
        } catch { /* best-effort */ }

        // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
        await new Promise(r => setTimeout(r, 3000));

        // Auto-swap token → SOL (retry 3x dengan backoff)
        const swapMsgs  = [];
        const swapFails = [];
        let totalSwappedSol = 0;
        let lifecycleState = 'closed_reconciled';
        try {
          const poolInfo = await getPoolInfo(pos.pool_address);
          for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
            if (mint && mint !== SOL_MINT) {
              for (let swapAttempt = 1; swapAttempt <= 3; swapAttempt++) {
                try {
                  const isPanic = getSafetyStatus().drawdownPct > 10; const swapRes = await swapAllToSOL(mint, isPanic ? 500 : 100);
                  if (swapRes.success) {
                    swapMsgs.push(`+${swapRes.outSol.toFixed(4)}◎`);
                    totalSwappedSol += swapRes.outSol;
                  }
                  break;
                } catch (e) {
                  if (swapAttempt === 3) swapFails.push(e.message);
                  else await new Promise(r => setTimeout(r, 2000 * swapAttempt));
                }
              }
            }
          }
        } catch { /* swap best-effort */ }
        if (swapFails.length > 0) lifecycleState = 'manual_review';
        await updatePositionLifecycle(addr, lifecycleState);

        // Notifikasi swap + selalu mulai 5-menit monitor
        if (swapMsgs.length > 0) {
          await notifyFn?.(
            `🔄 *Auto-Swap Selesai*\n\nToken → SOL: ${swapMsgs.join(', ')}\nTotal: \`+${totalSwappedSol.toFixed(4)} SOL\``
          );
        } else if (swapFails.length > 0) {
          await notifyFn?.(
            `⚠️ *Auto-Swap Gagal*\n\nPosisi ditutup, tapi token belum dikonversi ke SOL.\nError: ${swapFails.join(', ')}\n_Swap manual di Jupiter/Meteora._`
          );
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
            const st       = calculateSupertrend(highs, lows, closes, 10, 3);
            const rsi14Val = calculateRSI(closes, 14);
            const last96   = epCandles.slice(-96);
            const low24h   = Math.min(...last96.map(c => c.l));
            const curPrice = closes[closes.length - 1];
            const distPct  = low24h > 0 ? ((curPrice - low24h) / low24h) * 100 : 99;

            // Check re-entry conditions
            if (st?.isBullish && distPct >= 0 && distPct <= 12 && rsi14Val >= 35 && rsi14Val <= 65) {
              // Strategy alert silenced (Supertrend Bullish info available in logs)
            }
          }
        } catch { /* best-effort, jangan crash */ }
      } catch (e) {
        if (getOpenPositions().some(p => p.position_address === addr)) {
          await updatePositionLifecycle(addr, 'open');
        }
        await notifyFn?.(`❌ Gagal close ${triggerLabel}: ${e.message}`);
      }
    } catch { /* skip jika gagal fetch */ }
  }

  // ── 7. Aegis Phase 4: Automatic Technical Sweep ─────────
  // Obelisk: Parallelized sweep for near-instant reaction time
  // Obelisk: Parallelized sweep for near-instant reaction time
  const openPositionsRel = getOpenPositions();
  if (openPositionsRel.length > 0) {
    await Promise.all(openPositionsRel.map(async (pos) => {
      try {
        const addr = pos.position_address;
        const analysis = await analyzeMarket(pos.token_x, pos.pool_address, { pnlPct: 0 });
        const snapshot = analysis?.snapshot;
        const ta = snapshot?.ta?.['Evil Panda'] || snapshot?.ta?.[pos.strategy_used];
        
        if (ta?.exit?.triggered) {
          console.log(`[healer] AEGIS PRIORITY EXIT: Technical trigger for ${addr.slice(0,8)} - Reason: ${ta.exit.reason}`);
          const triggerLabel = ta.exit.shadowExit ? 'SHADOW EXIT' : 'TECHNICAL EXIT';
          const triggerReason = ta.exit.reason || 'Confluence reached';

          await notifyFn?.(`🦅 *AEGIS GUARD* — ${triggerLabel}\n\nPosition: \`${addr.slice(0, 8)}\`\nReason: ${triggerReason}\n_Executing immediate liquidation..._`);
          
          await closePositionDLMM(pos.pool_address, addr, {
            closeReason: triggerLabel,
            lifecycleState: 'closed_pending_swap'
          });
          clearPositionState(addr);
        }
      } catch (e) {
        console.warn(`[healer] Technical sweep failed for ${pos.position_address.slice(0,8)}:`, e.message);
      }
    }));
  }

  // Refresh after sweep
  if (getOpenPositions().length === 0) return null;

  const safety   = getSafetyStatus();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();

  const trailCfgForPrompt = getTrailingConfig();
  const systemPrompt = `Kamu adalah Healer Alpha — autonomous position management agent untuk Meteora DLMM.

CATATAN: Stop-loss, Take Profit, Trailing TP, Evil Panda Exit, Multi-TF Exit, dan Fib Resistance Exit
sudah diproses di pre-flight dengan mempertimbangkan kondisi LP.
Posisi yang sampai di loop ini = belum di-close oleh pre-flight (masih aman atau chart bilang HOLD).
Fokus kamu: LP IDENTITY - maksimalkan FEE extraction, jangan panik saat pullback di market bullish.

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

    OUT OF RANGE (LP Identity Protocol):
    - Jika Tren Global = BULLISH → Tahan posisi (HOLD) meskipun OOR atau Supertrend 15m Bearish. Ini adalah fase penyerapan fee dari seller.
    - marketSignal.oorDecision === 'PANIC_EXIT' DAN Tren Global = BEARISH → EXIT SEGERA (Zap Out).
    - Jika posisi OOR tapi Fee APR > 100% → BERTAHAN (Fee extraction is priority).
    - Jangan ZAP_OUT hanya karena retracement teknikal jika trend harian masih kuat.

    ALGORITMA ADAPTIF (PnL vs Fees):
    - Jika PnL Negatif (-1 s/d -5%) tapi Fee Velocity "meningkat" → BERTAHAN (Fees akan menutup kerugian).
    - Jika PnL Negatif dan Fee Velocity "menurun" → CUT LOSS (Meninggalkan kolam yang mati).
    - Jika PnL Positif (>5%) dan RSI2 < 80 → BERTAHAN (Let the profit run).

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

3. Berikan reasoning lengkap untuk setiap keputusan.
   ⚠️ JANGAN panggil swap_to_sol setelah close_position atau zap_out — sudah ditangani otomatis di dalam tool.

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

  // Obelisk: Healer Silence — Skip LLM if all positions are "Perfectly Fine"
  let needsDeliberation = false;
  const currentPositions = getOpenPositions();
  for (const pos of currentPositions) {
    try {
      const analysis = await analyzeMarket(pos.token_x, pos.pool_address, { inRange: true, pnlPct: 0 });
      const snap = analysis?.snapshot;
      const ta = snap?.ta?.['Evil Panda'] || snap?.ta?.[pos.strategy_used];
      
      const isOOR = !snap?.inRange;
      const isLowFees = (snap?.unclaimedFeesUsd || 0) < (pos.deployed_capital * 0.03); 
      const isHealthyPnL = (analysis?.pnlPct || 0) > -2.0;

      if (isOOR || !isHealthyPnL || !isLowFees || ta?.supertrend?.trend === 'BEARISH') {
        needsDeliberation = true;
        break;
      }
    } catch { needsDeliberation = true; break; }
  }

  if (!needsDeliberation && currentPositions.length > 0) {
    console.log(`[healer] HEALER SILENCE: Semua posisi sehat (${currentPositions.length}). Melewati pemanggilan LLM untuk menghemat biaya API.`);
    return null; 
  }

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
  const MAX_ROUNDS = 20;
  let rounds = 0;

  while (response.stop_reason === 'tool_use' && rounds < MAX_ROUNDS) {
    rounds++;
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

  if (rounds >= MAX_ROUNDS && notifyFn) {
    await notifyFn(`⚠️ *Healer Alpha* — batas ${MAX_ROUNDS} putaran tercapai, loop dihentikan paksa.`);
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
