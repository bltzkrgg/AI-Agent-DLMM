import cron from 'node-cron';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getPositionInfo, getPositionInfoLight } from '../solana/meteora.js';
import { getWalletPositions, isLPAgentEnabled } from '../market/lpAgent.js';
import { getWallet } from '../solana/wallet.js';
import { getConfig } from '../config.js';

let bot;
let allowedUserId;

let _lastOorCheckRun = Date.now();
let _lastStatusRun   = 0; // 0 = trigger update di menit pertama setelah start

// Track kapan tiap posisi pertama kali OOR — untuk tampilkan durasi
// positionAddress → timestamp (ms)
const _oorStartTracker = new Map();

export function initMonitor(telegramBot, userId) {
  bot = telegramBot;
  allowedUserId = userId;

  // Satu cron per menit — interval dibaca live dari config, tidak perlu restart
  cron.schedule('* * * * *', async () => {
    const cfg = getConfig();
    const now = Date.now();

    // OOR check — hardcoded 5 menit
    if (now - _lastOorCheckRun >= 5 * 60 * 1000) {
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

      // Address yang ditemukan on-chain untuk pool ini
      const foundOnChain = new Set(positions.map(p => p.address));

      // Cleanup tracker untuk posisi yang sudah tidak ada on-chain (manual close, etc.)
      for (const trackedAddr of _oorStartTracker.keys()) {
        if (dbPositionAddresses.has(trackedAddr) && !foundOnChain.has(trackedAddr)) {
          // Posisi masih di DB tapi tidak ditemukan on-chain — sudah ditutup manual
          _oorStartTracker.delete(trackedAddr);
        }
      }

      for (const pos of positions) {
        if (!pos.inRange) {
          // Track durasi OOR
          if (!_oorStartTracker.has(pos.address)) {
            _oorStartTracker.set(pos.address, Date.now());
          }
          const oorMs  = Date.now() - _oorStartTracker.get(pos.address);
          const oorMin = Math.round(oorMs / 60000);
          const durStr = oorMin < 60
            ? `${oorMin} menit`
            : `${Math.floor(oorMin / 60)}j ${oorMin % 60}m`;

          const priceStr = pos.displayCurrentPrice != null
            ? `${pos.displayCurrentPrice} ${pos.priceUnit || ''}`
            : String(pos.currentPrice);
          const rangeStr = pos.displayLowerPrice != null
            ? `${pos.displayLowerPrice} – ${pos.displayUpperPrice} ${pos.priceUnit || ''}`
            : `Bin ${pos.lowerBinId} – ${pos.upperBinId}`;
          const message =
            `⚠️ *POSISI OUT OF RANGE!*\n\n` +
            `📍 Pool: \`${poolAddress.slice(0, 8)}...${poolAddress.slice(-8)}\`\n` +
            `📍 Posisi: \`${pos.address.slice(0, 8)}...${pos.address.slice(-8)}\`\n` +
            `💱 Pair: ${pos.tokenXSymbol || 'X'}/${pos.tokenYSymbol || 'Y'}\n` +
            `💰 Harga saat ini: ${priceStr}\n` +
            `📊 Range posisi: ${rangeStr}\n` +
            `⏱ Sudah OOR: *${durStr}*\n\n` +
            `_Posisi tidak menghasilkan fee. Pertimbangkan rebalance atau tutup posisi._`;

          await bot.sendMessage(allowedUserId, message, { parse_mode: 'Markdown' });
          saveNotification('out_of_range', message);
        } else {
          // Kembali in-range — hapus tracker
          _oorStartTracker.delete(pos.address);
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
      const deploySol = parseFloat(dbPos?.deployed_sol ?? 0);

      // PnL: LP Agent primary → kalkulasi manual fallback
      const pnlPct = lpPnlMap.has(pos.address)
        ? lpPnlMap.get(pos.address)
        : deploySol > 0
          ? (pos.currentValueSol - deploySol) / deploySol * 100
          : 0;

      const rangeIcon = pos.inRange ? '🟢' : '🔴';
      const oorLabel  = pos.inRange ? '' : ' ⚠️ OOR';

      // Durasi OOR jika sedang OOR
      let oorDur = '';
      if (!pos.inRange && _oorStartTracker.has(pos.address)) {
        const min = Math.round((Date.now() - _oorStartTracker.get(pos.address)) / 60000);
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
        `  PnL: \`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\`  Fees: \`${(pos.feeCollectedSol || 0).toFixed(4)} SOL\`\n` +
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
