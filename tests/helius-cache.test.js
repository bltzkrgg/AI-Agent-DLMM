import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('priority fee cache reuses the same normalized account set', async () => {
  process.env.HELIUS_API_KEY = 'test-key';
  const helius = await importFresh(join(repoRoot, 'src/utils/helius.js'));
  helius.__resetHeliusCachesForTests();

  let rpcCalls = 0;
  const originalFetch = global.fetch;

  try {
    global.fetch = async () => {
      rpcCalls += 1;
      return {
        ok: true,
        json: async () => ({
          result: [
            { prioritizationFee: 10000 },
            { prioritizationFee: 20000 },
            { prioritizationFee: 30000 },
          ],
        }),
      };
    };

    const first = await helius.getRecommendedPriorityFee(['B', 'A', 'A']);
    const second = await helius.getRecommendedPriorityFee(['A', 'B']);

    assert.equal(first, 30000);
    assert.equal(second, 30000);
    assert.equal(rpcCalls, 1);
  } finally {
    global.fetch = originalFetch;
    helius.__resetHeliusCachesForTests();
    delete process.env.HELIUS_API_KEY;
  }
});

test('on-chain signal cache dedupes concurrent calls for the same mint', async () => {
  process.env.HELIUS_API_KEY = 'test-key';
  const helius = await importFresh(join(repoRoot, 'src/utils/helius.js'));
  helius.__resetHeliusCachesForTests();

  let largestCalls = 0;
  let supplyCalls = 0;
  let activityCalls = 0;
  const originalFetch = global.fetch;

  try {
    global.fetch = async (_url, options = {}) => {
      const payload = JSON.parse(options.body);
      if (payload.method === 'getTokenLargestAccounts') {
        largestCalls += 1;
        return {
          ok: true,
          json: async () => ({ result: { value: [{ uiAmount: 50 }, { uiAmount: 25 }] } }),
        };
      }
      if (payload.method === 'getTokenSupply') {
        supplyCalls += 1;
        return {
          ok: true,
          json: async () => ({ result: { value: { uiAmount: 100 } } }),
        };
      }
      if (payload.method === 'getSignaturesForAddress') {
        activityCalls += 1;
        return {
          ok: true,
          json: async () => ({ result: [{ signature: '1' }, { signature: '2' }, { signature: '3' }, { signature: '4' }, { signature: '5' }] }),
        };
      }
      throw new Error(`unexpected method: ${payload.method}`);
    };

    const [a, b] = await Promise.all([
      helius.getHeliusOnChainSignals('Mint111'),
      helius.getHeliusOnChainSignals('Mint111'),
    ]);

    assert.equal(a.available, true);
    assert.equal(b.available, true);
    assert.equal(largestCalls, 1);
    assert.equal(supplyCalls, 1);
    assert.equal(activityCalls, 1);
  } finally {
    global.fetch = originalFetch;
    helius.__resetHeliusCachesForTests();
    delete process.env.HELIUS_API_KEY;
  }
});
