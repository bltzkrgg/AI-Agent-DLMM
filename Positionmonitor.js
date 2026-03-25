import cron from 'node-cron';
import { getOpenPositions, saveNotification } from '../db/database.js';
import { getPositionInfo } from '../solana/meteora.js';

let bot;
let allowedUserId;

// Track last notification time per position to prevent spam
const lastNotified = new Map(); // positionAddress -> timestamp
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes minimum between same notification

export function initMonitor(telegramBot, userId) {
  bot = telegramBot;
  allowedUserId = userId;

  // Check every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkPositions();
  });

  console.log('✅ Position monitor started (every 5 minutes, 30min cooldown per alert)');
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
          const key = `oor_${pos.address}`;
          const lastTime = lastNotified.get(key) || 0;
          const now = Date.now();

          // Skip if notified recently
          if (now - lastTime < NOTIFY_COOLDOWN_MS) continue;

          const message =
            `⚠️ *POSISI OUT OF RANGE!*\n\n` +
            `📍 Pool: \`${poolAddress.slice(0, 8)}...${poolAddress.slice(-4)}\`\n` +
            `📍 Posisi: \`${pos.address.slice(0, 8)}...${pos.address.slice(-4)}\`\n` +
            `📊 Active Bin: ${pos.activeBinId}\n` +
            `📊 Range: ${pos.lowerBinId} - ${pos.upperBinId}\n` +
            `💰 Harga: ${pos.currentPrice}\n\n` +
            `_Posisi tidak menghasilkan fee. Healer Alpha akan evaluasi di siklus berikutnya._`;

          await bot.sendMessage(allowedUserId, message, { parse_mode: 'Markdown' });
          lastNotified.set(key, now);
          saveNotification('out_of_range', message);
        } else {
          // Clear cooldown when back in range
          lastNotified.delete(`oor_${pos.address}`);
        }
      }
    } catch (e) {
      console.error(`Monitor error for pool ${poolAddress}:`, e.message);
    }
  }
}
