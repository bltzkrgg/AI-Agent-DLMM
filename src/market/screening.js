'use strict';

const PVP_RIVAL_TVL_MULTIPLIER = 10;

// Minimum legitimate fee-to-volume ratio.
// Wash traders inflate volume without paying real swap fees — their ratio sits anomalously low.
// Meteora pools charge 0.2–2% fee tier; organic ratio floor ≈ 0.2% of volume = 0.002.
const WASH_TRADE_FEE_VOLUME_FLOOR = 0.002;

/**
 * Screens an array of pool candidates for wash trading indicators.
 * A pool is flagged when fees24h / volume24h < WASH_TRADE_FEE_VOLUME_FLOOR,
 * meaning volume is anomalously large relative to fees — signature of cyclic self-trading.
 *
 * Skips the check when volume is 0 (avoids dividing by zero and false-flagging new pools
 * with no recorded volume yet — those are handled by age gate upstream).
 *
 * @param {Array} pools - pool objects with { address, name, fees24hRaw, volume24hRaw }
 * @returns {{ clean: Array, vetoed: Array }} split by wash trade verdict
 */
export function filterWashTrading(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return { clean: [], vetoed: [] };

  const clean = [];
  const vetoed = [];

  for (const pool of pools) {
    const fees = parseFloat(pool.fees24hRaw || pool.fees24h || 0) || 0;
    const vol = parseFloat(pool.volume24hRaw || pool.volume24h || 0) || 0;

    if (vol > 0) {
      const feeVolumeRatio = fees / vol;
      if (feeVolumeRatio < WASH_TRADE_FEE_VOLUME_FLOOR) {
        vetoed.push({
          ...pool,
          washTradeVeto: {
            detected: true,
            feeVolumeRatio: parseFloat(feeVolumeRatio.toFixed(6)),
            floor: WASH_TRADE_FEE_VOLUME_FLOOR,
            reason: `Fee/Volume ratio ${(feeVolumeRatio * 100).toFixed(4)}% < floor ${(WASH_TRADE_FEE_VOLUME_FLOOR * 100).toFixed(2)}% — suspected wash trading`,
          },
        });
        continue;
      }
    }

    clean.push({ ...pool, washTradeVeto: { detected: false } });
  }

  return { clean, vetoed };
}

/**
 * Detects PVP risk for each token in the gate batch.
 * A token is flagged if another pool with the same symbol (different mint) has ≥10x higher TVL,
 * indicating a dominant rival pool that will absorb most volume.
 *
 * @param {Array} tokenGate - array of token gate objects with { mint, symbol, dexGate: { liquidityUsd } }
 * @returns {Array} same array with pvpRisk field added to each entry
 */
export function enrichPvpRisk(tokenGate) {
  if (!Array.isArray(tokenGate) || tokenGate.length === 0) return tokenGate;

  // Build symbol → [{ mint, liq }] map (case-insensitive symbol)
  const symbolMap = new Map();
  for (const t of tokenGate) {
    if (!t.mint || !t.symbol) continue;
    const sym = String(t.symbol).toUpperCase().trim();
    const liq = parseFloat(t.dexGate?.liquidityUsd || 0) || 0;
    const bucket = symbolMap.get(sym) || [];
    bucket.push({ mint: t.mint, liq });
    symbolMap.set(sym, bucket);
  }

  return tokenGate.map((t) => {
    if (!t.mint || !t.symbol) return { ...t, pvpRisk: { detected: false } };

    const sym = String(t.symbol).toUpperCase().trim();
    const myLiq = parseFloat(t.dexGate?.liquidityUsd || 0) || 0;
    const rivals = (symbolMap.get(sym) || []).filter((r) => r.mint !== t.mint);

    const dominantRival = rivals
      .sort((a, b) => b.liq - a.liq)
      .find((r) => myLiq === 0 ? r.liq > 0 : r.liq >= myLiq * PVP_RIVAL_TVL_MULTIPLIER);

    if (dominantRival) {
      const tvlRatio = myLiq > 0 ? dominantRival.liq / myLiq : Infinity;
      return {
        ...t,
        pvpRisk: {
          detected: true,
          rivalMint: dominantRival.mint,
          rivalLiquidityUsd: dominantRival.liq,
          myLiquidityUsd: myLiq,
          tvlRatio: Number.isFinite(tvlRatio) ? parseFloat(tvlRatio.toFixed(2)) : null,
          reason: `Rival pool same symbol has ${Number.isFinite(tvlRatio) ? tvlRatio.toFixed(1) + 'x' : '∞'} higher TVL`,
        },
      };
    }

    return { ...t, pvpRisk: { detected: false } };
  });
}
