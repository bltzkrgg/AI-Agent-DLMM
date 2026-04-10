import cron from 'node-cron';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getPositionInfo, getPositionInfoLight } from '../solana/meteora.js';
import { getWalletPositions, isLPAgentEnabled } from '../market/lpAgent.js';
import { getWallet } from '../solana/wallet.js';
import { getConfig } from '../config.js';
import { getPositionRuntimeState, updatePositionRuntimeState } from '../app/positionRuntimeState.js';
import { resolvePositionSnapshot } from '../app/positionSnapshot.js';

let bot;
let allowedUserId;

let _lastOorCheckRun = Date.now();
let _lastStatusRun   = 0; // 0 = trigger update di menit pertama setelah start

export function initMonitor(telegramBot, userId) {
  bot = telegramBot;
  allowedUserId = userId;

  // Adaptive Cron: Runs every minute, but logic handles tiering
  cron.schedule('* * * * *', async () => {
    const cfg = getConfig();
    const now = Date.now();
    const openPositions = getOpenPositions();

    if (openPositions.length === 0) return;

    // ── Tiered Polling Logic ──────────────────────────────────────
    // Mode Sniper: 1m (PnL > 1.5% or near boundary)
    // Mode Peace: 5m (Standard)
    
    let needsHighFreq = false;
    for (const pos of openPositions) {
      const runtimeState = getPositionRuntimeState(pos.position_address);
      const lastPnl = runtimeState?.lastPnlPct || 0;
      const isNearEdge = (runtimeState?.distToEdgeBins || 99) < 10;
      
      if (lastPnl > 1.5 || isNearEdge || !runtimeState?.inRange) {
        needsHighFreq = true;
        break;
      }
    }

    const currentIntervalMs = needsHighFreq ? (1 * 60 * 1000) : (5 * 60 * 1000);

    // OOR check
    if (now - _lastOorCheckRun >= currentIntervalMs) {
      _lastOorCheckRun = now;
      checkOutOfRange().catch(e => console.error('OOR check error:', e.message));
    }

    // Status update — interval dari config (default 5 menit)
    const updateMs = (cfg.positionUpdateIntervalMin ?? 5) * 60 * 1000;
    if (now - _lastStatusRun >= updateMs) {
      _lastStatusRun = now;
      sendPositionStatus().catch(e => console.error('Status update error:', e.message));
    }
  });

  console.log('✅ Position monitor started (OOR: 5m, status: configurable via positionUpdateIntervalMin)');
}

// ─── Out-of-range alert ──────────────────────────────────────────

async function checkOutOfRange() {
  const openPositions = getOpenPositions();
  if (!openPositions.length) return;

  const poolsToCheck = [...new Set(openPositions.map(p => p.pool_address))];

  // Kumpulkan semua address posisi yang masih ada di DB
  const dbPositionAddresses = new Set(openPositions.map(p => p.position_address));

  for (const poolAddress of poolsToCheck) {
    try {
      const positions = await getPositionInfo(poolAddress);
      if (!positions) continue;

      for (const pos of positions) {
        const runtimeState = getPositionRuntimeState(pos.address);
        // Proactive Distance Tracking: How many bins until we hit the edge?
        let distToEdge = 99;
        if (pos.inRange && pos.activeBin && pos.rangeMin && pos.rangeMax) {
          const distToLower = Math.abs(pos.activeBin - pos.rangeMin);
          const distToUpper = Math.abs(pos.activeBin - pos.rangeMax);
          distToEdge = Math.min(distToLower, distToUpper);
        } else if (!pos.inRange) {
          distToEdge = 0;
        }

        if (!pos.inRange) {
          const oorSince = runtimeState.oorSince || Date.now();
          if (!runtimeState.oorSince) {
            updatePositionRuntimeState(pos.address, { oorSince });
          }
          
          const lastAlert = runtimeState.lastOorAlertAt || 0;
          const shouldAlert = (Date.now() - lastAlert) >= (cfg.oorAlertIntervalMin || 30) * 60 * 1000;

          if (shouldAlert) {
            const message = `🔴 *POSITION OUT OF RANGE*\n\n` +
              `Pool: \`${pos.pool_address.slice(0, 12)}...\`\n` +
              `Range: ${pos.rangeMin} - ${pos.rangeMax}\n` +
              `Active: ${pos.activeBin}\n` +
              `Distance: ${pos.outOfRangeBins || 0} bins\n\n` +
              `_Bot monitor lebih ketat (1m) sampai posisi kembali in-range atau ditutup._`;

            await bot.sendMessage(allowedUserId, message, { parse_mode: 'Markdown' });
            saveNotification('out_of_range', message);
          }
          
          updatePositionRuntimeState(pos.address, { 
            oorSince, 
            lastOorAlertAt: shouldAlert ? Date.now() : lastAlert,
            inRange: false,
            distToEdgeBins: distToEdge
          });
        } else {
          updatePositionRuntimeState(pos.address, { 
            oorSince: null, 
            lastOorAlertAt: null,
            inRange: true,
            distToEdgeBins: distToEdge
          });
        }
      }
    } catch (e) {
      console.error(`OOR check error pool ${poolAddress}:`, e.message);
    }
  }
}

// ─── Periodic status update ──────────────────────────────────────
// PnL dari LP Agent (akurat) — fallback ke kalkulasi manual jika tidak ada API key.
// Range/harga/inRange dari Meteora REST API atau SDK.

async function sendPositionStatus() {
  const openPositions = getOpenPositions();
  if (!openPositions.length) return;

  const poolsToCheck = [...new Set(openPositions.map(p => p.pool_address))];

  // ── Ambil PnL dari LP Agent (1 call untuk semua posisi) ──────────
  // LP Agent lebih akurat dari kalkulasi manual currentValueSol - deploySol
  const lpPnlMap = new Map(); // positionAddress → pnlPct
  if (isLPAgentEnabled()) {
    try {
      const owner = getWallet().publicKey.toString();
      const lpPositions = await getWalletPositions(owner);
      if (Array.isArray(lpPositions)) {
        for (const p of lpPositions) {
          if (p.address) lpPnlMap.set(p.address, p.pnlPct ?? 0);
        }
      }
    } catch (e) {
      console.warn('[monitor] LP Agent PnL fetch failed:', e.message);
    }
  }

  // ── Ambil price/range/inRange dari Meteora REST API ──────────────
  // Parallel fetch — REST API first (fast), SDK fallback per pool if needed
  const results = await Promise.allSettled(
    poolsToCheck.map(async addr => {
      const light = await getPositionInfoLight(addr);
      if (light !== null) return { addr, positions: light, fromAPI: true };
      // REST API gagal → coba SDK (lebih lambat tapi lebih lengkap)
      const full = await getPositionInfo(addr).catch(() => null);
      return { addr, positions: full, fromAPI: false };
    })
  );

  const lines = [];

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value?.positions?.length) continue;
    const { addr: poolAddress, positions } = result.value;

    for (const pos of positions) {
      const dbPos     = openPositions.find(p => p.position_address === pos.address);
      if (!dbPos) continue;
      const deploySol = parseFloat(dbPos?.deployed_sol ?? 0);
      const snapshot = resolvePositionSnapshot({
        dbPosition: dbPos,
        livePosition: pos,
        providerPnlPct: lpPnlMap.has(pos.address) ? lpPnlMap.get(pos.address) : null,
        directPnlPct: Number.isFinite(pos?.pnlPct) ? pos.pnlPct : null,
      });

      // Update runtime state for Tiered Polling
      updatePositionRuntimeState(pos.address, {
        lastPnlPct: snapshot.pnlPct,
        inRange: !!pos.inRange,
        distToEdgeBins: pos.outOfRangeBins || 99
      });

      const rangeIcon = pos.inRange ? '🟢' : '🔴';
      const oorLabel  = pos.inRange ? '' : ' ⚠️ OOR';

      // Durasi OOR jika sedang OOR
      let oorDur = '';
      const runtimeState = getPositionRuntimeState(pos.address);
      if (!pos.inRange && runtimeState.oorSince) {
        const min = Math.round((Date.now() - runtimeState.oorSince) / 60000);
        oorDur = min < 60 ? ` (${min}m)` : ` (${Math.floor(min/60)}j${min%60}m)`;
      }

      // Symbol — SDK result > DB token_x_symbol > short mint
      const symbol = pos.tokenXSymbol
        || dbPos?.token_x_symbol
        || (dbPos?.token_x ? dbPos.token_x.slice(0, 6) : poolAddress.slice(0, 6));

      // Price — SDK result punya displayCurrentPrice (sudah di-invert)
      // REST API hanya punya currentPrice (raw SOL/tokenX) → invert kalau SOL pair
      const WSOL = 'So11111111111111111111111111111111111111112';
      const isSOLPair = dbPos?.token_y === WSOL;
      const priceStr = pos.displayCurrentPrice != null
        ? `${pos.displayCurrentPrice} ${pos.priceUnit || ''}`
        : pos.currentPrice > 0
          ? `${isSOLPair ? (1 / pos.currentPrice).toFixed(4) : pos.currentPrice.toFixed(8)} ${isSOLPair ? `${symbol}/SOL` : ''}`
          : '-';

      const rangeStr = pos.displayLowerPrice != null
        ? `${pos.displayLowerPrice} – ${pos.displayUpperPrice}`
        : (pos.lowerBinId && pos.upperBinId)
          ? `bin ${pos.lowerBinId} – ${pos.upperBinId}`
          : '-';

      lines.push(
        `${rangeIcon} *${symbol}/SOL*${oorLabel}${oorDur}\n` +
        `  PnL: \`${snapshot.pnlPct >= 0 ? '+' : ''}${snapshot.pnlPct.toFixed(2)}%\`  Fees: \`${(pos.feeCollectedSol || 0).toFixed(4)} SOL\`\n` +
        `  Harga: \`${priceStr}\`  Range: \`${rangeStr}\``
      );
    }
  }

  if (!lines.length) return;

  const time = new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
  });
  const msg = `📊 *Position Update — ${time} WIB*\n\n` + lines.join('\n\n');

  try {
    await bot.sendMessage(allowedUserId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Position status send error:', e.message);
  }
}
