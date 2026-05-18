import test from 'node:test';
import assert from 'node:assert/strict';

import { getOHLCV } from '../src/market/oracle.js';

function makeMeteoraCandles5m(count = 13, { base = 100, step = 1 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - (count * 300);
  return Array.from({ length: count }, (_, i) => {
    const open = base + (i * step);
    const close = open + 0.5;
    return {
      timestamp: start + (i * 300),
      open,
      high: close + 0.2,
      low: open - 0.2,
      close,
      volume: 100 + i,
    };
  });
}

function makeDexCandles15m(count = 12) {
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - ((count - 1) * 900);
  return Array.from({ length: count }, (_, i) => ([
    start + (i * 900),
    100 + i,
    101 + i,
    99 + i,
    100.5 + i,
    50 + i,
  ]));
}

test('Meteora DLMM OHLCV parser uses timeframe=5m and exposes entry/m5 fields', async () => {
  const originalFetch = global.fetch;
  const seenUrls = [];
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      seenUrls.push(asString);
      if (asString.includes('/pools/PoolMeteora1111111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            timeframe: '5m',
            data: makeMeteoraCandles5m(15),
          }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintMeteora1111111111111111111111111111111111',
      'PoolMeteora1111111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );

    assert.equal(out?.source, 'meteora-dlmm-ohlcv');
    assert.equal(out?.historySuccess, true);
    assert.equal(Array.isArray(out?.entryCandles5m), true);
    assert.equal(out?.entryCandles5m?.length >= 12, true);
    assert.equal(Number.isFinite(out?.priceChangeM5), true);
    assert.equal(Number.isFinite(out?.entryCandle5m?.volume), true);
    const meteoraUrl = seenUrls.find((u) => u.includes('/ohlcv?timeframe=5m'));
    assert.equal(Boolean(meteoraUrl), true);
    assert.equal(seenUrls.some((u) => u.includes('interval=5m')), false);
    assert.equal(seenUrls.some((u) => u.includes('timeframe=15m')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Meteora DLMM OHLCV cache reuses fresh pool+timeframe data', async () => {
  const originalFetch = global.fetch;
  let meteoraCalls = 0;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolCache111111111111111111111111111111111111/ohlcv?timeframe=5m')) {
        meteoraCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteoraCandles5m(13) }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const tokenMint = 'MintCache1111111111111111111111111111111111111';
    const poolAddress = 'PoolCache111111111111111111111111111111111111';
    const first = await getOHLCV(tokenMint, poolAddress, { includeEntryCandles5m: true });
    const second = await getOHLCV(tokenMint, poolAddress, { includeEntryCandles5m: true });
    assert.equal(first?.source, 'meteora-dlmm-ohlcv');
    assert.equal(second?.source, 'meteora-dlmm-ohlcv');
    assert.equal(meteoraCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Meteora failure cooldown suppresses repeated 5m OHLCV retries on same pool', async () => {
  const originalFetch = global.fetch;
  let meteoraCalls = 0;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolFail1111111111111111111111111111111111111/ohlcv?timeframe=5m')) {
        meteoraCalls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) {
        return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      }
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [] } }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('api.jup.ag/price/v1')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const tokenMint = 'MintFail11111111111111111111111111111111111111';
    const poolAddress = 'PoolFail1111111111111111111111111111111111111';
    await getOHLCV(tokenMint, poolAddress);
    await getOHLCV(tokenMint, poolAddress);
    assert.equal(meteoraCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Meteora success does not require DexScreener candles or Birdeye', async () => {
  const originalFetch = global.fetch;
  let dexCalls = 0;
  let birdeyeCalls = 0;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolPrimary11111111111111111111111111111111111/ohlcv?timeframe=5m')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteoraCandles5m(13) }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/') || asString.includes('io.dexscreener.com/dex/candles/')) {
        dexCalls += 1;
      }
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) {
        birdeyeCalls += 1;
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintPrimary11111111111111111111111111111111111',
      'PoolPrimary11111111111111111111111111111111111'
    );
    assert.equal(out?.source, 'meteora-dlmm-ohlcv');
    assert.equal(dexCalls, 0);
    assert.equal(birdeyeCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('when Meteora 5m fails, DexScreener/Birdeye fallback path still works', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolFallback111111111111111111111111111111111/ohlcv?timeframe=5m')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pairs: [{
              pairAddress: 'PairFallback11111111111111111111111111111111',
              priceChange: { m5: 1.2, h1: 0.8 },
              txns: { h1: { buys: 12, sells: 5 } },
            }],
          }),
        };
      }
      if (asString.includes('io.dexscreener.com/dex/candles/v3/solana/PairFallback11111111111111111111111111111111?res=15')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ candles: makeDexCandles15m(12) }),
        };
      }
      if (asString.includes('io.dexscreener.com/dex/candles/v3/solana/PairFallback11111111111111111111111111111111?res=5')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ candles: makeDexCandles15m(12) }),
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintFallback111111111111111111111111111111111',
      'PoolFallback111111111111111111111111111111111'
    );
    assert.equal(out?.source, 'dexscreener-ohlcv');
    assert.equal(out?.historySuccess, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('when all OHLCV sources fail, oracle stays unknown (null) for fail-closed queue hold', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolAllFail11111111111111111111111111111111111/ohlcv?timeframe=5m')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) {
        return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      }
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [] } }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('api.jup.ag/price/v1')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintAllFail11111111111111111111111111111111111',
      'PoolAllFail11111111111111111111111111111111111'
    );
    assert.equal(out, null);
  } finally {
    global.fetch = originalFetch;
  }
});
