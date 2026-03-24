import { getWalletBalance } from '../solana/wallet.js';
import { openPosition } from '../solana/meteora.js';
import { getConfig } from '../config.js';
import { getOHLCV } from '../oracle.js';

import { calculateVolatility } from '../utils/volatility.js';
import { getAdaptiveRange } from '../utils/range.js';

import { getAllStrategies } from '../strategyManager.js';
import { getAIStrategy } from '../strategyAI.js';

export async function runHunterAlpha() {
  const cfg = getConfig();
  const balance = await getWalletBalance();

  if (balance < cfg.minSolToOpen) {
    console.log('❌ Balance too low');
    return;
  }

  const pool = process.env.POOL;
  if (!pool) {
    console.log('❌ POOL not set');
    return;
  }

  // ================= MARKET =================
  const market = await getOHLCV(pool);
  if (!market) {
    console.log('❌ No market data');
    return;
  }

  if (market.trend !== 'UP') {
    console.log('⏭️ Skip: not bullish');
    return;
  }

  // ================= VOLATILITY =================
  const closes = [market.price];
  const vol = calculateVolatility(closes);

  console.log(`📊 Volatility: ${vol.toFixed(4)}`);

  // ================= AI FILTER =================
  const aiDecision = await getAIStrategy({
    vol,
    trend: market.trend,
  });

  if (aiDecision === 'SAFE' && vol > 0.03) {
    console.log('🤖 AI blocked risky trade');
    return;
  }

  // ================= STRATEGY =================
  const strategies = getAllStrategies();

  if (!strategies.length) {
    console.log('❌ No strategies found');
    return;
  }

  const amount = Math.min(
    cfg.deployAmountSol,
    balance * (cfg.maxPositionSizePct / 100)
  );

  for (const strat of strategies) {
    if (vol < strat.conditions.volatilityMin) continue;

    console.log(`🚀 Using strategy: ${strat.name}`);

    const range =
      strat.params.range || getAdaptiveRange(vol);

    const tp = strat.params.tp;
    const sl = strat.params.sl;

    console.log(
      `📈 Entry | Range=${range}% | TP=${tp}% | SL=${sl}%`
    );

    await openPosition(pool, amount, 0, range);

    return; // stop setelah 1 strategy kepilih
  }

  console.log('⏭️ No matching strategy');
}
