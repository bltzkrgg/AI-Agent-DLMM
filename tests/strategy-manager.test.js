import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy, parseStrategyParameters } from '../src/strategies/strategyManager.js';

test('parseStrategyParameters preserves Evil Panda wide range and maps single_side_y to strategyType 2', () => {
  const evilPanda = getStrategy('Evil Panda');
  const parsed = parseStrategyParameters(evilPanda);

  assert.equal(parsed.priceRangePercent, 94);
  assert.equal(parsed.strategyType, 2);
  assert.equal(parsed.tokenXWeight, 0);
  assert.equal(parsed.tokenYWeight, 100);
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
