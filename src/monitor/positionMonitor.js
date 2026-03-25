import cron from 'node-cron';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getPositionInfo } from '../solana/meteora.js';

let bot;
let allowedUserId;

export function initMonitor(telegramBot, userId) {
  bot = telegramBot;
  allowedUserId = userId;

  // Cek posisi setiap 5 menit
  cron.schedule('*/5 * * * *', async () => {
    await checkPositions();
  });

  console.log('✅ Position monitor started (every 5 minutes)');
}

async function checkPositions() {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  const poolsToCheck = [...new Set(openPositions.map(p => p.pool_address))];

  for (const poolAddress of poolsToCheck) {
    try {
      const positions = await getPositionInfo(poolAddress);
      if (!positions) continue;

      for (const pos of positions) {
        if (!pos.inRange) {
          const message = `⚠️ *POSISI OUT OF RANGE!*\n\n` +
            `📍 Pool: \`${poolAddress.slice(0, 8)}...${poolAddress.slice(-8)}\`\n` +
            `📍 Posisi: \`${pos.address.slice(0, 8)}...${pos.address.slice(-8)}\`\n` +
            `📊 Active Bin: ${pos.activeBinId}\n` +
            `📊 Range: ${pos.lowerBinId} - ${pos.upperBinId}\n` +
            `💰 Harga saat ini: ${pos.currentPrice}\n\n` +
            `_Posisi kamu tidak lagi menghasilkan fee. Pertimbangkan untuk rebalance atau tutup posisi._`;

          await bot.sendMessage(allowedUserId, message, { parse_mode: 'Markdown' });
          saveNotification('out_of_range', message);
        }
      }
    } catch (e) {
      console.error(`Monitor error for pool ${poolAddress}:`, e.message);
    }
  }
}
