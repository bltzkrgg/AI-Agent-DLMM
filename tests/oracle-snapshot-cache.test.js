import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('market snapshot cache reuses identical requests within the same ttl window', async () => {
  process.env.HELIUS_API_KEY = 'test-key';
  const oracle = await importFresh(join(repoRoot, 'src/market/oracle.js'));
  oracle.__resetMarketSnapshotCacheForTests();

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosedStart = Math.floor((nowSec - 400) / 300) * 300;
  const firstClosedStart = lastClosedStart - (19 * 300);

  try {
    global.fetch = async (url, options = {}) => {
      fetchCalls += 1;
      const asString = String(url || '');
      if (asString.includes('/pools/PoolSnapshot111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            timeframe: '5m',
            data: Array.from({ length: 20 }, (_, i) => ({
              timestamp: firstClosedStart + (i * 300),
              open: 1 + i,
              high: 1.1 + i,
              low: 0.9 + i,
              close: 1.05 + i,
              volume: 100 + i,
            })),
          }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('/pools/PoolSnapshot111') && !asString.includes('/ohlcv') && !asString.includes('/top-lpers') && !asString.includes('/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'Pool Snapshot',
            tvl: 1000,
            fees: { '24h': 20 },
            volume: { '24h': 500 },
            fee_tvl_ratio: { '24h': 0.02 },
            pool_config: { bin_step: 100 },
            token_x: { address: 'MintSnapshot111' },
            token_y: { address: 'So11111111111111111111111111111111111111112', price: 1 },
            active_bin_price: 1.2,
            created_at: new Date().toISOString(),
          }),
        };
      }
      if (asString.includes('/pair/all_by_groups')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ pairInfos: [{ pairAddress: 'PoolSnapshot111', binStep: 100, currentPrice: 1.23, liquidity: 1000, tradeVolume24h: 500, fees24h: 20, currentFeeRate: 0.003, reserveXAmount: 10, reserveYAmount: 20, mintX: 'MintSnapshot111', mintY: 'So11111111111111111111111111111111111111112' }] }],
          }),
        };
      }
      if (asString.includes('/top-lpers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([]),
        };
      }
      if (asString.includes('api.jup.ag/price') || asString.includes('lite-api.jup.ag/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { MintSnapshot111: { price: 1.2 } } }),
        };
      }
      if (asString.includes('/tokens/sol/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { price: 1.2, fdv: 1000000, buys: 10, sells: 5, buyVolume: 100, sellVolume: 50 } }),
        };
      }
      if (asString.includes('openapi.gmgn.ai')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: {
              symbol: 'SNAP',
              market_cap: 1000000,
              liquidity: 50000,
              price: 1.2,
            },
          }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('/pools/PoolSnapshot111/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ price: 1.2 }),
        };
      }

      const payload = options.body ? JSON.parse(options.body) : null;
      if (payload?.method === 'getTokenLargestAccounts') {
        return { ok: true, json: async () => ({ result: { value: [{ uiAmount: 50 }, { uiAmount: 25 }] } }) };
      }
      if (payload?.method === 'getTokenSupply') {
        return { ok: true, json: async () => ({ result: { value: { uiAmount: 100 } } }) };
      }
      if (payload?.method === 'getSignaturesForAddress') {
        return { ok: true, json: async () => ({ result: [{ signature: '1' }, { signature: '2' }, { signature: '3' }, { signature: '4' }, { signature: '5' }] }) };
      }

      throw new Error(`unexpected fetch: ${asString}`);
    };

    const first = await oracle.getMarketSnapshot('MintSnapshot111', 'PoolSnapshot111', { includeEntryCandles5m: true });
    const second = await oracle.getMarketSnapshot('MintSnapshot111', 'PoolSnapshot111', { includeEntryCandles5m: true });

    assert.equal(Boolean(first?.quality), true);
    assert.deepEqual(second, first);
    assert.equal(fetchCalls > 0, true);
    const afterSecond = fetchCalls;

    await oracle.getMarketSnapshot('MintSnapshot111', 'PoolSnapshot111', { includeEntryCandles5m: false });
    assert.equal(fetchCalls > afterSecond, true);
  } finally {
    global.fetch = originalFetch;
    oracle.__resetMarketSnapshotCacheForTests();
    delete process.env.HELIUS_API_KEY;
  }
});

test('market snapshot timing-only mode skips Helius soft signals and bypassCache forces a fresh fetch', async () => {
  process.env.HELIUS_API_KEY = 'test-key';
  const oracle = await importFresh(join(repoRoot, 'src/market/oracle.js'));
  oracle.__resetMarketSnapshotCacheForTests();

  let fetchCalls = 0;
  let rpcCalls = 0;
  let ohlcvCalls = 0;
  let currentVersion = 0;
  const originalFetch = global.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosedStart = Math.floor((nowSec - 400) / 300) * 300;
  const firstClosedStart = lastClosedStart - (19 * 300);

  try {
    global.fetch = async (url, options = {}) => {
      fetchCalls += 1;
      const asString = String(url || '');
      if (asString.includes('/pools/PoolSnapshot222/ohlcv')) {
        ohlcvCalls += 1;
        currentVersion = ohlcvCalls;
        const base = 1 + (currentVersion * 0.1);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            timeframe: '5m',
            data: Array.from({ length: 20 }, (_, i) => ({
              timestamp: firstClosedStart + (i * 300),
              open: base + i,
              high: base + 0.1 + i,
              low: base - 0.1 + i,
              close: base + 0.05 + i,
              volume: 100 + i,
            })),
          }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('/pools/PoolSnapshot222') && !asString.includes('/ohlcv') && !asString.includes('/top-lpers') && !asString.includes('/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'Pool Snapshot 222',
            tvl: 1000,
            fees: { '24h': 20 },
            volume: { '24h': 500 },
            fee_tvl_ratio: { '24h': 0.02 },
            pool_config: { bin_step: 100 },
            token_x: { address: 'MintSnapshot222' },
            token_y: { address: 'So11111111111111111111111111111111111111112', price: 1 },
            active_bin_price: 1.2 + (currentVersion * 0.1),
            created_at: new Date().toISOString(),
          }),
        };
      }
      if (asString.includes('/pair/all_by_groups')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ pairInfos: [{ pairAddress: 'PoolSnapshot222', binStep: 100, currentPrice: 1.23 + (currentVersion * 0.1), liquidity: 1000, tradeVolume24h: 500, fees24h: 20, currentFeeRate: 0.003, reserveXAmount: 10, reserveYAmount: 20, mintX: 'MintSnapshot222', mintY: 'So11111111111111111111111111111111111111112' }] }],
          }),
        };
      }
      if (asString.includes('/top-lpers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([]),
        };
      }
      if (asString.includes('api.jup.ag/price') || asString.includes('lite-api.jup.ag/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { MintSnapshot222: { price: 1.2 + (currentVersion * 0.1) } } }),
        };
      }
      if (asString.includes('/tokens/sol/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { price: 1.2 + (currentVersion * 0.1), fdv: 1000000, buys: 10, sells: 5, buyVolume: 100, sellVolume: 50 } }),
        };
      }
      if (asString.includes('openapi.gmgn.ai')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: {
              symbol: 'SN2',
              market_cap: 1000000,
              liquidity: 50000,
              price: 1.2 + (currentVersion * 0.1),
            },
          }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('/pools/PoolSnapshot222/price')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ price: 1.2 + (currentVersion * 0.1) }),
        };
      }

      const payload = options.body ? JSON.parse(options.body) : null;
      if (payload?.method === 'getTokenLargestAccounts') {
        rpcCalls += 1;
        return { ok: true, json: async () => ({ result: { value: [{ uiAmount: 50 }, { uiAmount: 25 }] } }) };
      }
      if (payload?.method === 'getTokenSupply') {
        rpcCalls += 1;
        return { ok: true, json: async () => ({ result: { value: { uiAmount: 100 } } }) };
      }
      if (payload?.method === 'getSignaturesForAddress') {
        rpcCalls += 1;
        return { ok: true, json: async () => ({ result: [{ signature: '1' }, { signature: '2' }, { signature: '3' }, { signature: '4' }, { signature: '5' }] }) };
      }

      throw new Error(`unexpected fetch: ${asString}`);
    };

    const first = await oracle.getMarketSnapshot('MintSnapshot222', 'PoolSnapshot222', {
      includeEntryCandles5m: true,
      includeOnChainSignals: false,
    });
    const second = await oracle.getMarketSnapshot('MintSnapshot222', 'PoolSnapshot222', {
      includeEntryCandles5m: true,
      includeOnChainSignals: false,
    });

    assert.equal(first?.onChain, null);
    assert.equal(first?.snapshotMode, 'timing-only');
    assert.equal(first?.includeOnChainSignals, false);
    assert.deepEqual(second, first);
    assert.equal(rpcCalls, 0);
    assert.equal(ohlcvCalls, 1);

    const refreshed = await oracle.getMarketSnapshot('MintSnapshot222', 'PoolSnapshot222', {
      includeEntryCandles5m: true,
      includeOnChainSignals: false,
      bypassCache: true,
    });

    assert.equal(rpcCalls, 0);
    assert.equal(ohlcvCalls, 2);
    assert.notEqual(refreshed?.ohlcv?.currentPrice, first?.ohlcv?.currentPrice);

    const fullSignals = await oracle.getMarketSnapshot('MintSnapshot222', 'PoolSnapshot222', {
      includeEntryCandles5m: true,
      includeOnChainSignals: true,
      bypassCache: true,
    });

    assert.equal(fullSignals?.onChain?.available, true);
    assert.equal(fullSignals?.snapshotMode, 'full-context');
    assert.equal(fullSignals?.includeOnChainSignals, true);
    assert.equal(rpcCalls, 3);
    assert.equal(fetchCalls > 0, true);
  } finally {
    global.fetch = originalFetch;
    oracle.__resetMarketSnapshotCacheForTests();
    delete process.env.HELIUS_API_KEY;
  }
});
