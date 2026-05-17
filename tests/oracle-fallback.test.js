import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getOHLCV } from '../src/market/oracle.js';

test('oracle keeps poolAddress as first-class input in OHLCV resolution path', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/market/oracle.js'), 'utf8');
  assert.match(src, /resolveDexScreenerPairContext\(tokenMint, poolAddress \|\| null\)/);
  assert.match(src, /buildPoolSpecificMeridianFallback\(tokenMint, poolAddress \|\| null\)/);
});

test('oracle fallback cache avoids repeated fetch calls within TTL', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  try {
    global.fetch = async (url) => {
      fetchCalls += 1;
      const asString = String(url || '');
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pairs: [{ pairAddress: 'AnotherPair111111111111111111111111111111111', priceChange: { m5: 1.2, h1: 0.7 }, txns: { h1: { buys: 10, sells: 5 } } }],
          }),
        };
      }
      if (asString.includes('io.dexscreener.com/dex/candles/v3/solana/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ candles: [] }),
        };
      }
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [] } }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('/chart-indicators/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ latest: { supertrend: { direction: 'bullish' }, price_change_m5: 1.1, close: 1 } }),
        };
      }
      if (asString.includes('/price-info/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ price: 1, price_change_m5: 1.1, price_change_h1: 0.7 }),
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const tokenMint = 'Mint111111111111111111111111111111111111111';
    const poolAddress = 'Pool11111111111111111111111111111111111111';
    const first = await getOHLCV(tokenMint, poolAddress);
    const second = await getOHLCV(tokenMint, poolAddress);
    assert.equal(first?.source, 'meridian-fallback');
    assert.equal(second?.source, 'meridian-fallback');
    assert.equal(fetchCalls < 11, true);
  } finally {
    global.fetch = originalFetch;
  }
});
