import cron from 'node-cron';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getPositionInfo } from '../solana/meteora.js';
import { getConfig } from '../config.js';

let bot;
let allowedUserId;

let _lastOorCheckRun = Date.now();
let _lastStatusRun   = Date.now();

export function initMonitor(telegramBot, userId) {
  bot = telegramBot;
  allowedUserId = userId;

  // Satu cron per menit — interval dibaca live dari config, tidak perlu restart
  cron.schedule('* * * * *', async () => {
    const cfg = getConfig();
    const now = Date.now();

    // OOR check — hardcoded 5 menit (alert penting, tidak perlu lebih jarang)
    if (now - _lastOorCheckRun >= 5 * 60 * 1000) {
      _lastOorCheckRun = now;
      checkOutOfRange().catch(e => console.error('OOR check error:', e.message));
    }

    // Status update — interval dari config, default 5 menit
    const updateMs = (cfg.positionUpdateIntervalMin ?? 5) * 60 * 1000;
    if (now - _lastStatusRun >= updateMs) {
      _lastStatusRun = now;
      sendPositionStatus().catch(e => console.error('Status update error:', e.message));
    }
  });

  console.log('✅ Position monitor started (OOR: 5m, status update: configurable)');
}

// ─── Out-of-range alert ──────────────────────────────────────────

async function checkOutOfRange() {
  const openPositions = getOpenPositions();
  if (!openPositions.length) return;

  const poolsToCheck = [...new Set(openPositions.map(p => p.pool_address))];

  for (const poolAddress of poolsToCheck) {
    try {
      const positions = await getPositionInfo(poolAddress);
      if (!positions) continue;

      for (const pos of positions) {
        if (!pos.inRange) {
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
            `📊 Range posisi: ${rangeStr}\n\n` +
            `_Posisi tidak menghasilkan fee. Pertimbangkan rebalance atau tutup posisi._`;

          await bot.sendMessage(allowedUserId, message, { parse_mode: 'Markdown' });
          saveNotification('out_of_range', message);
        }
      }
    } catch (e) {
      console.error(`OOR check error pool ${poolAddress}:`, e.message);
    }
  }
}

// ─── Periodic status update ──────────────────────────────────────

async function sendPositionStatus() {
  const openPositions = getOpenPositions();
  if (!openPositions.length) return;

  const poolsToCheck = [...new Set(openPositions.map(p => p.pool_address))];

  // Fetch semua pool paralel — best-effort, skip kalau error
  const results = await Promise.allSettled(
    poolsToCheck.map(addr => getPositionInfo(addr))
  );

  const lines = [];

  for (let i = 0; i < poolsToCheck.length; i++) {
    const poolAddress = poolsToCheck[i];
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value?.length) continue;

    for (const pos of result.value) {
      // PnL: bandingkan currentValueSol vs deployed_sol dari DB
      const dbPos      = openPositions.find(p => p.position_address === pos.address);
      const deploySol  = parseFloat(dbPos?.deployed_sol ?? 0);
      const pnlPct     = deploySol > 0
        ? (pos.currentValueSol - deploySol) / deploySol * 100
        : 0;

      const rangeIcon  = pos.inRange ? '🟢' : '🔴';
      const oorLabel   = pos.inRange ? '' : ' ⚠️ OOR';
      const pnlSign    = pnlPct >= 0 ? '+' : '';
      const symbol     = pos.tokenXSymbol || poolAddress.slice(0, 6);

      const priceStr   = pos.displayCurrentPrice != null
        ? `${pos.displayCurrentPrice} ${pos.priceUnit || ''}`
        : '-';
      const rangeStr   = pos.displayLowerPrice != null
        ? `${pos.displayLowerPrice} – ${pos.displayUpperPrice}`
        : '-';

      lines.push(
        `${rangeIcon} *${symbol}/SOL*${oorLabel}\n` +
        `  PnL: \`${pnlSign}${pnlPct.toFixed(2)}%\`  Fees: \`${(pos.feeCollectedSol || 0).toFixed(4)} SOL\`\n` +
        `  Harga: \`${priceStr}\`  Range: \`${rangeStr}\``
      );
    }
  }

  if (!lines.length) return;

  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  const msg  = `📊 *Position Update — ${time} WIB*\n\n` + lines.join('\n\n');

  try {
    await bot.sendMessage(allowedUserId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Position status send error:', e.message);
  }
}
