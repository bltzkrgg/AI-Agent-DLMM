import { getWalletBalance } from '../solana/wallet.js';
import { openPosition } from '../solana/meteora.js';
import { getConfig } from '../config.js';
import { getOHLCV } from '../oracle.js';

import { calculateVolatility } from '../utils/volatility.js';
import { getAdaptiveRange } from '../utils/range.js';

export async function runHunterAlpha() {
  const cfg = getConfig();
  const balance = await getWalletBalance();

  if (balance < cfg.minSolToOpen) return;

  const pool = process.env.POOL;

  const market = await getOHLCV(pool);
  if (!market) return;

  if (market.trend !== 'UP') return;

  const closes = [market.price]; // (upgrade nanti bisa full OHLC)
  const vol = calculateVolatility(closes);

  const range = getAdaptiveRange(vol);

  const amount = Math.min(
    cfg.deployAmountSol,
    balance * (cfg.maxPositionSizePct / 100)
  );

  console.log(`📈 Entry | Vol=${vol.toFixed(4)} | Range=${range}%`);

  await openPosition(pool, amount, 0, range);
}
