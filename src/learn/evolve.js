import { getClosedPositions, getPositionStats } from '../db/database.js';
import { getConfig, updateConfig } from '../config.js';
import { addToHistory } from '../db/database.js';

const PROTECTED_KEYS = ['minMcap', 'maxMcap', 'deployAmountSol'];
export async function runEvolutionCycle() {
  const cfg = getConfig();
  if (!cfg.autonomousEvolutionEnabled) return null;

  console.log('🧬 Evolution Engine: Starting recalibration cycle...');

  const closed = getClosedPositions();
  const totalClosedCount = closed.length;

  // Evolution Guard: Only evolve if enough NEW trades have occurred since last evolution
  if (totalClosedCount < (cfg.lastEvolutionTradeCount || 0) + cfg.evolveIntervalTrades) {
    const needed = (cfg.lastEvolutionTradeCount || 0) + cfg.evolveIntervalTrades - totalClosedCount;
    console.log(`🧬 Evolution Engine: Waiting for ${needed} more trades since last evolution (${totalClosedCount}/${(cfg.lastEvolutionTradeCount || 0) + cfg.evolveIntervalTrades})`);
    return null;
  }

  // Ambil N trade terakhir untuk evaluasi
  const recentTrades = closed.slice(0, cfg.evolveIntervalTrades);
  const stats = getPositionStats();
  
  const winners = recentTrades.filter(t => t.pnl_pct > 0);
  const losers  = recentTrades.filter(t => t.pnl_pct < 0);
  const winRate = winners.length / recentTrades.length;

  const logs = [];
  const updates = {};

  // Logika 1: Adjust MCAP threshold based on losers
  // Jika win rate rendah (< 40%) dan banyak loser di low-mcap
  if (winRate < 0.40) {
    const avgMcapLosers = losers.reduce((s, t) => s + (t.deployed_usd / (t.pnl_pct/100 + 1) || 0), 0) / (losers.length || 1);
    if (avgMcapLosers < cfg.minMcap * 1.5) {
      updates.minMcap = Math.min(cfg.minMcap * 1.2, 1000000); // Naikkan min mcap 20%
      logs.push(`Tightening minMcap to ${updates.minMcap} due to low win rate (${(winRate*100).toFixed(0)}%)`);
    }
  }

  // Logika 2: Relax thresholds if performing exceptionally well
  if (winRate > 0.70) {
    updates.deployAmountSol = Math.min(cfg.deployAmountSol * 1.1, 1.0); // Naikkan exposure 10%
    logs.push(`Boosting deployAmount to ${updates.deployAmountSol} due to strong performance`);
  }

  // Logika 3: OOR Sensitivity
  const oorTrades = recentTrades.filter(t => t.close_reason === 'OUT_OF_RANGE');
  if (oorTrades.length > recentTrades.length * 0.5) {
    // Terlalu banyak OOR — mungkin range terlalu sempit atau wait time terlalu pendek
    updates.outOfRangeWaitMinutes = Math.min(cfg.outOfRangeWaitMinutes + 15, 120);
    logs.push(`Increasing OOR wait time to ${updates.outOfRangeWaitMinutes}m to avoid premature exits`);
  }

  // Evolution Guard: Filter out HARAM keys
  for (const key of PROTECTED_KEYS) {
    if (key in updates) {
      delete updates[key];
      logs.push(`⚠️ Protected key '${key}' blocked from autonomous update.`);
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.lastEvolutionTradeCount = totalClosedCount;
    updateConfig(updates);
    const summary = `🧬 *EVOLUTION COMPLETED*\n\nReasoning:\n${logs.map(l => `• ${l}`).join('\n')}\n\nStats: WinRate ${(winRate*100).toFixed(1)}% | Sample: ${recentTrades.length} trades`;
    addToHistory('system', summary);
    return updates;
  }

  return null;
}

/**
 * Convenience wrapper for the main loop to call periodically.
 * Only sends a notification if an evolution actually occurred.
 */
export async function autoEvolveIfReady(notifyFn) {
  const updates = await runEvolutionCycle();
  if (updates && notifyFn) {
    const keys = Object.keys(updates).join(', ');
    await notifyFn(`🧬 *Autonomous Evolution Occurred*\n\nRecalibrated parameters: \`${keys}\`\nCheck history for detailed reasoning.`);
  }
  return updates;
}
