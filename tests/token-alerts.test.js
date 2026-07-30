import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenAlertService,
  evaluateTokenAlertCandidate,
  extractGmgnTotalFeesSol,
  extractTopHolderPercentages,
  formatTokenAlertMessage,
  getTokenReferenceTimestamp,
} from '../src/alerts/tokenAlerts.js';

const MINT = 'Gt8JhihdercHUn6nf8Xs3SFf1mSHFjUkjgSLWz7Dpump';
const OTHER_MINTS = [
  'So11111111111111111111111111111111111111112',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iYxU9XR5eS4h',
  'Es9vMFrzaCERmJfrF4H2FYD9iEDnZq7H8JDC6iWvV6h',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6hF1pPB263u4pump',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
];
const NOW = 1_800_000_000_000;
const CONFIG = {
  tokenAlertsEnabled: true,
  tokenAlertsPollIntervalSec: 60,
  tokenAlertsMinVolume5mUsd: 100000,
  tokenAlertsMinMarketCapUsd: 100000,
  tokenAlertsMinTotalFeesSol: 10,
  tokenAlertsMaxAgeMin: 30,
  tokenAlertsMaxPerScan: 5,
};

function candidate(overrides = {}) {
  return {
    address: MINT,
    name: 'Rocky J. Squirrel',
    symbol: 'ROCKY',
    price: 0.0001606,
    market_cap: 100001,
    volume: 100000,
    migrated_timestamp: (NOW - 30 * 60_000) / 1000,
    exchange: 'pump_amm',
    top_10_holder_rate: 0.19,
    buys: 61,
    sells: 39,
    liquidity: 38200,
    totalFeesSol: 10,
    ...overrides,
  };
}

test('locked volume, market cap, total fees, and age boundaries pass', () => {
  const result = evaluateTokenAlertCandidate(candidate(), CONFIG, NOW);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'PASS');
  assert.equal(result.normalized.volume5mUsd, 100000);
  assert.equal(result.normalized.marketCapUsd, 100001);
  assert.equal(result.normalized.totalFeesSol, 10);
  assert.equal(result.normalized.ageMin, 30);
});

test('volume below 100k fails closed', () => {
  const result = evaluateTokenAlertCandidate(candidate({ volume: 99999.99 }), CONFIG, NOW);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'VOLUME_BELOW_MIN');
});

test('market cap exactly 100k fails strict threshold', () => {
  const result = evaluateTokenAlertCandidate(candidate({ market_cap: 100000 }), CONFIG, NOW);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'MCAP_NOT_ABOVE_MIN');
});

test('total fees below 10 SOL and missing fees fail closed', () => {
  const below = evaluateTokenAlertCandidate(candidate({ totalFeesSol: 9.999 }), CONFIG, NOW);
  const missing = evaluateTokenAlertCandidate(candidate({ totalFeesSol: undefined }), CONFIG, NOW);
  assert.equal(below.reason, 'TOTAL_FEES_BELOW_MIN');
  assert.equal(missing.reason, 'TOTAL_FEES_UNKNOWN');
});

test('GMGN total fee extraction follows precedence and rejects trade_fee', () => {
  assert.equal(extractGmgnTotalFeesSol({
    total_fee: '12.5',
    total_fees_sol: 99,
    stat: { total_fees_sol: 88 },
  }), 12.5);
  assert.equal(extractGmgnTotalFeesSol({ fees: { total_sol: '11' } }), 11);
  assert.equal(extractGmgnTotalFeesSol({ fee: { total_sol: 10 } }), 10);
  assert.equal(extractGmgnTotalFeesSol({ trade_fee: 500 }), null);
  assert.equal(extractGmgnTotalFeesSol({ total_fee: -1 }), null);
  assert.equal(extractGmgnTotalFeesSol({ total_fee: '   ' }), null);
  assert.equal(extractGmgnTotalFeesSol({ total_fee: true }), null);
});

test('migration timestamp takes precedence with open and creation fallbacks', () => {
  assert.equal(getTokenReferenceTimestamp({
    migrated_timestamp: 100,
    open_timestamp: 200,
    creation_timestamp: 300,
  }), 100000);
  assert.equal(getTokenReferenceTimestamp({
    migrated_timestamp: 0,
    open_timestamp: 200,
    creation_timestamp: 300,
  }), 200000);
  assert.equal(getTokenReferenceTimestamp({
    migrated_timestamp: null,
    open_timestamp: null,
    creation_timestamp: 300,
  }), 300000);
});

test('unknown age and age over 30 minutes fail closed', () => {
  const unknown = evaluateTokenAlertCandidate(candidate({
    migrated_timestamp: null,
    open_timestamp: null,
    creation_timestamp: null,
  }), CONFIG, NOW);
  const old = evaluateTokenAlertCandidate(candidate({
    migrated_timestamp: (NOW - 30 * 60_000 - 1) / 1000,
  }), CONFIG, NOW);
  assert.equal(unknown.reason, 'AGE_UNKNOWN');
  assert.equal(old.reason, 'TOKEN_TOO_OLD');
});

test('future timestamp fails closed as invalid age', () => {
  const result = evaluateTokenAlertCandidate(candidate({
    migrated_timestamp: (NOW + 1000) / 1000,
  }), CONFIG, NOW);
  assert.equal(result.reason, 'AGE_UNKNOWN');
});

test('already alerted candidate is rejected', () => {
  const result = evaluateTokenAlertCandidate(candidate({ alertedAt: NOW - 1000 }), CONFIG, NOW);
  assert.equal(result.reason, 'ALREADY_ALERTED');
});

test('holder extraction removes pools, exchanges, invalid rows, and sorts wallets', () => {
  const result = extractTopHolderPercentages([
    { addr_type: 0, amount_percentage: 0.021 },
    { addr_type: 2, amount_percentage: 0.50 },
    { addr_type: 0, amount_percentage: 0.094 },
    { addr_type: 0, amount_percentage: 0.07, exchange: 'Binance' },
    { addr_type: 0, amount_percentage: 0 },
    { addr_type: 0, amount_percentage: 3 },
  ]);
  assert.deepEqual(result, [9.4, 3, 2.1]);
});

test('formatter escapes GMGN text, renders optional holder fallback, and links validated mint', () => {
  const normalized = evaluateTokenAlertCandidate(candidate({
    name: '<script>alert(1)</script>',
    symbol: 'R&K',
    dexscr_boost_fee: 1,
  }), CONFIG, NOW).normalized;
  const message = formatTokenAlertMessage({
    ...normalized,
    topHolderPercentages: [],
  });

  assert.doesNotMatch(message, /<script>/);
  assert.match(message, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(message, /R&amp;K/);
  assert.match(message, /TH:\s+<b>N\/A<\/b>/);
  assert.match(message, /Dex Paid:\s+<b>🟢<\/b>/);
  assert.match(message, new RegExp(`https://gmgn\\.ai/sol/token/${MINT}`));
});

test('formatter ignores malformed holder percentages', () => {
  const normalized = evaluateTokenAlertCandidate(candidate(), CONFIG, NOW).normalized;
  const message = formatTokenAlertMessage({
    ...normalized,
    topHolderPercentages: [null, 'bad', 0, -1],
  });
  assert.match(message, /TH:\s+<b>N\/A<\/b>/);
});

function createServiceHarness({
  rows = [candidate()],
  tokenInfo = { total_fee: 10 },
  holders = [],
  sendAlert = async () => true,
  config = CONFIG,
  now = () => NOW,
} = {}) {
  const state = {};
  const sent = [];
  let intervalCalls = 0;
  let clearCalls = 0;
  const service = createTokenAlertService({
    fetchTrending: async () => rows,
    fetchTokenInfo: async () => tokenInfo,
    fetchHolders: async () => holders,
    sendAlert: async (...args) => {
      sent.push(args);
      return sendAlert(...args);
    },
    getConfig: () => config,
    getState: (key) => state[key] || {},
    setState: (key, value) => {
      state[key] = value;
    },
    now,
    setIntervalFn: () => {
      intervalCalls += 1;
      return { interval: intervalCalls };
    },
    clearIntervalFn: () => {
      clearCalls += 1;
    },
  });
  return {
    service,
    state,
    sent,
    get intervalCalls() { return intervalCalls; },
    get clearCalls() { return clearCalls; },
  };
}

test('failed Telegram send does not persist alertedAt and stays retryable', async () => {
  const harness = createServiceHarness({ sendAlert: async () => false });
  const first = await harness.service.scanOnce({ source: 'test' });
  const record = harness.state.tokenAlertsSeen[MINT];
  assert.equal(first.alerted, 0);
  assert.equal(first.failed, 1);
  assert.equal(record.firstSeenAt, NOW);
  assert.equal(record.alertedAt, undefined);

  const second = await harness.service.scanOnce({ source: 'retry' });
  assert.equal(second.failed, 1);
  assert.equal(harness.sent.length, 2);
});

test('successful send persists alertedAt and suppresses duplicate mint', async () => {
  const harness = createServiceHarness();
  const first = await harness.service.scanOnce({ source: 'test' });
  const second = await harness.service.scanOnce({ source: 'repeat' });
  assert.equal(first.alerted, 1);
  assert.equal(harness.state.tokenAlertsSeen[MINT].alertedAt, NOW);
  assert.equal(second.alerted, 0);
  assert.equal(harness.sent.length, 1);
});

test('total-fees gate runs before optional holder enrichment', async () => {
  let holderCalls = 0;
  const state = {};
  const service = createTokenAlertService({
    fetchTrending: async () => [candidate()],
    fetchTokenInfo: async () => ({ total_fee: 9.99 }),
    fetchHolders: async () => {
      holderCalls += 1;
      return [];
    },
    sendAlert: async () => true,
    getConfig: () => CONFIG,
    getState: (key) => state[key] || {},
    setState: (key, value) => {
      state[key] = value;
    },
    now: () => NOW,
  });

  const summary = await service.scanOnce({ source: 'fees-first' });
  assert.equal(summary.alerted, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(holderCalls, 0);
});

test('holder enrichment failure still sends alert with TH N/A', async () => {
  let message = '';
  const state = {};
  const service = createTokenAlertService({
    fetchTrending: async () => [candidate()],
    fetchTokenInfo: async () => ({ total_fee: 10 }),
    fetchHolders: async () => {
      throw new Error('holder unavailable');
    },
    sendAlert: async (text) => {
      message = text;
      return true;
    },
    getConfig: () => CONFIG,
    getState: (key) => state[key] || {},
    setState: (key, value) => {
      state[key] = value;
    },
    now: () => NOW,
  });

  const summary = await service.scanOnce({ source: 'holder-optional' });
  assert.equal(summary.alerted, 1);
  assert.match(message, /TH:\s+<b>N\/A<\/b>/);
});

test('scan sorts by volume and processes no more than maxPerScan', async () => {
  const rows = [MINT, ...OTHER_MINTS].map((mint, index) => candidate({
    address: mint,
    volume: 100000 + index,
  }));
  const harness = createServiceHarness({ rows });
  const summary = await harness.service.scanOnce({ source: 'limit' });
  assert.equal(summary.alerted, 5);
  assert.equal(harness.sent.length, 5);
  assert.equal(harness.sent[0][1].mint, OTHER_MINTS[4]);
});

test('second concurrent scan is rejected by in-flight guard', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const harness = createServiceHarness();
  harness.service = createTokenAlertService({
    fetchTrending: async () => {
      await gate;
      return [];
    },
    fetchTokenInfo: async () => ({}),
    fetchHolders: async () => [],
    sendAlert: async () => true,
    getConfig: () => CONFIG,
    getState: () => ({}),
    setState: () => {},
    now: () => NOW,
  });

  const first = harness.service.scanOnce({ source: 'first' });
  const second = await harness.service.scanOnce({ source: 'second' });
  assert.equal(second.blocked, true);
  assert.equal(second.reason, 'SCAN_IN_FLIGHT');
  release();
  await first;
});

test('start and stop are idempotent', () => {
  const harness = createServiceHarness();
  assert.equal(harness.service.start(), true);
  assert.equal(harness.service.start(), false);
  assert.equal(harness.intervalCalls, 1);
  assert.equal(harness.service.stop(), true);
  assert.equal(harness.service.stop(), false);
  assert.equal(harness.clearCalls, 1);
});

test('expired dedupe records are pruned during scan', async () => {
  const harness = createServiceHarness({ rows: [] });
  harness.state.tokenAlertsSeen = {
    expired: { firstSeenAt: NOW - 48 * 60 * 60 * 1000 - 1 },
    active: { alertedAt: NOW - 1000 },
  };
  await harness.service.scanOnce({ source: 'prune' });
  assert.equal('expired' in harness.state.tokenAlertsSeen, false);
  assert.equal('active' in harness.state.tokenAlertsSeen, true);
});
