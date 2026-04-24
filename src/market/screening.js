'use strict';

const PVP_RIVAL_TVL_MULTIPLIER = 10;

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
