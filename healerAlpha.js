import { getPositionsWithPnl } from '../solana/meteora.js';
import { getOHLCV } from '../oracle.js';

import { calculateVolatility } from '../utils/volatility.js';
import { getDynamicTPSL } from '../utils/risk.js';

import { closePositionDLMM } from '../solana/meteora.js';

export async function runHealerAlpha() {
  const pool = process.env.POOL;

  const positions = await getPositionsWithPnl(pool);
  if (!positions.length) return;

  const market = await getOHLCV(pool);
  if (!market) return;

  const closes = [market.price];
  const vol = calculateVolatility(closes);

  const { tp, sl } = getDynamicTPSL(vol);

  for (const p of positions) {
    const pnl = p.pnl;

    console.log(
      `📊 Pos ${p.address.slice(0, 5)} | PnL=${pnl} | TP=${tp} SL=${sl}`
    );

    // STOP LOSS
    if (pnl <= sl) {
      console.log('❌ Stop loss triggered');
      await closePositionDLMM(pool, p.address);
      continue;
    }

    // TAKE PROFIT
    if (pnl >= tp) {
      console.log('✅ Take profit');
      await closePositionDLMM(pool, p.address);
      continue;
    }

    // OUT OF RANGE
    if (!p.inRange) {
      console.log('⚠️ Out of range exit');
      await closePositionDLMM(pool, p.address);
    }
  }
}
