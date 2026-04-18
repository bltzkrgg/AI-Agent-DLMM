import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSnapshotQuality } from '../src/market/oracle.js';

test('oracle quality penalizes high price divergence and missing cross-check', () => {
  const highDiv = computeSnapshotQuality({
    ohlcv: { historySuccess: true, ta: { supertrend: { source: 'Momentum-Proxy' } } },
    sentiment: { buyPressurePct: 62 },
    jupiterPrice: 1.0,
    dexPrice: 1.08,
    meteoraPrice: 1.09,
    minPriceSources: 2,
    maxAllowedDivergencePct: 3.0,
  });

  assert.equal(highDiv.priceDivergencePct > 3, true);
  assert.equal(highDiv.taConfidence < 0.7, true);
  assert.equal(highDiv.issues.length > 0, true);

  const noJup = computeSnapshotQuality({
    ohlcv: { historySuccess: true, ta: { supertrend: { source: 'Momentum-Proxy' } } },
    sentiment: { buyPressurePct: 55 },
    jupiterPrice: null,
    dexPrice: 1.0,
    meteoraPrice: null,
    minPriceSources: 2,
    maxAllowedDivergencePct: 3.0,
  });

  assert.equal(noJup.priceDivergencePct, 0);
  assert.equal(noJup.issues.some(i => i.includes('Sumber harga kurang')), true);
});

test('oracle quality rewards consistent price cross-check', () => {
  const q = computeSnapshotQuality({
    ohlcv: { historySuccess: true, ta: { supertrend: { source: 'Momentum-Proxy' } } },
    sentiment: { buyPressurePct: 58 },
    jupiterPrice: 1.0,
    dexPrice: 1.01,
    meteoraPrice: 1.0,
    minPriceSources: 2,
    maxAllowedDivergencePct: 3.0,
  });

  assert.equal(q.priceDivergencePct <= 3, true);
  assert.equal(q.taConfidence >= 0.7, true);
  assert.equal(q.priceSources.available >= 2, true);
});
