import test from 'node:test';
import assert from 'node:assert/strict';

import { getOHLCV } from '../src/market/oracle.js';

function makeMeteora5mRowsClosed(count = 13, { nowSec = Math.floor(Date.now() / 1000), base = 100 } = {}) {
  const lastClosedStart = Math.floor((nowSec - 400) / 300) * 300;
  const start = lastClosedStart - ((count - 1) * 300);
  return Array.from({ length: count }, (_, i) => {
    const open = base + i;
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

function makeMeteora5mRowsWithOpenTail({
  nowSec = Math.floor(Date.now() / 1000),
  closedCount = 13,
  base = 100,
} = {}) {
  const closed = makeMeteora5mRowsClosed(closedCount, { nowSec, base });
  const currentOpenStart = Math.floor(nowSec / 300) * 300;
  const open = base + closedCount;
  const openTail = {
    timestamp: currentOpenStart,
    open,
    high: open + 0.2,
    low: open - 0.2,
    close: open + 0.1,
    volume: 999,
  };
  return [...closed, openTail];
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

test('Meteora request uses timeframe=5m with start_time/end_time and never uses interval or 15m timeframe', async () => {
  const originalFetch = global.fetch;
  const seenUrls = [];
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      seenUrls.push(asString);
      if (asString.includes('/pools/PoolUrl11111111111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(30) }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintUrl111111111111111111111111111111111111111',
      'PoolUrl11111111111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );
    assert.equal(out?.source, 'meteora-dlmm-ohlcv');

    const meteoraUrl = seenUrls.find((u) => u.includes('/ohlcv?timeframe=5m'));
    assert.equal(Boolean(meteoraUrl), true);
    const parsed = new URL(meteoraUrl);
    const startTime = Number(parsed.searchParams.get('start_time'));
    const endTime = Number(parsed.searchParams.get('end_time'));
    assert.equal(Number.isFinite(startTime), true);
    assert.equal(Number.isFinite(endTime), true);
    assert.equal(endTime > startTime, true);
    assert.equal(endTime - startTime >= 3 * 60 * 60, true);
    assert.equal(seenUrls.some((u) => u.includes('interval=5m')), false);
    assert.equal(seenUrls.some((u) => u.includes('timeframe=15m')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('closed-candle filter drops current open 5m candle and uses last closed for entryCandle5m', async () => {
  const originalFetch = global.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolClosed1111111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            timeframe: '5m',
            data: makeMeteora5mRowsWithOpenTail({ nowSec, closedCount: 14 }),
          }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintClosed11111111111111111111111111111111111',
      'PoolClosed1111111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );

    assert.equal(out?.source, 'meteora-dlmm-ohlcv');
    assert.equal(out?.providerTrace?.droppedOpenCandle, true);
    const lastClosed = out?.entryCandles5m?.[out.entryCandles5m.length - 1];
    assert.equal(out?.entryCandle5m?.time, lastClosed?.time);
    assert.equal((out?.entryCandle5m?.time + 300) <= (Math.floor(Date.now() / 1000) - 10), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('enough 5m closed candles populates M5 and entry candle data', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolEnough5m11111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(20) }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintEnough5m111111111111111111111111111111111',
      'PoolEnough5m11111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );

    assert.equal(out?.entry5mHistorySuccess, true);
    assert.equal(Number.isFinite(out?.priceChangeM5), true);
    assert.equal(Boolean(out?.entryCandle5m), true);
    assert.equal(Array.isArray(out?.entryCandles5m), true);
    assert.equal(out?.entryCandles5m?.length >= 13, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('insufficient 5m closed candles marks reliability false and includes insufficient reason', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolInsufficient5m1111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(5) }),
          headers: { get: () => null },
        };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) return { ok: true, status: 200, json: async () => ({ data: { items: [] } }), headers: { get: () => null } };
      if (asString.includes('api.jup.ag/price/v1')) return { ok: false, status: 503, json: async () => ({}) };
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintInsufficient5m111111111111111111111111111',
      'PoolInsufficient5m1111111111111111111111111111',
      { includeEntryCandles5m: true }
    );
    assert.equal(out?.source, 'meteora-dlmm-ohlcv');
    assert.equal(out?.historySuccess, false);
    assert.equal(out?.entry5mHistorySuccess, false);
    assert.equal(out?.fallbackReliable, false);
    assert.match(String(out?.providerTrace?.reason || ''), /INSUFFICIENT/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('5m enough but 15m aggregate insufficient keeps trend UNKNOWN while entry data stays available', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolSplit111111111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(20) }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintSplit1111111111111111111111111111111111111',
      'PoolSplit111111111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );
    assert.equal(out?.entry5mHistorySuccess, true);
    assert.equal(out?.aggregated15mHistorySuccess, false);
    assert.equal(out?.historySuccess, true);
    assert.equal(out?.ta?.supertrend?.trend, 'UNKNOWN');
    assert.equal(Boolean(out?.entryCandle5m), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('enough 15m aggregate from 5m can expose non-UNKNOWN trend metadata', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolEnough15m11111111111111111111111111111111/ohlcv')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(60) }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch URL: ${asString}`);
    };

    const out = await getOHLCV(
      'MintEnough15m111111111111111111111111111111111',
      'PoolEnough15m11111111111111111111111111111111',
      { includeEntryCandles5m: true }
    );
    assert.equal(out?.entry5mHistorySuccess, true);
    assert.equal(out?.aggregated15mHistorySuccess, true);
    assert.equal(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(String(out?.ta?.supertrend?.trend)), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Meteora cache reuses fresh pool+timeframe data', async () => {
  const originalFetch = global.fetch;
  let meteoraCalls = 0;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolCache111111111111111111111111111111111111/ohlcv')) {
        meteoraCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ timeframe: '5m', data: makeMeteora5mRowsClosed(20) }),
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

test('Meteora failure cooldown suppresses repeated 5m retries on same pool', async () => {
  const originalFetch = global.fetch;
  let meteoraCalls = 0;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolFail1111111111111111111111111111111111111/ohlcv')) {
        meteoraCalls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) return { ok: true, status: 200, json: async () => ({ data: { items: [] } }), headers: { get: () => null } };
      if (asString.includes('api.jup.ag/price/v1')) return { ok: false, status: 503, json: async () => ({}) };
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

test('when Meteora fails, DexScreener fallback can still succeed', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolFallback111111111111111111111111111111111/ohlcv')) {
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
        return { ok: true, status: 200, json: async () => ({ candles: makeDexCandles15m(12) }) };
      }
      if (asString.includes('io.dexscreener.com/dex/candles/v3/solana/PairFallback11111111111111111111111111111111?res=5')) {
        return { ok: true, status: 200, json: async () => ({ candles: makeDexCandles15m(12) }) };
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

test('when all OHLCV sources fail, oracle remains null (unknown) for fail-closed HOLD', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const asString = String(url || '');
      if (asString.includes('/pools/PoolAllFail11111111111111111111111111111111111/ohlcv')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (asString.includes('api.dexscreener.com/latest/dex/tokens/')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      if (asString.includes('public-api.birdeye.so/defi/ohlcv')) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [] } }), headers: { get: () => null } };
      }
      if (asString.includes('api.jup.ag/price/v1')) return { ok: false, status: 503, json: async () => ({}) };
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
