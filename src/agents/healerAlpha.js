'use strict';

import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds, isDryRun } from '../config.js';
import { getPositionInfo, closePositionDLMM, claimFees, getPoolInfo, getSolPriceUsd, getAllWalletPositions, addLiquidityToPosition, getPositionFeeInfo } from '../solana/meteora.js';
import { getConnection, getWallet, getWalletBalance } from '../solana/wallet.js';
import { PublicKey } from '@solana/web3.js';
import { getOpenPositions, closePositionWithPnl, saveNotification, updatePositionLifecycle, savePosition, updateLivePositionStats, updatePositionPeakPnl, recordFeesClaimed, recordPnlDivergenceEvent } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { checkStopLoss, checkMaxDrawdown, recordPnlUsd, getSafetyStatus } from '../safety/safetyManager.js';
import { analyzeMarket } from '../market/analyst.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { swapAllToSOL, SOL_MINT } from '../solana/jupiter.js';
import { getMarketSnapshot, getOHLCV } from '../market/oracle.js';
import { fetchWithTimeout, withExponentialBackoff, stringify, getConservativeSlippage, escapeHTML } from '../utils/safeJson.js';
import { withRetry as executionRetry } from '../utils/retry.js';
import { kv, hr, codeBlock, formatPnl, shortAddr, shortStrat } from '../utils/table.js';
import { recordClose } from '../market/poolMemory.js';
import { executeControlledOperation } from '../app/executionService.js';
import { getWalletPositions, isLPAgentEnabled, getPoolSmartMoney } from '../market/lpAgent.js';
import { resolvePnlSnapshot } from '../app/pnl.js';
import { clearPositionRuntimeState, getPositionRuntimeState, updatePositionRuntimeState } from '../app/positionRuntimeState.js';
import { resolvePositionSnapshot } from '../app/positionSnapshot.js';
import { getStrategy } from '../strategies/strategyManager.js';
import { analyzeTradeResult } from '../learn/failureAnalysis.js';
import { getGmgnSecurity } from '../utils/gmgn.js';
import { recordExitEvent, recordCircuitBreakerEvent } from '../db/exitTracking.js';
import { recordStrategyPerformance } from '../market/strategyLibrary.js';
import { getRuntimeState, setRuntimeState, flushRuntimeState } from '../runtime/state.js';



// ─── T1.3 Concurrency guard ───────────────────────────────────────
// Prevents two healer cycles from closing the same position concurrently.
// A second cycle that races to close the same address finds it in this set
// and skips, avoiding double-close errors and nonce conflicts.
const _closingInProgress = new Set();

function acquireClose(addr) {
  if (_closingInProgress.has(addr)) return false;
  _closingInProgress.add(addr);
  return true;
}

function releaseClose(addr) {
  _closingInProgress.delete(addr);
}

// Verifikasi apakah position account benar-benar tidak ada on-chain.
// Dipakai sebelum mark MANUAL_CLOSE — cegah false positive dari RPC glitch.
async function positionAccountExists(positionAddress) {
  try {
    const info = await getConnection().getAccountInfo(new PublicKey(positionAddress));
    return info !== null;
  } catch (e) {
    console.warn(`[healer] positionAccountExists check failed for ${positionAddress?.slice(0, 8)}: ${e?.message} — assuming exists`);
    return true; // gagal cek → asumsikan masih ada (safe default)
  }
}

function shouldEscalateSkippedSwap(swapRes) {
  if (!swapRes || swapRes.success) return false;
  const reason = String(swapRes.reason || '').toUpperCase();
  // ZERO_BALANCE berarti memang tidak ada token untuk diswap → state bisa dianggap reconcile.
  if (reason === 'ZERO_BALANCE') return false;
  // Reason kosong atau reason lain (PRICE_UNSTABLE, SWAP_FAILED, dst) dianggap unresolved.
  return true;
}

function computePoolEfficiency(volume24h, tvl) {
  if (!tvl || tvl <= 0) return { score: 0, label: 'Unknown' };
  const score = volume24h / tvl;
  const label = score > 2.0 ? 'Excellent' : score > 1.0 ? 'Good' : score > 0.2 ? 'Weak' : 'Zombie';
  return { score, label };
}

function auditPnlDivergence(event, metadata = null) {
  if (!event || !Number.isFinite(event?.divergencePct)) return;
  recordPnlDivergenceEvent({
    ...event,
    metadata,
  }).catch(() => {});
}

async function closeAndRecordExitAtomic({
  pos,
  posSnapshot,
  pnlPct,
  exitPrice,
  zone = 'UNKNOWN',
  feeRatio = 0,
  isFeeVelocityIncreasing = false,
  isLPerPatienceEnabled = false,
  exitTrigger,
  exitReason,
  closeReasonCode,
  lifecycleState = 'closed_panic',
  isUrgent = true,
  extra = {},
}) {
  const closeResult = await closePositionDLMM(pos.pool_address, pos.position_address, {
    pnlUsd: posSnapshot.pnlUsd,
    pnlPct: posSnapshot.pnlPct,
    feesUsd: posSnapshot.feesUsd,
    closeReason: closeReasonCode,
    lifecycleState,
  }, { isUrgent });

  if (closeResult?.success || closeResult?.alreadyClosed) {
    recordExitEvent({
      positionAddress: pos.position_address,
      poolAddress: pos.pool_address,
      tokenMint: pos.token_mint,
      entryTime: pos.created_at,
      entryPrice: pos.entry_price || 0,
      exitTime: new Date().toISOString(),
      exitPrice,
      holdMinutes: Math.floor((Date.now() - new Date(pos.created_at)) / 60000),
      pnlPct,
      pnlUsd: posSnapshot.pnlUsd,
      feesClaimedUsd: posSnapshot.feesUsd,
      totalReturnUsd: (posSnapshot.pnlUsd || 0) + (posSnapshot.feesUsd || 0),
      exitTrigger,
      exitZone: zone || 'UNKNOWN',
      exitRetracement: Number.isFinite(extra.exitRetracement) ? extra.exitRetracement : 0,
      exitRetracementCap: Number.isFinite(extra.exitRetracementCap) ? extra.exitRetracementCap : 0,
      feeRatioAtExit: feeRatio || 0,
      feeVelocityIncreasing: isFeeVelocityIncreasing ? 1 : 0,
      lperPatienceActive: isLPerPatienceEnabled ? 1 : 0,
      profitOrLoss: pnlPct > 0 ? 'PROFIT' : pnlPct < 0 ? 'LOSS' : 'BREAKEVEN',
      exitReason,
      closeReasonCode,
    });
    await recordPoolCloseOutcome(pos.pool_address, pnlPct, closeReasonCode, pos.strategy_used);
  }

  return closeResult;
}

function toStrategyId(strategyName) {
  if (!strategyName) return null;
  return String(strategyName).toLowerCase().replace(/\s+/g, '_');
}

async function recordPoolCloseOutcome(poolAddress, pnlPct, reason, strategyUsed = null) {
  await executionRetry(
    () => recordClose(poolAddress, { pnlPct, reason }),
    { maxRetries: 2, delayMs: 500 }
  );

  const strategyId = toStrategyId(strategyUsed);
  if (strategyId) {
    try {
      recordStrategyPerformance(strategyId, {
        poolAddress,
        pnlPct,
        profitable: pnlPct > 0,
        closeReason: reason,
      });
    } catch (e) {
      console.warn('[healer] recordStrategyPerformance failed:', e?.message);
    }
  }
}

/**
 * 👻 GHOST POSITION RECOVERY (Layer 7 Self-Healing)
 * Memastikan database sinkron dengan data riil di blockchain.
 */
export async function runSelfHealingSync(notifyFn = null) {
  console.log('🔍 [healer] Memulai audit Self-Healing (Blockchain vs Database)...');
  
  try {
    const onChainPositions = await getAllWalletPositions();
    if (!onChainPositions) {
      console.warn('⚠️ [healer] Gagal fetch posisi on-chain, skip audit self-healing.');
      return;
    }

    const dbPositions = await getOpenPositions();
    const dbAddresses = new Set(dbPositions.map(p => p.position_address));

    let reclaimedCount = 0;
    for (const ocPos of onChainPositions) {
      if (!ocPos.address) continue;
      
      if (!dbAddresses.has(ocPos.address)) {
        console.log(`👻 [healer] GHOST DETECTED: ${ocPos.address.slice(0, 8)}... di pool ${ocPos.poolAddress.slice(0, 8)}...`);
        
        try {
          const poolInfo = await getPoolInfo(ocPos.poolAddress);
          
          await savePosition({
            pool_address: ocPos.poolAddress,
            position_address: ocPos.address,
            token_x: poolInfo.tokenX,
            token_y: poolInfo.tokenY,
            token_x_symbol: poolInfo.tokenXSymbol,
            token_y_symbol: poolInfo.tokenYSymbol,
            token_x_amount: '0', 
            token_y_amount: '0',
            deployed_sol: ocPos.currentValueSol, 
            deployed_usd: 0, 
            entry_price: poolInfo.displayPrice,
            strategy_used: 'RECLAIMED_GHOST',
            lifecycle_state: 'active'
          });

          reclaimedCount++;
          await notifyFn?.(`👻 <b>GHOST POSITION RECLAIMED!</b>\n\n• Pool: <code>${shortAddr(ocPos.poolAddress)}</code>\n• Address: <code>${shortAddr(ocPos.address)}</code>\n• Value: ~${ocPos.currentValueSol.toFixed(4)} SOL\n\n<i>Bot berhasil mensinkronisasi ulang posisi gaib ke database.</i>`, { parse_mode: 'HTML' });
        } catch (err) {
          console.error(`❌ [healer] Gagal reclaim posisi ${ocPos.address}:`, err.message);
        }
      }
    }

    if (reclaimedCount > 0) {
      console.log(`✅ [healer] Audit selesai. Berhasil menjemput ${reclaimedCount} posisi gaib.`);
    } else {
      console.log('✅ [healer] Audit selesai. Database dan Blockchain sudah sinkron.');
    }
  } catch (error) {
    console.error('❌ [healer] Self-Healing Sync Error:', error.message);
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
            onPnlDivergence: (event) => auditPnlDivergence(event, { scope: 'execute_tool_get_all_positions' }),
          });

          // 📊 LP-IDENTITY: Real-time IL & HODL Analysis (SOL Denominated)
          const entryPriceVal = parseFloat(pos.entry_price || 0);
          const currentPriceVal = parseFloat(match?.displayPrice || snapshot.price || 0);
          const initialSol = parseFloat(pos.deployed_sol || 0);
          
          // Benchmarking: Berapa SOL kita punya kalau cuma HODL koin (pumping gain)?
          const priceChangeRatio = (entryPriceVal > 0 && currentPriceVal > 0) ? (currentPriceVal / entryPriceVal) : 1;
          const hodlValueSol = initialSol * priceChangeRatio;
          
          // Berapa SOL kita punya sekarang (LP Value + Fees)?
          const currentTotalUsd = parseFloat(snapshot.pnlUsd || 0) + (initialSol * entryPriceVal);
          const lpValueInSol = currentPriceVal > 0 ? (currentTotalUsd / currentPriceVal) : initialSol;
          
          const yieldVsHodlSol = hodlValueSol > 0 ? (lpValueInSol / hodlValueSol) - 1 : 0;
          const netLpProfitSol = lpValueInSol - initialSol;

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
            peakPnl: runtimeState.healerPeakPnl ?? pnlPct,
            trailingActive: runtimeState.healerTrailingActive === true,
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
            healerPeakPnl: tracker.peakPnl,
            healerTrailingActive: tracker.trailingActive,
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
            const strategyProfile   = getStrategy(pos.strategy_used);
            const isEvilPandaMode   = strategyProfile?.exit?.mode === 'evil_panda_confluence' || pos.strategy_used === 'Evil Panda';
            const disableTrendKillSwitch = isEvilPandaMode && cfg.evilPandaDisableTrendKillSwitch !== false;
            const bypassToxicIlGuard = isEvilPandaMode && cfg.evilPandaBypassToxicIlGuard !== false;
            
            // ── Technical Sniper Exit (Evil Panda / Supertrend) ──────
            const taExit = analysis.snapshot?.ta?.['Evil Panda']?.exit || analysis.snapshot?.ta?.[pos.strategy_used]?.exit;
            if (!disableTrendKillSwitch && isEvilPandaMode) {
              // Sniper Technical Exit:
              // - Jika Trend Reversal (Bearish), WAJIB exit secepatnya untuk cut loss / lock profit.
              const isSupertrendBearish = stTrend === 'BEARISH';
              if (taExit?.triggered || isSupertrendBearish) {
                const isReversal = isSupertrendBearish || taExit?.reason?.includes('Trend Flip') || taExit?.reason?.includes('Bearish');
                if (isReversal) {
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
            const strategySl = strategyProfile?.exit?.emergencyStopLossPct;
            
            const slCheck = checkStopLoss({ ...pos, pnlPct }, strategySl);
            
            if (!proactiveCloseRecommended && slCheck.triggered) {
              proactiveCloseRecommended = true;
              proactiveWarning = `💀 EMERGENCY STOP LOSS: ${slCheck.reason}`;
            }

            // ── Hard Take Profit Guard (Sentinel v61) ──
            const configuredTp = Number(strategyProfile?.exit?.takeProfitPct ?? getConfig().takeProfitFeePct);
            const strategyTp = Number.isFinite(configuredTp) && configuredTp > 0 ? configuredTp : 5.0;
            if (!proactiveCloseRecommended && strategyTp > 0 && pnlPct >= strategyTp) {
              const liveFeeApr = analysis.snapshot?.pool?.feeApr ?? 0;
              if (liveFeeApr > 100) {
                console.log(`[healer] Hard TP deferred — Fee APR ${liveFeeApr.toFixed(1)}% > 100% (fee machine productive). PnL: ${pnlPct.toFixed(2)}%`);
              } else {
                proactiveCloseRecommended = true;
                proactiveWarning = `💰 HARD TAKE PROFIT: Keuntungan mencapai target ${strategyTp}% (PnL: ${pnlPct.toFixed(2)}%). Closing to lock profit and re-anchor.`;
              }
            }
            // ── Toxic IL Safeguard (Aegis v1.0) ──
            const cfgIlLimitPct = Math.abs(Number(getConfig().maxILvsHodlPct ?? 5));
            const toxicIlThreshold = -(cfgIlLimitPct / 100); // configurable, default -5% Yield vs HODL
            if (!proactiveCloseRecommended && !bypassToxicIlGuard && yieldVsHodlSol <= toxicIlThreshold && pnlPct < -2) {
              proactiveCloseRecommended = true;
              proactiveWarning = `🤢 TOXIC IL DETECTED: Yield vs HODL is ${(yieldVsHodlSol * 100).toFixed(2)}% (limit -${cfgIlLimitPct.toFixed(2)}%). LP is bleeding relative to HODL. Exiting to preserve capital.`;
            }

            // ── TVL Drain Defense (absolute entryTvl-based panic exit) ──
            // Stores TVL snapshot at first observation as entryTvl in runtimeState.
            // Panics if TVL has drained more than cfg.tvlDropPanicThreshold from that baseline.
            const currentTvl = analysis.snapshot?.pool?.tvl || 0;
            if (currentTvl > 0) {
              const entryTvl = runtimeState.entryTvl || currentTvl;
              if (!runtimeState.entryTvl) {
                updatePositionRuntimeState(addr, { entryTvl: currentTvl });
              }
              const panicThreshold = cfg.tvlDropPanicThreshold ?? 0.5;
              const tvlDropRatio = entryTvl > 0 ? (entryTvl - currentTvl) / entryTvl : 0;
              if (!proactiveCloseRecommended && tvlDropRatio >= panicThreshold) {
                proactiveCloseRecommended = true;
                proactiveWarning = `🚨 PANIC_EXIT_TVL_DRAIN: TVL crashed ${(tvlDropRatio * 100).toFixed(1)}% from entry ` +
                  `(${entryTvl.toFixed(0)} → ${currentTvl.toFixed(0)}). Possible rug/pool exodus. Emergency exit!`;
              }
            }

          } catch (e) {
            console.warn(`⚠️ [healer] Aegis check failed for ${addr.slice(0,8)}: ${escapeHTML(e.message)}`);
          }

          if (proactiveWarning) {
            await saveNotification('proactive_warning', proactiveWarning);
          }

          if (trailingTpHit) {
            if (runtimeState.healerTrailingTpNotified !== true) {
              await saveNotification('trailing_tp', `Trailing TP triggered: posisi ${addr.slice(0, 8)}... PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`);
              updatePositionRuntimeState(addr, { healerTrailingTpNotified: true });
            }
          } else if (runtimeState.healerTrailingTpNotified === true) {
            updatePositionRuntimeState(addr, { healerTrailingTpNotified: false });
          }

          // 🐼 LIVE DB SYNC: Update stats even while open for Live Dashboard
          try {
            await updateLivePositionStats(pos.position_address, {
              pnlUsd: pnlUsd,
              pnlPct: pnlPct,
              feesUsd: feesUsd,
              pnlSol: snapshot.pnlSol,
              feesSol: feeCollSol
            });
          } catch (dbErr) {
            console.warn(`⚠️ [healer] Live DB Sync failed for ${addr.slice(0,8)}: ${dbErr.message}`);
          }

          return {
            ...pos,
            onChain:      match || null,
            outOfRangeMins,
            shouldClaimFee:        feeCollSol >= claimThreshold3Sol,
            shouldClaimFeeUrgent:  feeCollSol >= claimThreshold5Sol,
            feeCollectedSol:       feeCollSol,
            yieldVsHodlSol:       (yieldVsHodlSol * 100).toFixed(2) + '%',
            netLpProfitSol:       netLpProfitSol.toFixed(4) + ' SOL',
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
            ...(() => {
              const _poolTvl = analysis?.snapshot?.pool?.tvl || 0;
              const _poolVol = analysis?.snapshot?.pool?.volume24h || 0;
              const _eff = computePoolEfficiency(_poolVol, _poolTvl);
              return { efficiencyScore: _eff.score, efficiencyLabel: _eff.label };
            })(),
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
        const snapshot = await getMarketSnapshot(input.token_mint, input.pool_address);
        const vol      = snapshot?.price?.volatility24h || 0;
        const slippage = getConservativeSlippage(vol);

        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            try {
              const swapRes = await withExponentialBackoff(
                () => swapAllToSOL(mint, slippage),
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
          `⚠️ <b>Auto-Swap Gagal (Claim Fees)</b>\n\n` +
          `Fee sudah di-claim, tapi token belum dikonversi ke SOL.\n` +
          `Error: <code>${escapeHTML(swapErrors.map(e => e.error || e.mint).join(', '))}</code>\n\n` +
          `<i>Lakukan swap manual di Jupiter/Meteora.</i>`
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
      let closeStrategyUsed = null;
      try {
        const lpPnlMap = await getLpPnlMap();
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          closeStrategyUsed = dbPos?.strategy_used || null;
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          const pnl = resolvePnlSnapshot({
            deployedSol,
            currentValueSol: currentVal,
            providerPnlPct: lpPnlMap.get(input.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
            positionAddress: input.position_address,
            poolAddress: input.pool_address,
            tokenMint: dbPos?.token_mint || dbPos?.token_x || null,
            onDivergence: (event) => auditPnlDivergence(event, { scope: 'execute_tool_close_position' }),
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
          execute: () => {
            const reason = pnlData.closeReason || '';
            const isUrgentClose = reason.includes('STOP_LOSS') || reason.includes('PANIC') || reason.includes('EMERGENCY');
            return closePositionDLMM(input.pool_address, input.position_address, {
              ...pnlData,
              lifecycleState: 'closed_pending_swap',
            }, { isUrgent: isUrgentClose });
          },
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

      // Record ke pool memory + strategy performance — best-effort
      try {
        await recordPoolCloseOutcome(
          input.pool_address,
          pnlData.pnlPct || 0,
          pnlData.closeReason || 'AGENT_CLOSE',
          closeStrategyUsed || pnlData.strategyUsed || null,
        );
      } catch (e) {
        console.warn('[healer] recordPoolCloseOutcome failed:', e?.message);
      }

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      // Auto-swap returned tokens ke SOL setelah close (retry 3x)
      const swapResults = [];
      const swapErrors  = [];
      const unresolvedSwapSkips = [];
      let lifecycleState = 'closed_reconciled';
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        const snapshot = await getMarketSnapshot(poolInfo.tokenX, input.pool_address);
        const vol      = snapshot?.price?.volatility24h || 0;
        const slippage = getConservativeSlippage(vol);

        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (mint && mint !== SOL_MINT) {
            try {
              const swapRes = await withExponentialBackoff(
                () => swapAllToSOL(mint, slippage),
                { maxRetries: 3, baseDelay: 2000 }
              );
              if (swapRes.success) {
                swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol });
              } else {
                swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
                if (shouldEscalateSkippedSwap(swapRes)) {
                  unresolvedSwapSkips.push({ mint: mint.slice(0, 8), reason: swapRes.reason || 'UNKNOWN_SKIP_REASON' });
                }
              }
            } catch (e) {
              swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
            }
          }
        }
      } catch { /* swap best-effort */ }

      if (swapErrors.length > 0 || unresolvedSwapSkips.length > 0) lifecycleState = 'manual_review';
      await updatePositionLifecycle(input.position_address, lifecycleState);

      // Notifikasi swap + mulai post-close monitor
      if (currentNotify) {
        const totalSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          currentNotify(
            `🔄 <b>Auto-Swap Selesai</b>\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: <code>+${totalSol.toFixed(4)} SOL</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else if (swapErrors.length > 0 || unresolvedSwapSkips.length > 0) {
          const unresolvedText = unresolvedSwapSkips.map(e => `${e.mint}:${e.reason}`).join(', ');
          currentNotify(
            `⚠️ <b>Auto-Swap Gagal</b>\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: <code>${escapeHTML(swapErrors.map(e => e.error || e.mint).join(', '))}</code>\n` +
            `Skip: <code>${escapeHTML(unresolvedText || '-')}</code>\n\n` +
            `<i>Lakukan swap manual di Jupiter/Meteora.</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }

      return JSON.stringify({
        ...closeResult,
        lifecycleState,
        pnlRecorded: pnlData,
        autoSwap:    swapResults.length > 0 ? swapResults : 'skipped',
        swapErrors:  swapErrors.length > 0  ? swapErrors  : undefined,
        unresolvedSwapSkips: unresolvedSwapSkips.length > 0 ? unresolvedSwapSkips : undefined,
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
      let zapStrategyUsed = null;
      try {
        const lpPnlMap = await getLpPnlMap();
        const onChain = await getPositionInfo(input.pool_address);
        const match   = onChain?.find(p => p.address === input.position_address);
        if (match) {
          const dbPos      = getOpenPositions().find(p => p.position_address === input.position_address);
          zapStrategyUsed = dbPos?.strategy_used || null;
          const deployedSol = dbPos?.deployed_sol || 0;
          const currentVal  = match.currentValueSol ?? 0;
          const pnl = resolvePnlSnapshot({
            deployedSol,
            currentValueSol: currentVal,
            providerPnlPct: lpPnlMap.get(input.position_address),
            directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
            positionAddress: input.position_address,
            poolAddress: input.pool_address,
            tokenMint: dbPos?.token_mint || dbPos?.token_x || null,
            onDivergence: (event) => auditPnlDivergence(event, { scope: 'execute_tool_zap_out' }),
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
          }, { isUrgent: true }),
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

      // Record ke pool memory + strategy performance — best-effort
      try {
        await recordPoolCloseOutcome(
          input.pool_address,
          zapPnlData.pnlPct || 0,
          zapPnlData.closeReason || 'ZAP_OUT',
          zapStrategyUsed || zapPnlData.strategyUsed || null,
        );
      } catch (e) {
        console.warn('[healer] recordPoolCloseOutcome failed:', e?.message);
      }

      // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
      await new Promise(r => setTimeout(r, 3000));

      const swapResults = [];
      const swapErrors  = [];
      const unresolvedSwapSkips = [];
      let lifecycleState = 'closed_reconciled';
      try {
        const poolInfo = await getPoolInfo(input.pool_address);
        const snapshot = await getMarketSnapshot(poolInfo.tokenX, input.pool_address);
        const vol      = snapshot?.price?.volatility24h || 0;
        const _zapCloseReason = (input.closeReason || '').toUpperCase();
        const isEmergencyClose = ['PANIC_EXIT', 'STOP_LOSS', 'REGIME_FLIP_BEARISH'].some(t => _zapCloseReason.includes(t));
        const slippage = isEmergencyClose ? 750 : getConservativeSlippage(vol);

        for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
          if (!mint || mint === SOL_MINT) continue;
          try {
            const swapRes = await withExponentialBackoff(
              () => swapAllToSOL(mint, slippage),
              { maxRetries: 3, baseDelay: 2000 }
            );
            if (swapRes.success) {
              swapResults.push({ mint: mint.slice(0, 8), outSol: swapRes.outSol, txHash: swapRes.txHash });
              // 🧹 THE BIG HARVEST: Tariq balik uang sewa
              await closeTokenAccount(mint).catch(() => {});
            } else {
              swapResults.push({ mint: mint.slice(0, 8), skipped: swapRes.reason });
              if (shouldEscalateSkippedSwap(swapRes)) {
                unresolvedSwapSkips.push({ mint: mint.slice(0, 8), reason: swapRes.reason || 'UNKNOWN_SKIP_REASON' });
              }
            }
          } catch (e) {
            if (e.message.includes('LIQUIDITY_TRAP')) {
              await notifyLiquidityTrap(mint, e.message, currentNotify);
              swapErrors.push({ mint: mint.slice(0, 8), error: 'LIQUIDITY_TRAP' });
            } else {
              swapErrors.push({ mint: mint.slice(0, 8), error: e.message });
            }
          }
        }
      } catch (e) {
        swapErrors.push({ error: e.message });
      }

      const totalSwappedSol = swapResults.reduce((s, r) => s + (r.outSol || 0), 0);
      if (swapErrors.length > 0 || unresolvedSwapSkips.length > 0) lifecycleState = 'manual_review';
      await updatePositionLifecycle(input.position_address, lifecycleState);

      // Notifikasi hasil + mulai post-close monitor
      if (currentNotify) {
        if (swapResults.some(r => r.outSol)) {
          const swapLine = swapResults.map(r => r.outSol ? `+${r.outSol.toFixed(4)}◎` : 'skip').join(', ');
          currentNotify(
            `⚡ <b>Zap Out Selesai</b>\n\n` +
            `Token → SOL: ${swapLine}\n` +
            `Total: <code>+${totalSwappedSol.toFixed(4)} SOL</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else if (swapErrors.length > 0 || unresolvedSwapSkips.length > 0) {
          const unresolvedText = unresolvedSwapSkips.map(e => `${e.mint}:${e.reason}`).join(', ');
          currentNotify(
            `⚠️ <b>Zap Out — Swap Gagal</b>\n\n` +
            `Posisi sudah ditutup, tapi token belum dikonversi ke SOL.\n` +
            `Error: <code>${escapeHTML(swapErrors.map(e => e.error || e.mint).join(', '))}</code>\n` +
            `Skip: <code>${escapeHTML(unresolvedText || '-')}</code>\n\n` +
            `<i>Lakukan swap manual di Jupiter/Meteora.</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else {
          // Semua di-skip (balance 0 — kemungkinan single-side SOL yang belum OOR)
          currentNotify(
            `✅ <b>Zap Out Selesai</b>\n\nPosisi ditutup. Semua dana sudah dalam bentuk SOL.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }

      return JSON.stringify({
        ...closeResult,
        zapOut: true,
        lifecycleState,
        swapResults,
        swapErrors: swapErrors.length > 0 ? swapErrors : null,
        unresolvedSwapSkips: unresolvedSwapSkips.length > 0 ? unresolvedSwapSkips : null,
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

/**
 * 🦅 GUARDIAN ANGEL: Notifikasi Deteksi Dumping
 */
async function notifyLiquidityDump(tokenMint, reason, notifyFn) {
  const shortMint = tokenMint.slice(0, 8);
  const msg = `🦅 <b>GUARDIAN ANGEL ALERT!</b> (Holder Dump Detected)\n\n` +
             `• Token: <code>${shortMint}</code>...\n` +
             `• Alasan: ${reason}\n\n` +
             `⚠️ <b>Survival Protocol:</b> Zap Out otomatis dipicu!\n\n` +
             `<i>Modal lu ditarik sebelum dev/whale selesai dumping.</i>`;
  
  await notifyFn?.(msg);
}

/**
 * 🛡️ LIQUIDITY TRAP: Notifikasi Intervensi Manual
 * Memberikan link intervensi manual jika swap terhambat likuiditas tipis.
 */
async function notifyLiquidityTrap(mint, errorMsg, notifyFn) {
  const manualLink = `https://jup.ag/swap/SOL-${mint}`;
  const msg = `⚠️ <b>LIQUIDITY TRAP DETECTED</b>\n\n` +
             `Bot membatalkan swap otomatis untuk melindungi modal lu.\n` +
             `• Alasan: <code>${errorMsg}</code>\n\n` +
             `👉 <b>Intervensi Manual:</b> <a href="${manualLink}">Swap di Jupiter</a>\n` +
             `<i>Lu bisa pantau harganya dan close sendiri kalau udah membaik.</i>`;
  
  if (notifyFn) await notifyFn(msg).catch(() => {});
}

// ─── Simpan notify function untuk dipakai di tool executor ───────
let _healerNotifyFn = null;

export async function runHealerAlpha(notifyFn) {
  _healerNotifyFn = notifyFn || null;
  const cfg = getConfig();
  const minTaConfidence = cfg.minTaConfidenceForAutoExit ?? 0.55;

  // ── Skip cycle silently jika tidak ada posisi terbuka ────────
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return null;

  const lessonsCtx = getLessonsContext();
  const thresholds = getThresholds();
  const lpPnlMap = await getLpPnlMap();

  // ── Safety Check: Max Drawdown ────────────────────────────────
  const drawdown = checkMaxDrawdown();
  if (drawdown.triggered) {
    const msg = `⛔ <b>Healer Alpha FROZEN</b>\n\n${escapeHTML(drawdown.reason)}\n\nBot tidak akan membuka posisi baru hari ini. Posisi yang ada tetap dimonitor.`;
    if (notifyFn) await notifyFn(msg, { parse_mode: 'HTML' });
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
        try {
          await recordPoolCloseOutcome(pos.pool_address, 0, 'MANUAL_CLOSE', pos.strategy_used);
        } catch (e) {
          console.warn('[healer] recordPoolCloseOutcome failed for manual close:', e?.message);
        }
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
          `⚠️ <b>Posisi Ditutup Manual</b>\n\n${codeBlock(manualLines)}\n\n<i>Posisi tidak ditemukan on-chain. Status diperbarui ke CLOSED.</i>`,
          { parse_mode: 'HTML' }
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
        directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
        onPnlDivergence: (event) => auditPnlDivergence(event, { scope: 'main_healer_loop' }),
      });
      const pnlPct = snapshot.pnlPct;
      const pnlSol = snapshot.pnlSol;
      const addr   = pos.position_address;
      const runtimeState = getPositionRuntimeState(addr);
      const strategyProfile = getStrategy(pos.strategy_used || '');
      const positionAgeMin = getPositionAgeMinutes(pos);
      const exitMode = strategyProfile?.exit?.mode || 'default';
      const configuredTp = Number(strategyProfile?.exit?.takeProfitPct ?? thresholds.takeProfitFeePct);
      const strategyTakeProfitPct = Number.isFinite(configuredTp) && configuredTp > 0 ? configuredTp : 5.0;
      const emergencyStopLossPct = strategyProfile?.exit?.emergencyStopLossPct ?? thresholds.stopLossPct;
      const maxHoldHours      = strategyProfile?.exit?.maxHoldHours ?? thresholds.maxHoldHours ?? 6;
      const maxHoldMinutes    = maxHoldHours * 60;
      let maxHoldTriggered    = positionAgeMin >= maxHoldMinutes;

      // ── Healer Trailing Shadow State (non-exit, telemetry only) ─────────
      // Trailing exit utama dipusatkan di TAE Watchdog (single source of truth).
      // Main Healer hanya menyimpan telemetry agar tidak terjadi race dengan Watchdog.
      // Fix #4: seed peak from DB so it survives healer restarts
      const savedPeakPnl = Number.isFinite(pos.peak_pnl_pct) ? pos.peak_pnl_pct : null;
      let tracker = {
        peakPnl: runtimeState.healerPeakPnl ?? savedPeakPnl ?? pnlPct,
        trailingActive: false,
      };
      if (pnlPct > tracker.peakPnl) {
        tracker.peakPnl = pnlPct;
        // Persist new peak so it survives a restart (best-effort, non-blocking)
        updatePositionPeakPnl(addr, tracker.peakPnl).catch(() => {});
      }
      const trailingTpHit = false;
      updatePositionRuntimeState(addr, {
        healerPeakPnl: tracker.peakPnl,
        healerTrailingActive: tracker.trailingActive,
      });

      // ── T2.6: Volatility-scaled SL ───────────────────────────────
      const cachedVolCat = runtimeState.volatilityCategory;
      const volSLMultiplier = cachedVolCat === 'HIGH' ? 1.5
        : cachedVolCat === 'MEDIUM' ? 1.2
        : 1.0;

      // ── Strategy-Aware SL ────────────────────────────────────────
      // Evil Panda: bin-based SL (price must break below range floor by tolerance bins).
      // Other strategies: pct-based SL using normalStopLossPct (not hardcoded stopLossPct).
      const isEvilPandaStrategy = pos.strategy_used === 'Evil Panda' || exitMode === 'evil_panda_confluence';
      let slTriggered = false;
      let slReason = '';

      if (isEvilPandaStrategy) {
        const activeBin      = match.activeBinId;
        const rangeMin       = match.lowerBinId ?? null;
        const toleranceBins  = cfg.evilPandaBottomToleranceBins ?? 5;
        if (activeBin != null && rangeMin != null && activeBin < (rangeMin - toleranceBins)) {
          slTriggered = true;
          slReason = `Evil Panda bin SL: activeBin ${activeBin} < rangeFloor ${rangeMin} − ${toleranceBins} bins`;
        }
      } else {
        const normalSLPct    = cfg.normalStopLossPct ?? cfg.stopLossPct ?? 10;
        const effectiveSLPct = normalSLPct * volSLMultiplier;
        if (pnlPct <= -Math.abs(effectiveSLPct)) {
          slTriggered = true;
          slReason = `PnL ${pnlPct.toFixed(2)}% <= stop loss −${Math.abs(effectiveSLPct).toFixed(2)}%${volSLMultiplier !== 1.0 ? ` (${cachedVolCat} vol ×${volSLMultiplier})` : ''}`;
        }
      }

      // ── Net-PnL Hard Floor — absolute backstop for all strategies ──
      // pnlPct from resolvePnlSnapshot already includes claimed+unclaimed fees via
      // currentValueSol (LP token amounts) + feesClaimed adjustment, so this guard
      // catches cases where IL exceeds ALL fee income combined.
      const maxNetLossPct = cfg.maxNetLossPct ?? -15;
      if (!slTriggered && pnlPct < maxNetLossPct) {
        slTriggered = true;
        slReason = `Net PnL ${pnlPct.toFixed(2)}% breached hard floor ${maxNetLossPct}% — IL exceeds all fees`;
      }

      // Keep emergencyStopLossPct accessible for legacy references below (proactive warning, mildStopLossBreach)
      const effectiveSLPct = emergencyStopLossPct * volSLMultiplier;
      const slCheck = { triggered: slTriggered, reason: slReason || `PnL ${pnlPct.toFixed(2)}%` };

      // ── T2.7: OOR tracking in main loop ─────────────────────────
      // Mirrors the executeTool.get_all_positions logic so the decision block
      // has valid outOfRangeMins / outOfRangeBins (previously undefined here).
      let outOfRangeMins = null;
      let outOfRangeBins = null;
      if (!match.inRange) {
        const trackedAt = runtimeState.oorSince;
        if (!trackedAt) {
          updatePositionRuntimeState(addr, { oorSince: Date.now() });
        } else {
          outOfRangeMins = Math.floor((Date.now() - trackedAt) / 60000);
        }
        if (match.activeBinId != null && (match.lowerBinId != null || match.upperBinId != null)) {
          const lowerBin = match.lowerBinId ?? match.activeBinId;
          const upperBin = match.upperBinId ?? match.activeBinId;
          if (match.activeBinId < lowerBin) outOfRangeBins = lowerBin - match.activeBinId;
          else if (match.activeBinId > upperBin) outOfRangeBins = match.activeBinId - upperBin;
        }
      } else {
        updatePositionRuntimeState(addr, { oorSince: null });
      }
      // Normalize OOR distance to price % — raw bin counts are not comparable across pools
      // with different binSteps (binStep=100: 10 bins ≈ 10.5% move; binStep=5: 10 bins ≈ 0.5%)
      const poolBinStep = match.binStep || strategyProfile?.parameters?.binStep || 100;
      const oorPricePct = outOfRangeBins !== null
        ? (Math.pow(1 + poolBinStep / 10000, outOfRangeBins) - 1) * 100
        : null;
      const oorBinsThreshold = cfg.outOfRangeBinsToClose ?? 10;
      // Scale threshold to consistent price % (oorBinsThreshold × binStep/100 ≈ intended %)
      const oorPricePctThreshold = oorBinsThreshold * (poolBinStep / 100);
      const oorBinsTriggered = oorPricePct !== null && oorPricePctThreshold > 0 && oorPricePct >= oorPricePctThreshold;
      const tpHit   = pnlPct >= strategyTakeProfitPct;

      // ── Inventory Rebalancing Check ──────────────────────────────
      // Jika posisi OOR dan token X mendominasi >85% dan IL > fees:
      // → force-close posisi. Auto-swap di close path akan swap token X → SOL.
      let inventoryForcedClose = false;
      {
        const totalXUi = match.totalXUi ?? 0;
        const totalYUi = match.totalYUi ?? 0;
        const currentPrice = parseFloat(match.currentPrice || match.displayPrice || 0);
        if (currentPrice > 0 && (totalXUi > 0 || totalYUi > 0) && !match.inRange) {
          const xValueSol = totalXUi * currentPrice;
          const totalValueSol = xValueSol + totalYUi;
          const tokenXPct = totalValueSol > 0 ? xValueSol / totalValueSol : 0;
          const feesSol = match.feeCollectedSol ?? 0;
          const lpValueSol = pos.deployed_sol + pnlSol; // current LP value in SOL
          const ilSol = Math.max(0, pos.deployed_sol - lpValueSol + feesSol); // IL net of fees
          const lastFlaggedAt = runtimeState.inventoryImbalancedAt || 0;
          const cooldownPassed = Date.now() - lastFlaggedAt > 15 * 60 * 1000; // 15-min cooldown
          if (tokenXPct > 0.85 && ilSol > feesSol && cooldownPassed) {
            inventoryForcedClose = true;
            updatePositionRuntimeState(addr, {
              inventoryImbalanced: true,
              inventoryImbalancedAt: Date.now(),
            });
            notifyFn?.(
              `⚠️ <b>Inventory Rebalance — Close & Swap</b>\n\n` +
              `<code>${shortAddr(addr)}</code>\n` +
              `Token X: <b>${(tokenXPct * 100).toFixed(1)}%</b> (OOR, IL > Fees)\n` +
              `IL: <code>◎${ilSol.toFixed(4)}</code> | Fees: <code>◎${feesSol.toFixed(4)}</code>\n` +
              `<i>Menutup posisi dan swap balik ke SOL...</i>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else if (tokenXPct <= 0.85) {
            updatePositionRuntimeState(addr, { inventoryImbalanced: false });
          }
        }
      }

      // ── Pool Maturity: Anti-Zombie Detection ─────────────────────────
      // Only check for positions ≥ 6h old without an existing exit trigger.
      // Calls getPoolInfo lazily to avoid overhead on every young position.
      let zombieForceClose = false;
      let _earlyEfficiency = { score: 0, label: 'Unknown' };
      if (positionAgeMin >= 360 && !trailingTpHit && !tpHit && !slCheck.triggered) {
        try {
          const _zombieStats = await getPoolInfo(pos.pool_address);
          _earlyEfficiency = computePoolEfficiency(_zombieStats?.volume24h || 0, _zombieStats?.tvl || 0);
          if (_earlyEfficiency.score < 0.2) {
            zombieForceClose = true;
            console.warn(`[healer] ZOMBIE_EXIT: Pool efficiency ${_earlyEfficiency.score.toFixed(3)} < 0.2 at age ${positionAgeMin}m — forcing close to free capital`);
          }
        } catch { /* non-critical — fall through to normal logic */ }
      }

      // Tidak ada trigger → flag apakah posisi ini butuh LLM, lalu skip
      if (!trailingTpHit && !tpHit && !slCheck.triggered && !maxHoldTriggered && !oorBinsTriggered && !inventoryForcedClose && !zombieForceClose) {
        // Posisi butuh LLM jika: out of range, fees tinggi, atau mencapai threshold SL
        if (!match?.inRange) _healerNeedsLLM = true;
        const feePct = (match?.feeCollectedSol || 0) / (pos.deployed_sol || 0.001);
        if (feePct >= 0.03) _healerNeedsLLM = true;
        if (pnlPct <= -(thresholds.stopLossPct * 0.6)) _healerNeedsLLM = true;
        continue;
      }

      // ── Baca kondisi chart & narasi sebelum keputusan ────────
      let market = null;
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const _marketTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('analyzeMarket timeout')), 12000)
            );
            market = await Promise.race([
              analyzeMarket(pos.token_x, pos.pool_address, { inRange: match.inRange, pnlPct }),
              _marketTimeout,
            ]);
            if (market) break;
          } catch (e) {
            if (attempt === 2) throw e;
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
        // Cache volatility category for T2.6 vol-scaled SL in subsequent cycles
        const volCat = market?.snapshot?.price?.volatilityCategory || market?.volatilityCategory;
        if (volCat) {
          updatePositionRuntimeState(addr, { volatilityCategory: volCat });
        }
        if (market?.signal) {
          updatePositionRuntimeState(addr, {
            lastSignal: market.signal,
            lastSignalConf: Number.isFinite(market?.confidence) ? market.confidence : 0.5,
            lastSignalAt: Date.now(),
          });
        }
      } catch { /* tetap lanjut tanpa market data */ }

      const hasFreshCachedSignal = Number.isFinite(runtimeState?.lastSignalAt) && (Date.now() - runtimeState.lastSignalAt) <= (30 * 60 * 1000);
      const taConfidence = market?.snapshot?.quality?.taConfidence ?? (hasFreshCachedSignal ? minTaConfidence : 0.5);
      const taReliable = taConfidence >= minTaConfidence;
      const fallbackSignal = hasFreshCachedSignal ? (runtimeState.lastSignal || 'NEUTRAL') : 'NEUTRAL';
      const fallbackConf = hasFreshCachedSignal && Number.isFinite(runtimeState?.lastSignalConf)
        ? runtimeState.lastSignalConf
        : 0.45;
      const sig  = taReliable ? (market?.signal || fallbackSignal) : fallbackSignal;
      const conf = taReliable
        ? (Number.isFinite(market?.confidence) ? market.confidence : fallbackConf)
        : Math.min(fallbackConf, 0.45);
      const thesis = market?.thesis   || '-';
      const keyRisks = market?.keyRisks?.join(', ') || '-';
      const inRange = match?.inRange === true;
      const mildStopLossBreach = Math.abs(pnlPct) <= (Math.abs(emergencyStopLossPct) + 1.0);
      const veryBullishRecovery = sig === 'BULLISH' && conf >= 0.90 && inRange;
      const strongBullishInRange = sig === 'BULLISH' && conf >= 0.85 && inRange;

      // ── Putuskan: CLOSE atau HOLD ─────────────────────────────
      let decision  = 'CLOSE';
      let holdReason = '';

      if (exitMode === 'evil_panda_confluence' && strongBullishInRange) {
        decision = 'HOLD';
        holdReason = 'Evil Panda menunggu konfirmasi bearish sebelum exit.';
      }

      if (trailingTpHit) {
        if (strongBullishInRange) {
          decision   = 'HOLD';
          holdReason = `Chart masih BULLISH (${(conf * 100).toFixed(0)}% conf) — tunda close 1 siklus`;
        }
      } else if (tpHit) {
        if (sig === 'BULLISH' && conf >= 0.80 && inRange) {
          decision   = 'HOLD';  // TP hold aktif, trailing exit ditangani TAE watchdog
          holdReason = `Chart BULLISH (${(conf * 100).toFixed(0)}% conf) — tunda close, biarkan profit jalan`;
        }
      } else if (slCheck.triggered) {
        const needsTrendConf = exitMode === 'evil_panda_confluence';
        if (needsTrendConf && veryBullishRecovery && mildStopLossBreach) {
          decision = 'HOLD';
          holdReason = `Strategy Aware: Tren masih BULLISH — nunggu recovery di jaring Panda.`;
        } else if (veryBullishRecovery && mildStopLossBreach) {
          decision   = 'HOLD';
          holdReason = `Chart masih BULLISH (${(conf * 100).toFixed(0)}% conf) — hold untuk recovery`;
        }
      } else if (!match?.inRange) {
        // Logika Adaptive OOR
        if (oorBinsTriggered) {
          // Bins-based OOR: price moved too many bins away — immediate close
          decision   = 'CLOSE';
        } else if (market?.oorDecision === 'EXTEND' && (outOfRangeMins || 0) < 60) {
          decision   = 'HOLD';
          holdReason = `Adaptive OOR: Chart BULLISH, nunggu re-entry (${outOfRangeMins}/60m max)`;
        } else if (market?.oorDecision === 'PANIC_EXIT') {
          decision   = 'CLOSE';
          _healerNotifyFn?.(`🚨 *PANIC EXIT* @ ${pos.pool_address.slice(0, 8)}\nOOR + Bearish Breakdown detected (conf ${(market.confidence * 100).toFixed(0)}%).`).catch(() => {});
        } else if (outOfRangeMins !== null && outOfRangeMins >= thresholds.outOfRangeWaitMinutes) {
          decision   = 'CLOSE';
        } else {
          decision   = 'HOLD';
          holdReason = `Menunggu timer OOR standard (${outOfRangeMins}/${thresholds.outOfRangeWaitMinutes}m)`;
        }
      }

      // ── Pool Maturity: Efficiency Veto on Max Hold ───────────────────
      // Before force-closing on max hold, check if the pool is still highly
      // efficient. If so, grant a 4-hour grace period instead of exiting.
      // Prevents premature exit from a "Golden Goose" high-fee pool.
      let efficiencyVetoActive = false;
      if (maxHoldTriggered) {
        const gracePeriodUntil = runtimeState.efficiencyGracePeriodUntil || 0;
        const inGracePeriod    = gracePeriodUntil > Date.now();

        const _mktPoolTvl = market?.snapshot?.pool?.tvl || 0;
        const _mktPoolVol = market?.snapshot?.pool?.volume24h || 0;
        const _mktFeeApr  = market?.snapshot?.pool?.feeApr ?? 0;
        const _eff = (_mktPoolTvl > 0 || _mktPoolVol > 0)
          ? computePoolEfficiency(_mktPoolVol, _mktPoolTvl)
          : _earlyEfficiency; // fall back to early zombie-check data if analyzeMarket had no pool stats

        if (inGracePeriod) {
          efficiencyVetoActive = true;
          maxHoldTriggered = false;
          decision   = 'HOLD';
          holdReason = `Efficiency grace period active until ${new Date(gracePeriodUntil).toISOString()}`;
          console.log(`[healer] STAYING_IN: Efficiency grace period active (${shortAddr(addr)}). Holding.`);
        } else if (_eff.score > 1.5 || _mktFeeApr > 60) {
          const graceUntil = Date.now() + 4 * 60 * 60 * 1000;
          updatePositionRuntimeState(addr, { efficiencyGracePeriodUntil: graceUntil });
          efficiencyVetoActive = true;
          maxHoldTriggered = false;
          decision   = 'HOLD';
          holdReason = `Pool highly efficient (Score: ${_eff.score.toFixed(2)}, FeeAPR: ${_mktFeeApr.toFixed(1)}%, ${_eff.label})`;
          console.log(`[healer] STAYING_IN: Pool is highly efficient (Score: ${_eff.score.toFixed(2)}, FeeAPR: ${_mktFeeApr.toFixed(1)}%, Label: ${_eff.label}). Grace period granted 4h.`);
        }
      }

      // Max hold force-close overrides any hold decision
      if (maxHoldTriggered) {
        decision   = 'CLOSE';
        holdReason = '';
      }
      if (inventoryForcedClose) {
        decision   = 'CLOSE';
        holdReason = '';
      }

      // Tentukan label + emoji
      const triggerCode = trailingTpHit       ? 'TRAILING_TAKE_PROFIT'
        : tpHit                 ? 'TAKE_PROFIT'
        : zombieForceClose      ? 'ZOMBIE_EXIT'
        : efficiencyVetoActive  ? 'EFFICIENCY_VETO'
        : maxHoldTriggered      ? 'MAX_HOLD_EXIT'
        : oorBinsTriggered      ? 'OOR_BINS_EXCEEDED'
        : inventoryForcedClose  ? 'INVENTORY_REBALANCE'
        : 'STOP_LOSS';
      const triggerLabel = triggerCode === 'TRAILING_TAKE_PROFIT' ? 'Trailing Take Profit'
        : triggerCode === 'TAKE_PROFIT'        ? 'Take Profit'
        : triggerCode === 'ZOMBIE_EXIT'        ? 'Zombie Exit'
        : triggerCode === 'EFFICIENCY_VETO'    ? 'Efficiency Veto'
        : triggerCode === 'MAX_HOLD_EXIT'      ? 'Max Hold Exit'
        : triggerCode === 'OOR_BINS_EXCEEDED'  ? 'OOR Bins Exceeded'
        : triggerCode === 'INVENTORY_REBALANCE'? 'Inventory Rebalance'
        : 'Stop-Loss';
      const triggerEmoji = trailingTpHit      ? '🎯'
        : tpHit                 ? '💰'
        : zombieForceClose      ? '🧟'
        : efficiencyVetoActive  ? '🌿'
        : maxHoldTriggered      ? '⏰'
        : oorBinsTriggered      ? '📍'
        : inventoryForcedClose  ? '⚖️'
        : '🛑';
      const triggerReason = trailingTpHit
        ? `PnL turun dari peak ${tracker.peakPnl.toFixed(2)}% ke ${pnlPct.toFixed(2)}%`
        : tpHit
        ? `PnL ${pnlPct.toFixed(2)}% ≥ target ${strategyTakeProfitPct}%`
        : zombieForceClose
        ? `Pool efficiency ${_earlyEfficiency.score.toFixed(3)} < 0.2 at age ${positionAgeMin}m — modal nyangkut`
        : efficiencyVetoActive
        ? holdReason
        : maxHoldTriggered
        ? `Position held for ${maxHoldHours}h — force close to unlock capital`
        : oorBinsTriggered
        ? `OOR ${outOfRangeBins} bins (threshold: ${oorBinsThreshold}) — force close`
        : inventoryForcedClose
        ? `Token X >85% OOR, IL > fees — close & swap balik ke SOL`
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
        kv('Efficiency', (() => {
          const _eff = (market?.snapshot?.pool?.tvl > 0 || market?.snapshot?.pool?.volume24h > 0)
            ? computePoolEfficiency(market?.snapshot?.pool?.volume24h || 0, market?.snapshot?.pool?.tvl || 0)
            : _earlyEfficiency;
          return _eff.score > 0 ? `${_eff.score.toFixed(2)}x (${_eff.label})` : '-';
        })(), W),
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

      const tpBullishHold = decision === 'HOLD' && tpHit && sig === 'BULLISH' && conf >= 0.80 && inRange;
      const tpHoldTrailActive = runtimeState.tpHoldTrailActive === true;
      if (tpBullishHold && !tpHoldTrailActive) {
        updatePositionRuntimeState(addr, { tpHoldTrailActive: true });
      } else if (!tpBullishHold && tpHoldTrailActive) {
        updatePositionRuntimeState(addr, { tpHoldTrailActive: false });
      }

      // ── HOLD ─────────────────────────────────────────────────────
      if (decision === 'HOLD') {
        if (tpBullishHold && tpHoldTrailActive) {
          // HOLD TRAIL already active; avoid repeated activation notifications every cycle.
          continue;
        }
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

      // ── CLOSE ─────────────────────────────────────────────────────
      // T1.3: Concurrency guard — skip if another cycle is already closing this address
      if (!acquireClose(addr)) {
        console.warn(`[healer] Close skipped for ${addr.slice(0, 8)} — already in progress`);
        continue;
      }

      const preCloseLines = [
        ..._fullTable,
        hr(40),
        kv('Alasan', (triggerReason || '-').slice(0, 38), W),
      ];
      await notifyFn?.(
        `${triggerEmoji} *${triggerLabel} — CLOSE*\n\n${codeBlock(preCloseLines)}\n\n_Menutup posisi..._`
      );

      try {
        const solPriceUsd = await getSolPriceUsd().catch((e) => {
          console.warn(`[healer] SOL price feed failed (${e?.message}), falling back to 150 USD — PnL USD will be approximate`);
          return 150;
        });
        const safePnlSol = Number.isFinite(pnlSol) ? pnlSol : 0;
        if (!Number.isFinite(pnlSol)) {
          console.warn(`[healer] pnlSol is ${pnlSol} for ${addr} — defaulting to 0 to prevent NaN corruption`);
        }
        const realizedPnlUsd = parseFloat((safePnlSol * solPriceUsd).toFixed(2));
        const realizedFeesUsd = parseFloat((((match.feeCollectedSol ?? 0) * solPriceUsd)).toFixed(2));
        await updatePositionLifecycle(addr, 'closing');
        const closeResult = await closePositionDLMM(pos.pool_address, addr, {
          pnlUsd:      realizedPnlUsd,
          pnlPct,
          feeUsd:      realizedFeesUsd,
          pnlSol:      safePnlSol,
          feeSol:      match.feeCollectedSol || 0,
          closeReason: triggerCode,
          lifecycleState: 'closed_pending_swap',
        });
        clearPositionState(addr);

        // Record SL streak for circuit breaker persistence
        if (triggerCode === 'STOP_LOSS') {
          const nowCb = Date.now();
          const cbWindowMs = (cfg.slCircuitBreakerWindowMin ?? 60) * 60 * 1000;
          const cbCount = cfg.slCircuitBreakerCount ?? 3;
          const cbPauseMs = (cfg.slCircuitBreakerPauseMin ?? 60) * 60 * 1000;
          const recentSLEvents = getRuntimeState('recent-sl-events', [])
            .filter(ts => Number.isFinite(ts) && (nowCb - ts) < cbWindowMs);
          recentSLEvents.push(nowCb);
          setRuntimeState('recent-sl-events', recentSLEvents);
          if (recentSLEvents.length >= cbCount) {
            setRuntimeState('hunter-circuit-breaker', {
              pausedUntil: nowCb + cbPauseMs,
              triggeredAt: nowCb,
              count: recentSLEvents.length,
            });
            recordCircuitBreakerEvent({
              poolAddress:  pos.pool_address,
              triggeredAt:  nowCb,
              pausedUntil:  nowCb + cbPauseMs,
              slCount:      recentSLEvents.length,
              cbWindowMs,
              cbPauseMs,
            });
          }
          await flushRuntimeState().catch(() => {});
        }

        // DB updates — best-effort: jangan kirim "❌ Gagal close" kalau ini yang throw
        try { await recordPnlUsd(realizedPnlUsd); } catch { /* best-effort */ }
        try {
          await recordPoolCloseOutcome(pos.pool_address, pnlPct, triggerCode, pos.strategy_used);
        } catch (e) { console.warn('[healer] recordPoolCloseOutcome failed after retries:', e?.message); }

        // TAE Tracking: Record exit event for analytics — only after confirmed on-chain close
        if (closeResult?.success || closeResult?.alreadyClosed)
        try {
          // Fix #2: Compute real TAE exit context (same zone logic as runPanicWatchdog)
          const _deployedSolSafe = pos.deployed_sol > 0 ? pos.deployed_sol : null;
          const _feeRatioAtExit = _deployedSolSafe ? (match.feeCollectedSol ?? 0) / _deployedSolSafe : 0;
          const _retracementDrop = Math.max(0, tracker.peakPnl - pnlPct);
          let _exitZone = 'ZONE 1 (Sniper)';
          let _retracementCap = 1.5;
          let _isLPerPatienceActive = false;
          if (pnlPct >= 30) {
            _exitZone = 'ZONE 3 (Moonshot)';
            _retracementCap = 7.0;
            _isLPerPatienceActive = true;
          } else if (pnlPct >= 10) {
            _exitZone = 'ZONE 2 (Runner)';
            _retracementCap = 3.5;
            _isLPerPatienceActive = true;
          }
          if (_feeRatioAtExit >= 0.03) {
            _retracementCap += 3.0;
            _isLPerPatienceActive = true;
          }

          recordExitEvent({
            positionAddress: pos.position_address,
            poolAddress: pos.pool_address,
            tokenMint: pos.token_mint || pos.token_x,
            entryTime: pos.created_at,
            entryPrice: pos.entry_price || 0,
            exitTime: new Date().toISOString(),
            exitPrice: match.currentPrice || match.displayPrice || 0,
            holdMinutes: positionAgeMin,
            pnlPct: pnlPct,
            pnlUsd: realizedPnlUsd,
            feesClaimedUsd: realizedFeesUsd,
            totalReturnUsd: realizedPnlUsd + realizedFeesUsd,
            exitTrigger: triggerCode,
            exitZone: _exitZone,
            exitRetracement: _retracementDrop,
            exitRetracementCap: _retracementCap,
            feeRatioAtExit: _feeRatioAtExit,
            feeVelocityIncreasing: false,
            lperPatienceActive: _isLPerPatienceActive,
            profitOrLoss: pnlPct > 0 ? 'PROFIT' : pnlPct < 0 ? 'LOSS' : 'BREAKEVEN',
            exitReason: triggerReason || triggerLabel,
            closeReasonCode: triggerCode,
          });
        } catch (e) {
          console.warn('[healer] recordExitEvent failed — TAE analytics data lost for', addr, ':', e?.message);
        }

        // Tunggu 3 detik — token perlu waktu untuk muncul di wallet setelah close
        await new Promise(r => setTimeout(r, 3000));

        // Auto-swap token → SOL (retry 3x dengan backoff)
        const swapMsgs  = [];
        const swapFails = [];
        let totalSwappedSol = 0;
        let lifecycleState = 'closed_reconciled';
        try {
          const poolInfo = await getPoolInfo(pos.pool_address);
          if (!poolInfo) {
            console.warn(`[healer] getPoolInfo returned null for ${pos.pool_address} — pool may be deleted. Skipping auto-swap, marking manual_review.`);
            lifecycleState = 'manual_review';
            await notifyFn?.(`⚠️ <b>Manual Review Required</b>\n\nPool <code>${pos.pool_address.slice(0, 8)}</code> tidak ditemukan di Meteora.\nToken kemungkinan masih di wallet — swap manual diperlukan.`, { parse_mode: 'HTML' }).catch(() => {});
            throw new Error('POOL_NOT_FOUND'); // exit try block, skip swap loop
          }
          for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
            if (mint && mint !== SOL_MINT) {
              try {
                const swapRes = await executionRetry(async () => {
                  const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
                  const vol      = snapshot?.price?.volatility24h || 0;
                  const slippage = triggerCode === 'STOP_LOSS' ? 750 : getConservativeSlippage(vol);
                  return await swapAllToSOL(mint, slippage);
                }, {
                  maxRetries: 3,
                  delayMs: 2000,
                  taskName: `ZapOut Swap (${pos.symbol})`
                });

                if (swapRes && swapRes.success) {
                  swapMsgs.push(`+${swapRes.outSol.toFixed(4)}◎`);
                  totalSwappedSol += swapRes.outSol;
                  // 🧹 THE BIG HARVEST: Tariq balik uang sewa
                  await closeTokenAccount(mint).catch(() => {});
                } else if (swapRes && !swapRes.success) {
                  swapFails.push(swapRes.error || 'Unknown swap error');
                }
              } catch (e) {
                if (e.message.includes('LIQUIDITY_TRAP')) {
                  await notifyLiquidityTrap(mint, e.message, notifyFn);
                  swapFails.push('LIQUIDITY_TRAP');
                } else {
                  console.error(`[healer] Final cleanup failed for ${pos.symbol}:`, e.message);
                  swapFails.push(e.message);
                  await notify(`🚨 *ZAP OUT FAILED* (Retries Exhausted)\n\nPosition: \`${pos.symbol}\`\nMint: \`${pos.token_mint}\`\nError: ${e.message}\n\n_Manual swap recommended to recover SOL._`).catch(() => {});
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
        const _feesSolClosed   = match?.feeCollectedSol || 0;
        const _capGainSol      = _currentValSol - _deployedSol;
        const _totalReturnSol  = _capGainSol + _feesSolClosed;
        const closedLines = [
          kv('Posisi',   shortAddr(addr), W),
          kv('Strategi', shortStrat(pos.strategy_used || '-'), W),
          hr(40),
          kv('Deploy',   `${_deployedSol.toFixed(4)}◎`, W),
          kv('Return',   `${_currentValSol.toFixed(4)}◎`, W),
          kv('Cap G/L',  `${_capGainSol >= 0 ? '+' : ''}${_capGainSol.toFixed(4)}◎`, W),
          kv('Fees',     `+${_feesSolClosed.toFixed(4)}◎`, W),
          kv('Total',    `${_totalReturnSol >= 0 ? '+' : ''}${_totalReturnSol.toFixed(4)}◎`, W),
          hr(40),
          kv('Trigger',  triggerLabel, W),
          ...(swapMsgs.length > 0 ? [hr(40), kv('Swap', swapMsgs.join(', '), W)] : []),
        ];
        await notifyFn?.(`✅ *Posisi Ditutup*\n\n${codeBlock(closedLines)}`);

        // ── Post-close opportunity scan ────────────────────────────
        // Cek apakah pool masih layak re-entry berdasarkan Supertrend snapshot.
        try {
          const ohlcv = await getOHLCV(pos.token_x, pos.pool_address);
          const stTrend = ohlcv?.ta?.supertrend?.trend || 'NEUTRAL';
          const low24h = Number(ohlcv?.low24h || 0);
          const curPrice = Number(ohlcv?.currentPrice || 0);
          const distPct  = low24h > 0 ? ((curPrice - low24h) / low24h) * 100 : 99;
          // Re-entry hanya jika Supertrend bullish dan harga dekat low 24h
          if (stTrend === 'BULLISH' && distPct >= 0 && distPct <= 12) {
            notifyFn?.(
              `🔁 <b>Re-entry Signal</b>\n\nPool: <code>${pos.pool_address.slice(0, 8)}</code>\nSupertrend: ${stTrend} | Dist from 24h Low: ${distPct.toFixed(1)}%\n<i>Kondisi ideal untuk re-entry — gunakan Hunter untuk konfirmasi.</i>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        } catch { /* best-effort, jangan crash */ }
      } catch (e) {
        if (getOpenPositions().some(p => p.position_address === addr)) {
          await updatePositionLifecycle(addr, 'open');
        }
        await notifyFn?.(`❌ Gagal close ${triggerLabel}: ${e.message}`);
      } finally {
        releaseClose(addr);
      }
    } catch { /* skip jika gagal fetch */ }
  }

  // ── 7. Aegis Phase 4: Automatic Technical Sweep ─────────
  // Obelisk: Parallelized sweep for near-instant reaction time
  const openPositionsRel = getOpenPositions();
  if (openPositionsRel.length > 0) {
    await Promise.all(openPositionsRel.map(async (pos) => {
      try {
        const addr = pos.position_address;
        const strategyProfile = getStrategy(pos.strategy_used);
        const isEvilPandaMode = strategyProfile?.exit?.mode === 'evil_panda_confluence' || pos.strategy_used === 'Evil Panda';
        const analysis = await analyzeMarket(pos.token_x, pos.pool_address, { pnlPct: 0 });
        const snapshot = analysis?.snapshot;
        const ta = snapshot?.ta?.['Evil Panda'] || snapshot?.ta?.[pos.strategy_used];
        const taConfidence = snapshot?.quality?.taConfidence ?? 0.5;
        const taReliable = taConfidence >= minTaConfidence;
        
        // Evil Panda is a deep LPer strategy: don't force-close via generic TA sweep.
        if (isEvilPandaMode) {
          return;
        }

        if (ta?.exit?.triggered && taReliable) {
          console.log(`[healer] AEGIS PRIORITY EXIT: Technical trigger for ${addr.slice(0,8)} - Reason: ${ta.exit.reason}`);
          const triggerLabel = ta.exit.shadowExit ? 'SHADOW EXIT' : 'TECHNICAL EXIT';
          const triggerReason = ta.exit.reason || 'Confluence reached';

          if (!acquireClose(addr)) {
            console.warn(`[healer] AEGIS close skipped for ${addr.slice(0, 8)} — already in progress`);
            return;
          }
          try {
            await notifyFn?.(`🦅 <b>AEGIS GUARD</b> — ${triggerLabel}\n\nPosition: <code>${addr.slice(0, 8)}</code>\nReason: ${triggerReason}\n<i>Executing immediate liquidation...</i>`);
            // Gunakan jalur zap_out standar agar close + swap + lifecycle reconcile konsisten.
            await executeTool('zap_out', {
              pool_address: pos.pool_address,
              position_address: addr,
              reasoning: `${triggerLabel}: ${triggerReason}`,
            }, notifyFn);
          } finally {
            releaseClose(addr);
          }
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
    Pelaporan tindakan: Jika kamu panggil close_position atau zap_out, jelaskan alasannya di akhir laporan.
    Jangan panggil swap_to_sol secara terpisah — semua proses penutupan posisi (close/zap) sudah otomatis melakukan "Zero Dust" (swap sisa ke SOL).

DLMM EXIT STRATEGY FRAMEWORK:
Setiap posisi memiliki exitContext (dari pre-flight) — gunakan ini untuk menentukan agresivitas exit:

  TOP_ENTRY: Entered dekat recent high — position sangat sensitif terhadap reversal.
    → Exit lebih agresif. Jika harga stagnant >2 siklus atau market BEARISH → close segera.
    → Target profit kecil (1-3%), jangan tunggu TP normal.

  LATE_ENTRY: Entered setelah rally, harga masih tinggi tapi momentum melemah.
    → Exit saat first sign of weakness. Trailing TP lebih ketat dari biasanya.

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

ALUR KERJA SINKRONISASI TAE-LP:
1. get_all_positions → evaluasi semua posisi aktif
2. Untuk setiap posisi, timbang Sinyal TAE + Efisiensi LP:

   A. MASTER SIGNAL (TAE Exit):
      - Untuk strategi non-Panda: jika Supertrend 15m flip merah ATAU RSI menukik tajam dari overbought (>85) -> boleh ZAP_OUT ke SOL.
      - Untuk Evil Panda (deep LPer): jangan pakai flip merah sebagai kill-switch otomatis; prioritaskan fee extraction + risk guard berbasis drawdown/OOR.
      - Filosofi: jangan over-trading; amankan modal TANPA memotong edge LPer terlalu cepat.

   B. LP EFFICIENCY GUARD (Irit Biaya Swap):
      - JANGAN TERJEBAK OVER-TRADING. Setiap Zap Out itu mahal.
      - Jika TAE masih Bullish/Sideways tapi harga OOR (Out of Range) -> HOLD maksimal 30-60 menit jika Fee APR masih > 70%. Biarkan "Patience Buffer" LP bekerja.
      - Jika PnL < -5% DAN Fee Velocity "Menurun" -> EXIT SEGERA (Stop Bleeding).

   C. ZERO DUST & RENT RECOVERY:
      - Apapun alasan exit-nya, sistem otomatis sikat bersih sisa token ke SOL dan tarik balik duit sewa akun (0.002 SOL).

3. Berikan reasoning: Jelaskan keputusanmu berdasarkan perpaduan Sinyal TAE dan efisiensi Fee lu vs estimasi biaya swap.

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
  let needsDeliberation = _healerNeedsLLM;
  const currentPositions = getOpenPositions();
  for (const pos of currentPositions) {
    if (needsDeliberation) break;
    try {
      const analysis = await analyzeMarket(pos.token_x, pos.pool_address, { inRange: true, pnlPct: 0 });
      const snap = analysis?.snapshot;
      const ta = snap?.ta?.['Evil Panda'] || snap?.ta?.[pos.strategy_used];
      
      const isOOR = !snap?.inRange;
      const deployedSol = pos.deployed_sol || pos.deployed_capital || 0;
      const isLowFees = (snap?.unclaimedFeesUsd || 0) < (deployedSol * 0.03);
      const isHealthyPnL = (analysis?.pnlPct || 0) > -2.0;

      const strategyProfile = getStrategy(pos.strategy_used);
      const isEvilPandaMode = strategyProfile?.exit?.mode === 'evil_panda_confluence' || pos.strategy_used === 'Evil Panda';
      const bearishNeedsReview = !isEvilPandaMode && ta?.supertrend?.trend === 'BEARISH';

      if (isOOR || !isHealthyPnL || !isLowFees || bearishNeedsReview) {
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
    await notifyFn(`⚠️ <b>Healer Alpha</b> — batas ${MAX_ROUNDS} putaran tercapai, loop dihentikan paksa.`);
  }

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };

  // Kirim LLM report HANYA jika ada tindakan nyata (close/zap/claim) yang diambil
  // Saat semua posisi HOLD — tidak ada notif, healer tetap diam
  if (actionsCalled.size > 0 && notifyFn) {
    await notifyFn(`🩺 <b>Healer Alpha</b>\n\n${report}`);
  }

  return report;
}

/**
 * High-Frequency Technical Heartbeat (Panic Watchdog)
 * Tanpa LLM, tanpa biaya, fokus murni pada keselamatan modal (Option B+).
 */
export async function runPanicWatchdog(notifyFn) {
  const cfg = getConfig();
  const minTaConfidence = cfg.minTaConfidenceForAutoExit ?? 0.55;
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  const lpPnlMap = await getLpPnlMap();

  for (const pos of openPositions) {
    try {
      const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
      const onChain = await getPositionInfo(pos.pool_address);
      const match = onChain?.find(p => p.address === pos.position_address);

      if (!match || !snapshot) continue;

      const posSnapshot = resolvePositionSnapshot({
        dbPosition: pos,
        livePosition: match,
        providerPnlPct: lpPnlMap.get(pos.position_address),
        directPnlPct: Number.isFinite(match?.pnlPct) ? match.pnlPct : null,
        onPnlDivergence: (event) => auditPnlDivergence(event, { scope: 'tae_watchdog_loop' }),
      });

      // 📊 LP-IDENTITY: Real-time IL & HODL Analysis (SOL Denominated)
      const entryPriceVal = parseFloat(pos.entry_price || 0);
      const currentPriceVal = parseFloat(posSnapshot.price || 0);
      const initialSol = parseFloat(pos.deployed_sol || pos.deployed_capital || 0);

      // pnlUsd must be converted to SOL using the SOL/USD price, not the token price.
      // Dividing by token price gives token-denominated units, which corrupts the Toxic IL guard.
      const _solPriceUsd = await getSolPriceUsd().catch(() => 150);
      const _solPrice = _solPriceUsd > 0 ? _solPriceUsd : 150;

      // Benchmarking: Berapa SOL kita kalau cuma simpan (HODL) koin/modal awal?
      // Jika koin naik 20%, HODLer punya 'pumping gain'. LPer sering kena 'lag' karena IL.
      const priceChangeRatio = entryPriceVal > 0 ? (currentPriceVal / entryPriceVal) : 1;
      const holdValueSol = initialSol * priceChangeRatio;
      const lpValueSol = initialSol + (parseFloat(posSnapshot.pnlUsd || 0) / _solPrice);

      const yieldVsHodl = holdValueSol > 0 ? (lpValueSol / holdValueSol) - 1 : 0;
      const netProfitSol = lpValueSol - initialSol;

      const isTrendBullish = snapshot.supertrend?.trend === 'BULLISH' || snapshot.indicators?.supertrend?.trend === 'BULLISH';
      const isTrendBearish = snapshot.supertrend?.trend === 'BEARISH' || snapshot.indicators?.supertrend?.trend === 'BEARISH';
      const taConfidence = snapshot?.quality?.taConfidence ?? 0.5;
      const taReliable = taConfidence >= minTaConfidence;
      
      const pnlPct = posSnapshot.pnlPct;
      const addr   = pos.position_address;
      const runtimeState = getPositionRuntimeState(addr);
      
      const strategyProfile = getStrategy(pos.strategy_used);
      const isEvilPandaMode = strategyProfile?.exit?.mode === 'evil_panda_confluence' || pos.strategy_used === 'Evil Panda';
      const disableTrendKillSwitch = isEvilPandaMode && cfg.evilPandaDisableTrendKillSwitch !== false;
      const feeSol = match.feeCollectedSol || 0;
      const feeRatio = feeSol / (pos.deployed_sol || 0.001);
      const currentPrice = Number(match?.currentPrice);
      const lowerPrice = Number(match?.lowerPrice);
      const upperPrice = Number(match?.upperPrice);
      const isOORLower = !match.inRange && Number.isFinite(currentPrice) && Number.isFinite(lowerPrice) && currentPrice < lowerPrice;
      const isOORUpper = !match.inRange && Number.isFinite(currentPrice) && Number.isFinite(upperPrice) && currentPrice > upperPrice;

      const now = Date.now();
      const posAgeMin = getPositionAgeMinutes(pos);
      const vol24h = snapshot.volume24h || snapshot.stats?.v24h || 0;
      const isFeeVelocityIncreasing = snapshot.feeVelocity === 'increasing' || snapshot.stats?.feeVelocity === 'increasing';
      const deployedSol = pos.deployed_sol || 0;
      const claimThreshold3Sol = deployedSol > 0 ? Math.max(deployedSol * 0.03, 0.005) : 0.01;
      const exitPrice = snapshot?.price?.currentPrice || match?.currentPrice || 0;
      let zone = pnlPct < 10 ? 'ZONE 1 (Sniper)'
        : pnlPct < 30 ? 'ZONE 2 (Runner)'
        : 'ZONE 3 (Moonshot)';
      let isLPerPatienceEnabled = false;
      
      if (!runtimeState.feeTracker) {
        runtimeState.feeTracker = { lastFee: feeSol, lastTimestamp: now };
      }

      const oneHourMs = 60 * 60 * 1000;
      let isZombieFee = false;
      if (posAgeMin > 120 && (now - runtimeState.feeTracker.lastTimestamp) >= oneHourMs) {
        const feeDelta = feeSol - runtimeState.feeTracker.lastFee;
        if (feeDelta < 0.0005) {
          isZombieFee = true;
        } else {
          runtimeState.feeTracker = { lastFee: feeSol, lastTimestamp: now };
        }
      }

      // 🦅 LAYER 14: GUARDIAN ANGEL (Live Holder Monitor)
      const guardianInterval = 15 * 60 * 1000; // 15 Menit
      if (!runtimeState.lastSecurityCheck || (now - runtimeState.lastSecurityCheck) >= guardianInterval) {
        console.log(`🦅 [guardian] Re-scanning holder security for ${pos.token_mint.slice(0, 8)}...`);
        const secData = await getGmgnSecurity(pos.token_mint);
        
        if (secData) {
          const currentTop10Rate = parseFloat(secData.top_10_holder_rate || 0);
          const currentInsiderRate = parseFloat(secData.suspected_insider_hold_rate || 0);
          const lastTop10 = runtimeState.lastTop10Rate ?? currentTop10Rate;
          const lastInsider = runtimeState.lastInsiderRate ?? currentInsiderRate;

          // 🚨 DUMP DETECTION: Jika holder rate turun > 5% mendadak
          const top10Drop = lastTop10 - currentTop10Rate;
          const insiderDrop = lastInsider - currentInsiderRate;

          if (top10Drop > 0.05 || insiderDrop > 0.05) {
            const reason = top10Drop > 0.05 
              ? `Top 10 Holders dumping! (Drop: ${(top10Drop * 100).toFixed(1)}%)`
              : `Insiders/Shadow Wallets dumping! (Drop: ${(insiderDrop * 100).toFixed(1)}%)`;

            await notifyLiquidityDump(pos.token_mint, reason, notifyFn);

            // 🔥 Zap Out Instan (Survival Override)
            await closeAndRecordExitAtomic({
              pos,
              posSnapshot,
              pnlPct,
              exitPrice,
              zone,
              feeRatio,
              isFeeVelocityIncreasing,
              isLPerPatienceEnabled,
              exitTrigger: 'GUARDIAN_ANGEL_DUMP',
              exitReason: reason,
              closeReasonCode: 'GUARDIAN_ANGEL_DUMP_EXIT',
              lifecycleState: 'closed_panic',
              isUrgent: true,
            });

            if (!isDryRun()) {
               await new Promise(r => setTimeout(r, 2000));
               try {
                 const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
                 const vol      = snapshot?.price?.volatility24h || 0;
                 const slippage = getConservativeSlippage(vol);
                 await swapAllToSOL(pos.token_mint, slippage, { isUrgent: true });
                 await closeTokenAccount(pos.token_mint).catch(() => {});
               } catch (e) {
                 if (e.message.includes('LIQUIDITY_TRAP')) {
                   await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
                 }
               }
            }
            continue; // Posisi ditutup, lanjut ke loop berikutnya
          }

          // Update state untuk pemantauan berikutnya
          updatePositionRuntimeState(addr, { 
            lastSecurityCheck: now,
            lastTop10Rate: currentTop10Rate,
            lastInsiderRate: currentInsiderRate
          });
        }
      }

      const isZombieVol = vol24h > 0 && vol24h < 400000;
      const ignoreZombieFeeBecauseSafeUpperPark =
        isEvilPandaMode &&
        isOORUpper &&
        cfg.evilPandaIgnoreZombieFeeWhenOorUpper !== false;
      const oorUpperDistancePct =
        isOORUpper && Number.isFinite(upperPrice) && upperPrice > 0
          ? ((currentPrice - upperPrice) / upperPrice) * 100
          : 0;
      const oorUpperDistanceMaxPct = Math.max(0, Number(cfg.oorUpperDistanceMaxPct ?? 35));

      // Moon trap guard: jika harga terbang terlalu jauh di atas upper net, lepaskan modal.
      if (
        isEvilPandaMode &&
        isOORUpper &&
        oorUpperDistanceMaxPct > 0 &&
        Number.isFinite(oorUpperDistancePct) &&
        oorUpperDistancePct >= oorUpperDistanceMaxPct
      ) {
        const msg = `🚀 *OOR UPPER CAPITAL RELEASE*\n\n` +
          `• Posisi: \`${shortAddr(pos.position_address)}\`\n` +
          `• Jarak OOR Atas: ${oorUpperDistancePct.toFixed(2)}% (batas: ${oorUpperDistanceMaxPct.toFixed(2)}%)\n` +
          `• Aksi: tutup posisi untuk bebaskan modal ke setup baru.\n` +
          `• PnL: ${pnlPct.toFixed(2)}%`;

        await notifyFn?.(msg);

        await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'OOR_UPPER_CAPITAL_RELEASE',
          exitReason: `OOR upper distance ${oorUpperDistancePct.toFixed(2)}% >= ${oorUpperDistanceMaxPct.toFixed(2)}%`,
          closeReasonCode: 'OOR_UPPER_DISTANCE_EXCEEDED',
          lifecycleState: 'closed_oor_upper',
          isUrgent: true,
        });

        if (!isDryRun()) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
            const vol = snapshot?.price?.volatility24h || 0;
            const slippage = getConservativeSlippage(vol);
            await swapAllToSOL(pos.token_mint, slippage, { isUrgent: true });
            await closeTokenAccount(pos.token_mint).catch(() => {});
          } catch (e) {
            if (e.message.includes('LIQUIDITY_TRAP')) {
              await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
            }
          }
        }
        continue;
      }
      const zombieFeeShouldExit = isZombieFee && !ignoreZombieFeeBecauseSafeUpperPark;

      if (zombieFeeShouldExit || isZombieVol) {
        const reason = zombieFeeShouldExit ? "FEE_STAGNATION" : "LOW_VOLUME_FLOOR";
        const msg = `🧟 *ZOMBIE POOL EXTERMINATED!*\n\n` +
                   `• Posisi: \`${shortAddr(pos.position_address)}\`\n` +
                   `• Alasan: ${reason === "FEE_STAGNATION" ? "Mati Suri (1 jam tanpa fee)" : "Volume Drop (< $400k)"}\n` +
                   `• PnL: ${pnlPct.toFixed(2)}%\n\n` +
                   `_Modal dilepas untuk mencari pool baru._`;

        await notifyFn?.(msg);

        await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'ZOMBIE_EXIT',
          exitReason: `Zombie pool: ${reason === "FEE_STAGNATION" ? "No fees for 1h" : "Volume < $400k"}`,
          closeReasonCode: `ZOMBIE_EXIT_${reason}`,
          lifecycleState: 'closed_zombie',
          isUrgent: true,
        });
        if (!isDryRun()) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
            const vol      = snapshot?.price?.volatility24h || 0;
            const slippage = getConservativeSlippage(vol);
            await swapAllToSOL(pos.token_mint, slippage, { isUrgent: true });
            await closeTokenAccount(pos.token_mint).catch(() => {});
          } catch (e) {
            if (e.message.includes('LIQUIDITY_TRAP')) {
              await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
            }
          }
        }
        continue;
      }

      let triggerPct = 1.0;
      const pandaZone1Cap = Math.max(0.5, Number(cfg.evilPandaRetracementCapZone1Pct ?? 4.0));
      const pandaZone2Cap = Math.max(0.5, Number(cfg.evilPandaRetracementCapZone2Pct ?? 8.0));
      const pandaZone3Cap = Math.max(0.5, Number(cfg.evilPandaRetracementCapZone3Pct ?? 12.0));
      let retracementCap = isEvilPandaMode
        ? (pnlPct < 10 ? pandaZone1Cap : pnlPct < 30 ? pandaZone2Cap : pandaZone3Cap)
        : (pnlPct < 10 ? 1.5 : pnlPct < 30 ? 3.5 : 7.0);
      isLPerPatienceEnabled = pnlPct >= 10;

      // 🐼 LP-IDENTITY: Sinkronisasi TAE dengan Mindset LP
      // Jika Fee APR sangat tinggi (>70%) atau Velocity meningkat, kita lebih "Sabar" menghadapi retracement.
      if (feeRatio >= 0.03 || isFeeVelocityIncreasing) { 
        retracementCap += 3.0; // Tambah toleransi 3% lagi biar gak gampang ke-kick TAE
        isLPerPatienceEnabled = true;
        console.log(`[watchdog] LP Mindset Active: Fee APR/Velocity tinggi, TAE Exit ditunda (Cap: +${retracementCap}%).`);
      }

      // Fix #4: seed watchdog peak from DB so trailing TP survives restarts
      const savedWatchdogPeak = Number.isFinite(pos.peak_pnl_pct) ? pos.peak_pnl_pct : null;
      let peak = runtimeState.watchdogPeakPnl ?? savedWatchdogPeak ?? pnlPct;
      if (pnlPct > peak) {
        peak = pnlPct;
        updatePositionPeakPnl(addr, peak).catch(() => {});
      }
      
      const trailingActive = runtimeState.watchdogTrailingActive || pnlPct >= triggerPct;
      const retracementDrop = peak - pnlPct;
      const trailingTpHit  = trailingActive && retracementDrop >= retracementCap; 

      updatePositionRuntimeState(addr, {
        watchdogPeakPnl: peak,
        watchdogTrailingActive: trailingActive,
      });

      // 🐼 LP-TAE SYNC: Jika Trailing Hit tapi Fee APR > 100% dan TREND BULLISH -> Kasih Peluang (HOLD)
      if (trailingTpHit && isLPerPatienceEnabled && isTrendBullish && retracementDrop < (retracementCap + 2.0)) {
        console.log(`[watchdog] Trailing hit (${retracementDrop.toFixed(2)}%), but LP Identity is STRONG (Fee APR/Trend OK). Holding for more fees.`);
      } else if (trailingTpHit) {
        const msg = `🚨 *TAE-LP EXIT!* (${zone})\n\n` +
                   `• Posisi: \`${shortAddr(pos.position_address)}\`\n` +
                   `• Peak PnL: +${peak.toFixed(2)}%\n` +
                   `• Exit @ PnL: +${pnlPct.toFixed(2)}% (Drop: ${retracementDrop.toFixed(2)}%)\n\n` +
                   `_Retracement cap ${retracementCap}% (incl. Fee Buffer) tercapai._`;

        await notifyFn?.(msg);

        await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'TRAILING_TP_HIT',
          exitReason: `Trailing TP hit at ${zone}. Peak PnL: +${peak.toFixed(2)}%, Exit: +${pnlPct.toFixed(2)}%`,
          closeReasonCode: `TAE_WATCHDOG_EXIT_${zone.replace(/ /g, '_')}`,
          lifecycleState: 'closed_panic',
          isUrgent: true,
          extra: {
            exitRetracement: retracementDrop,
            exitRetracementCap: retracementCap,
          },
        });
          if (!isDryRun()) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
                const vol      = snapshot?.price?.volatility24h || 0;
                const slippage = getConservativeSlippage(vol);
                await swapAllToSOL(pos.token_mint, slippage, { isUrgent: true });
              await closeTokenAccount(pos.token_mint).catch(() => {});
            } catch (e) {
              if (e.message.includes('LIQUIDITY_TRAP')) {
                await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
              }
            }
          }
          continue;
        }

        if (isLPerPatienceEnabled && isTrendBullish) {
          console.log(`[watchdog] Trailing hit in ${zone} (+${pnlPct.toFixed(2)}%), but holding because TREND is BULLISH.`);
        } else if (!disableTrendKillSwitch && taReliable && !isTrendBullish) {
          const msg = `🎯 *ADAPTIVE ZAP OUT!* (${zone})\n\n` +
                     `• Exit @ PnL: +${pnlPct.toFixed(2)}%\n` +
                     `• Trend: ${isTrendBearish ? 'BEARISH' : 'NEUTRAL'}\n\n` +
                     `_Profit dikunci sesuai momentum._`;

          await notifyFn?.(msg);

          await closeAndRecordExitAtomic({
            pos,
            posSnapshot,
            pnlPct,
            exitPrice,
            zone,
            feeRatio,
            isFeeVelocityIncreasing,
            isLPerPatienceEnabled,
            exitTrigger: 'SUPERTREND_FLIP',
            exitReason: `Trend flipped to ${isTrendBearish ? 'BEARISH' : 'NEUTRAL'} at ${zone}. Profit locked.`,
            closeReasonCode: `TAE_WATCHDOG_MOMENTUM_EXIT_${zone.replace(/ /g, '_')}`,
            lifecycleState: 'closed_profit',
            isUrgent: true,
            extra: {
              exitRetracement: retracementDrop,
              exitRetracementCap: retracementCap,
            },
          });
          if (!isDryRun()) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
                const vol      = snapshot?.price?.volatility24h || 0;
                const slippage = getConservativeSlippage(vol);
                await swapAllToSOL(pos.token_mint, slippage, { isUrgent: true });
              await closeTokenAccount(pos.token_mint).catch(() => {});
            } catch (e) {
              if (e.message.includes('LIQUIDITY_TRAP')) {
                await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
              }
            }
          }
          continue;
        }

      const trackedOorAt = runtimeState.oorSince;
      const oorMinutes = trackedOorAt ? Math.floor((Date.now() - trackedOorAt) / 60000) : 0;
      
      if (isOORLower && oorMinutes >= 15) {
        const msg = `🛑 *OOR HARD EXIT!* (Efficiency Guard)\n\n` +
                   `• Posisi: \`${shortAddr(pos.position_address)}\`\n` +
                   `• Status: Out of Range > 15 Menit\n` +
                   `• PnL: ${pnlPct.toFixed(2)}%\n\n` +
                   `_Modal dibebaskan untuk mencari pool baru yang produktif._`;

        await notifyFn?.(msg);

        await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'OOR_BAILOUT',
          exitReason: 'Out of range > 15 minutes. Emergency exit to find productive pool.',
          closeReasonCode: 'OOR_HARD_EXIT_WATCHDOG',
          lifecycleState: 'closed_oor',
          isUrgent: true,
        });
        
        if (!isDryRun()) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
            const vol      = snapshot?.price?.volatility24h || 0;
            const slippage = getConservativeSlippage(vol);
            await swapAllToSOL(pos.token_mint, slippage);
            await closeTokenAccount(pos.token_mint).catch(() => {});
          } catch (e) {
            if (e.message.includes('LIQUIDITY_TRAP')) {
              await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
            }
          }
        }
        continue;
      }

      // ─── 🐼 SULTAN HARVEST: Auto-Profit Realization ────────────────
      const _feeInfo = await getPositionFeeInfo(pos.pool_address, pos.position_address).catch(() => ({ uncollectedFeeSol: 0 }));
      const uncollectedFeeSol = _feeInfo.uncollectedFeeSol ?? 0;
      const minHarvestFloor   = cfg.autoHarvestThresholdSol || 0.1;
      const estimatedGasSol = Math.max(0.0005, Number(cfg.harvestEstimatedGasSol || 0.005));
      const minEconomicHarvest = estimatedGasSol * 10;
      const harvestThreshold = Math.max(minHarvestFloor, claimThreshold3Sol, minEconomicHarvest);
      
      if (cfg.autoHarvestEnabled && uncollectedFeeSol >= harvestThreshold) {
        console.log(`🚜 [harvest] Uncollected fees (${uncollectedFeeSol.toFixed(4)} SOL) reached threshold. Starting Auto-Harvest...`);
        
        // Notify beginning of harvest
        await notifyFn?.(`🚜 <b>AUTONOMOUS HARVEST!</b>\n\n` +
                       `• Posisi: <code>${escapeHTML(shortAddr(pos.position_address))}</code>\n` +
                       `• Fee Terakumulasi: <code>${uncollectedFeeSol.toFixed(4)} SOL</code>\n\n` +
                       `<i>Sistem mengamankan profit ke SOL tanpa menutup posisi.</i>`, { parse_mode: 'HTML' });

        try {
          // Gunakan tool logic internal tanpa panggil LLM
          await claimFees(pos.pool_address, pos.position_address, { isUrgent: false });
          
          await new Promise(r => setTimeout(r, 3000));
          
          const poolInfo = await getPoolInfo(pos.pool_address);
          const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
          const vol      = snapshot?.price?.volatility24h || 0;
          const slippage = getConservativeSlippage(vol);

          let harvestedTotal = 0;
          for (const mint of [poolInfo.tokenX, poolInfo.tokenY]) {
            if (mint && mint !== 'So11111111111111111111111111111111111111112') {
              const swapRes = await withExponentialBackoff(() => swapAllToSOL(mint, slippage), { maxRetries: 2 });
              if (swapRes.success) harvestedTotal += (swapRes.outSol || 0);
              await closeTokenAccount(mint).catch(() => {});
            }
          }

          if (harvestedTotal > 0) {
            const harvestedUsd = harvestedTotal * await getSolPriceUsd().catch(() => 150);

            const shouldCompoundHarvest =
              cfg.autoHarvestCompound &&
              (!isEvilPandaMode || cfg.evilPandaAllowAutoCompound === true);
            if (shouldCompoundHarvest) {
              if (harvestedTotal < 0.1) {
                // Below Meteora's ~0.07 SOL account rent threshold — skip compound to avoid rent burn
                console.log(`[compound] Harvest ${harvestedTotal.toFixed(4)} SOL < 0.1 SOL min capital — realizing instead`);
                await recordFeesClaimed(pos.position_address, { claimedSol: harvestedTotal, claimedUsd: harvestedUsd }).catch(() => {});
                await notifyFn?.(`✅ <b>HARVEST REALIZED!</b> <i>(dust: ${harvestedTotal.toFixed(4)}◎ &lt; 0.1◎ min)</i>\n\n` +
                  `• Realized: <code>+${harvestedTotal.toFixed(4)} SOL</code>\n` +
                  `• Status Position: <b>OPEN &amp; Yielding 🎋</b>`, { parse_mode: 'HTML' });
              } else {
              // ─── Compound: reinvest back into same position ──────────
              try {
                const compResult = await addLiquidityToPosition(pos.pool_address, pos.position_address, harvestedTotal);
                if (compResult?.success) {
                  await notifyFn?.(`♻️ <b>HARVEST COMPOUNDED!</b>\n\n` +
                    `• Re-invested: <code>+${harvestedTotal.toFixed(4)} SOL</code>\n` +
                    `• Position: <code>${escapeHTML(shortAddr(pos.position_address))}</code>\n` +
                    `• Status: <b>OPEN &amp; Growing 🌱</b>`, { parse_mode: 'HTML' });
                } else {
                  // Compound failed (dry-run or skipped) — fall back to realize
                  await recordFeesClaimed(pos.position_address, { claimedSol: harvestedTotal, claimedUsd: harvestedUsd }).catch(() => {});
                }
              } catch (compErr) {
                console.error(`[compound] Failed to compound — falling back to realize:`, compErr.message);
                await recordFeesClaimed(pos.position_address, { claimedSol: harvestedTotal, claimedUsd: harvestedUsd }).catch(() => {});
                await notifyFn?.(`✅ <b>HARVEST SUCCESSFUL!</b> <i>(compound failed, realized instead)</i>\n\n` +
                  `• Realized Profit: <code>+${harvestedTotal.toFixed(4)} SOL</code>\n` +
                  `• Status Position: <b>OPEN &amp; Yielding 🎋</b>`, { parse_mode: 'HTML' });
              }
              }
            } else {
              // ─── Default: realize fees as profit ────────────────────
              await recordFeesClaimed(pos.position_address, { claimedSol: harvestedTotal, claimedUsd: harvestedUsd }).catch(() => {});
              await notifyFn?.(`✅ <b>HARVEST SUCCESSFUL!</b>\n\n` +
                `• Realized Profit: <code>+${harvestedTotal.toFixed(4)} SOL</code>\n` +
                `• Status Position: <b>OPEN &amp; Yielding 🎋</b>`, { parse_mode: 'HTML' });
            }
          }
        } catch (harvestErr) {
          console.error(`❌ [harvest] Gagal harvest otonom:`, harvestErr.message);
        }
      }

      const basePanicOorLossPct = Math.abs(Number(cfg.panicOorLossPct ?? 10));
      const evilPandaPanicOorLossPct = Math.abs(Number(cfg.evilPandaPanicOorLossPct ?? 35));
      const panicLossThresholdPct = isEvilPandaMode ? evilPandaPanicOorLossPct : basePanicOorLossPct;
      const emergencyOorLoss = isOORLower && pnlPct <= -panicLossThresholdPct;
      const trendPanicKill = !disableTrendKillSwitch && taReliable && isTrendBearish && isOORLower;
      if (trendPanicKill || emergencyOorLoss) {
        const panicReasonText = trendPanicKill
          ? 'Trend 15m BEARISH & Price < Lower Range'
          : `OOR loss breached (${pnlPct.toFixed(2)}% <= -${panicLossThresholdPct.toFixed(2)}%)`;
        const msg = `🚨 <b>PANIC EXIT EXECUTED!</b> (Critical Dump)\n\n` +
                   `• Posisi: <code>${escapeHTML(shortAddr(pos.position_address))}</code>\n` +
                   `• Pool: <code>${escapeHTML(shortAddr(pos.pool_address))}</code>\n` +
                   `• Alasan: <i>${escapeHTML(panicReasonText)}</i>\n` +
                   `• PnL: <code>${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%</code>\n\n` +
                   `⚠️ <i>Sistem menutup posisi secara otomatis untuk mengamankan sisa SOL.</i>`;

        await notifyFn?.(msg, { parse_mode: 'HTML' });

        const closeResult = await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'PANIC_EXIT_BEARISH_OOR',
          exitReason: `Critical dump: ${panicReasonText}. Emergency liquidation to protect capital.`,
          closeReasonCode: 'PANIC_EXIT_BEARISH_OOR',
          lifecycleState: 'closed_panic',
          isUrgent: true,
        });

        // 🛡️ ZERO DUST PROTOCOL: Instan Swap Balik ke SOL
        if (closeResult && !isDryRun()) {
          await new Promise(r => setTimeout(r, 2000)); // Tunggu RPC propagasi
          try {
            const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
            const vol      = snapshot?.price?.volatility24h || 0;
            const slippage = getConservativeSlippage(vol);
            const swapRes = await swapAllToSOL(pos.token_mint, slippage);
            await closeTokenAccount(pos.token_mint).catch(() => {});
            if (swapRes.success) {
              await notifyFn?.(`🔄 <b>Zero Dust:</b> Berhasil swap balik ke <code>${escapeHTML(swapRes.outSol)}</code> SOL.`, { parse_mode: 'HTML' });
            } else if (swapRes.reason !== 'ZERO_BALANCE') {
              await notifyFn?.(`⚠️ <b>Zero Dust Gagal:</b> Token masih di wallet. Lakukan swap manual!`, { parse_mode: 'HTML' });
            }
          } catch (e) {
            if (e.message.includes('LIQUIDITY_TRAP')) {
              await notifyLiquidityTrap(pos.token_mint, e.message, notifyFn);
            }
          }
        }
        continue;
      }

      // Skenario 2: PROFIT PROTECTION (Profit + Trend Bearish)
      // Kalau lu udah profit biarpun dikit, tapi trend-nya flip, mending bungkus.
      if (!disableTrendKillSwitch && taReliable && isTrendBearish && pnlPct >= 0.5) {
        const msg = `🛡️ <b>PROFIT PROTECTION:</b> (Trend Flip)\n\n` +
                   `• Posisi: <code>${escapeHTML(shortAddr(pos.position_address))}</code>\n` +
                   `• Alasan: <i>Trend Bearish detected while in profit.</i>\n` +
                   `• PnL: <code>+${pnlPct.toFixed(2)}%</code>\n\n` +
                   `<i>Mengunci profit sebelum dimakan dump.</i>`;

        await notifyFn?.(msg, { parse_mode: 'HTML' });

        const closeResult = await closeAndRecordExitAtomic({
          pos,
          posSnapshot,
          pnlPct,
          exitPrice,
          zone,
          feeRatio,
          isFeeVelocityIncreasing,
          isLPerPatienceEnabled,
          exitTrigger: 'PROFIT_PROTECTION',
          exitReason: 'Trend flip to bearish while in profit. Securing gains before dump.',
          closeReasonCode: 'PROFIT_PROTECTION_BEARISH',
          lifecycleState: 'closed_profit_protection',
          isUrgent: true,
        });

        // 🛡️ ZERO DUST PROTOCOL: Instan Swap Balik ke SOL
        if (closeResult && !isDryRun()) {
          await new Promise(r => setTimeout(r, 2000));
          const snapshot = await getMarketSnapshot(pos.token_mint, pos.pool_address);
          const vol      = snapshot?.price?.volatility24h || 0;
          const slippage = getConservativeSlippage(vol);
          const swapRes = await swapAllToSOL(pos.token_mint, slippage);
          if (swapRes.success) {
            await closeTokenAccount(pos.token_mint).catch(() => {});
            await notifyFn?.(`🔄 <b>Zero Dust:</b> Profit dikunci &amp; dikonversi ke SOL.`, { parse_mode: 'HTML' });
          }
        }
      }

    } catch (e) {
      console.error(`[watchdog] Failed checking ${pos.position_address}:`, e.message);
    }
  }
}
