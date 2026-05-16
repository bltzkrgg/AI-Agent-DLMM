import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('pool impact guard evaluates stable and emergency conditions deterministically', async () => {
  const { evaluatePoolImpactGuard, countConsecutiveDownTicks } = await importFresh(
    join(repoRoot, 'src/risk/poolImpactGuard.js')
  );

  const stable = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 100,
    previousActiveBin: 100,
    entryPrice: 1,
    currentPrice: 1,
    previousPrice: 1,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [{ activeBin: 100, price: 1 }, { activeBin: 100, price: 1 }],
  });
  assert.equal(stable.action, 'PASS');

  const smallDrop = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 99,
    previousActiveBin: 100,
    entryPrice: 1,
    currentPrice: 0.975,
    previousPrice: 1,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [{ activeBin: 100, price: 1 }, { activeBin: 99, price: 0.975 }],
  });
  assert.notEqual(smallDrop.action, 'FORCE_EXIT');

  const forceByDrop = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 96,
    previousActiveBin: 97,
    entryPrice: 1,
    currentPrice: 0.93,
    previousPrice: 0.95,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [
      { activeBin: 100, price: 1 },
      { activeBin: 98, price: 0.97 },
      { activeBin: 97, price: 0.95 },
      { activeBin: 96, price: 0.93 },
    ],
  });
  assert.equal(forceByDrop.action, 'FORCE_EXIT');

  const forceByLower = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 90,
    previousActiveBin: 91,
    entryPrice: 1,
    currentPrice: 0.9,
    previousPrice: 0.91,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [{ activeBin: 91, price: 0.91 }, { activeBin: 90, price: 0.9 }],
  });
  assert.equal(forceByLower.action, 'FORCE_EXIT');

  const forceByConsecutive = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 93,
    previousActiveBin: 94,
    entryPrice: 1,
    currentPrice: 0.96,
    previousPrice: 0.97,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [
      { activeBin: 100, price: 1 },
      { activeBin: 98, price: 0.985 },
      { activeBin: 96, price: 0.975 },
      { activeBin: 94, price: 0.97 },
      { activeBin: 93, price: 0.96 },
    ],
  });
  assert.equal(forceByConsecutive.action, 'FORCE_EXIT');

  const warn = evaluatePoolImpactGuard({
    entryActiveBin: 100,
    currentActiveBin: 98,
    previousActiveBin: 99,
    entryPrice: 1,
    currentPrice: 0.975,
    previousPrice: 0.985,
    lowerBin: 90,
    upperBin: 110,
    recentSamples: [{ activeBin: 100, price: 1 }, { activeBin: 99, price: 0.985 }, { activeBin: 98, price: 0.975 }],
  });
  assert.ok(['WARN', 'PRE_EXIT'].includes(warn.action));

  const safe = evaluatePoolImpactGuard({ currentActiveBin: null, currentPrice: null });
  assert.equal(safe.action, 'PASS');

  assert.equal(countConsecutiveDownTicks([
    { activeBin: 10 },
    { activeBin: 9 },
    { activeBin: 8 },
    { activeBin: 7 },
  ]), 3);
});
