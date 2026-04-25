import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

function mockFetchWithCandles(candles) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ candles }),
  });
}

function setupEnv(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');
  process.env.BOT_MEMORY_PATH = join(root, 'memory.json');
  writeFileSync(process.env.BOT_MEMORY_PATH, JSON.stringify({ instincts: [], closedTrades: [], marketEvents: [] }, null, 2));
}

test('Evil Panda readiness blocks weak fee productivity', async () => {
  const originalFetch = global.fetch;
  setupEnv('dlmm-panda-fee-');
  mockFetchWithCandles([
    { t: 0, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 1000 },
    { t: 900, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 1200 },
    { t: 1800, o: 1.2, h: 1.25, l: 1.15, c: 1.22, v: 900 },
  ]);

  try {
    const mod = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));
    const result = await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      snapshot: {
        poolAddress: 'pool-1',
        ohlcv: { priceChangeM5: 0.8, priceChangeH1: 2.0 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.005, tvl: 100000, volume24h: 120000, feeApr: 40 },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Fee\/TVL harian terlalu rendah/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Evil Panda readiness passes on first green momentum with calm probe', async () => {
  const originalFetch = global.fetch;
  setupEnv('dlmm-panda-candles-');
  mockFetchWithCandles([
    { t: 0, o: 1, h: 1.1, l: 0.95, c: 0.98, v: 1000 },
    { t: 900, o: 0.98, h: 1.0, l: 0.9, c: 0.96, v: 900 },
    { t: 1800, o: 0.96, h: 0.99, l: 0.95, c: 0.97, v: 800 },
  ]);

  try {
    const mod = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));
    const result = await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      snapshot: {
        poolAddress: 'pool-2',
        ohlcv: { priceChangeM5: 0.7, priceChangeH1: 1.5 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.02, tvl: 100000, volume24h: 180000, feeApr: 120 },
      },
    });

    assert.equal(result.ok, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Evil Panda readiness blocks weakening fee velocity across multiple samples', async () => {
  const originalFetch = global.fetch;
  setupEnv('dlmm-panda-velocity-');
  mockFetchWithCandles([
    { t: 0, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 1000 },
    { t: 900, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 1200 },
    { t: 1800, o: 1.2, h: 1.25, l: 1.15, c: 1.22, v: 900 },
  ]);

  try {
    const mod = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));
    await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      activeBinId: 1000,
      snapshot: {
        poolAddress: 'pool-3',
        ohlcv: { priceChangeM5: 0.8, priceChangeH1: 2.0 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.02, tvl: 100000, volume24h: 180000, feeApr: 120 },
      },
    });
    await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      activeBinId: 1000,
      snapshot: {
        poolAddress: 'pool-3',
        ohlcv: { priceChangeM5: 0.7, priceChangeH1: 1.8 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.017, tvl: 100000, volume24h: 175000, feeApr: 110 },
      },
    });
    const result = await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      activeBinId: 1000,
      snapshot: {
        poolAddress: 'pool-3',
        ohlcv: { priceChangeM5: 0.6, priceChangeH1: 1.4 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.013, tvl: 100000, volume24h: 170000, feeApr: 90 },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Fee velocity/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Evil Panda readiness blocks bad historical regime from memory', async () => {
  const originalFetch = global.fetch;
  setupEnv('dlmm-panda-regime-');
  writeFileSync(process.env.BOT_MEMORY_PATH, JSON.stringify({
    instincts: [],
    closedTrades: [
      { strategy: 'Evil Panda', profitable: false, pnlPct: -5.2, marketAtEntry: { trend: 'UPTREND' }, volatility: 'MEDIUM' },
      { strategy: 'Evil Panda', profitable: false, pnlPct: -4.1, marketAtEntry: { trend: 'UPTREND' }, volatility: 'MEDIUM' },
      { strategy: 'Evil Panda', profitable: false, pnlPct: -3.7, marketAtEntry: { trend: 'UPTREND' }, volatility: 'MEDIUM' }
    ],
    marketEvents: []
  }, null, 2));
  mockFetchWithCandles([
    { t: 0, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 1000 },
    { t: 900, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 1200 },
    { t: 1800, o: 1.2, h: 1.25, l: 1.15, c: 1.22, v: 900 },
  ]);

  try {
    const mod = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));
    const result = await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      activeBinId: 2000,
      snapshot: {
        poolAddress: 'pool-4',
        ohlcv: { priceChangeM5: 0.8, priceChangeH1: 2.1, trend: 'UPTREND', volatilityCategory: 'MEDIUM' },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.02, tvl: 100000, volume24h: 180000, feeApr: 120 },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Regime memory/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Evil Panda readiness blocks stale 1h candle data', async () => {
  const originalFetch = global.fetch;
  setupEnv('dlmm-panda-stale-');
  mockFetchWithCandles([
    { t: 0, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 1000 },
    { t: 900, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 1200 },
    { t: 1800, o: 1.2, h: 1.25, l: 1.15, c: 1.22, v: 900 },
  ]);

  try {
    const mod = await importFresh(join(repoRoot, 'src/market/strategyLibrary.js'));
    const result = await mod.evaluateStrategyReadiness({
      strategyName: 'Evil Panda',
      binStep: 100,
      snapshot: {
        poolAddress: 'pool-stale',
        ohlcv: { priceChangeM5: 0.9, priceChangeH1: 2.3, historyAgeMinutes: 250, atrPct: 3.2 },
        ta: { supertrend: { trend: 'BULLISH' } },
        pool: { feeTvlRatio: 0.02, tvl: 100000, volume24h: 200000, feeApr: 140 },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /stale/i);
  } finally {
    global.fetch = originalFetch;
  }
});
