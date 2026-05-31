import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy, parseStrategyParameters } from '../src/strategies/strategyManager.js';

test('parseStrategyParameters preserves Evil Panda range and maps strategyType from resolved shape', () => {
  const evilPanda = getStrategy('Evil Panda');
  const parsed = parseStrategyParameters(evilPanda);

  assert.equal(parsed.priceRangePercent, 94);
  assert.ok(parsed.dlmmLiquidityShape === 'spot' || parsed.dlmmLiquidityShape === 'bidask');
  const expectedStrategyType = parsed.dlmmLiquidityShape === 'bidask' ? 2 : 0;
  assert.equal(parsed.strategyType, expectedStrategyType);
  assert.equal(parsed.tokenXWeight, expectedStrategyType === 2 ? 0 : 50);
  assert.equal(parsed.tokenYWeight, expectedStrategyType === 2 ? 100 : 50);
});

test('parseStrategyParameters honors explicit deploy strategyType override', () => {
  const strategy = {
    type: 'single_side_y',
    parameters: { binStep: 100 },
    deploy: {
      entryPriceOffsetMin: 10,
      entryPriceOffsetMax: 40,
      strategyType: 1,
    },
  };

  const parsed = parseStrategyParameters(strategy);
  assert.equal(parsed.priceRangePercent, 30);
  assert.equal(parsed.strategyType, 1);
});
