import { getWalletBalance } from '../solana/wallet.js';
import { openPosition } from '../solana/meteora.js';
import { getConfig } from '../config.js';

export async function runHunterAlpha() {
  const cfg = getConfig();

  const balance = await getWalletBalance();

  if (balance < cfg.minSolToOpen) return;

  const pool = 'REPLACE_POOL_ADDRESS';

  const amount = Math.min(
    cfg.deployAmountSol,
    balance * (cfg.maxPositionSizePct / 100)
  );

  console.log('Opening position...');
  await openPosition(pool, amount, 0);
}
