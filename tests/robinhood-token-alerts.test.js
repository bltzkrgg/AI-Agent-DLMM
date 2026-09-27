import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRobinhoodTokenAlertService,
  evaluateRobinhoodTokenCandidate,
  extractGmgnTotalFeesEth,
  formatRobinhoodTokenAlertMessage,
} from '../src/alerts/robinhoodTokenAlerts.js';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const NOW = 1_800_000_000_000;
const CONFIG = {
  robinhoodAlertsEnabled: true,
  robinhoodAlertsPollIntervalSec: 60,
  robinhoodAlertsMinVolume5mUsd: 100000,
  robinhoodAlertsMinTotalFeesEth: 0.1,
  robinhoodAlertsMaxPerScan: 5,
};

function candidate(overrides = {}) {
  return {
    address: ADDRESS,
    name: 'Robin Runner',
    symbol: 'RUN',
    price: 0.000105004,
    market_cap: 102300,
    volume: 100000,
    total_fee: 0.1,
    swaps: 4453,
    buys: 59,
    sells: 41,
    liquidity: 24200,
    exchange: 'uniswap_v3',
    top_10_holder_rate: 0.209,
    ...overrides,
  };
}

test('Robinhood qualification passes exact inclusive volume and fee boundaries', () => {
  const result = evaluateRobinhoodTokenCandidate(candidate(), CONFIG, {}, NOW);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'PASS');
  assert.equal(result.normalized.volume5mUsd, 100000);
  assert.equal(result.normalized.totalFeesEth, 0.1);
});

test('Robinhood qualification has only volume and total-fee gates', () => {
  const result = evaluateRobinhoodTokenCandidate(candidate({
    market_cap: undefined,
    open_timestamp: undefined,
    creation_timestamp: undefined,
  }), CONFIG, {}, NOW);
  assert.equal(result.eligible, true);
  assert.equal(result.normalized.marketCapUsd, null);
  assert.equal(result.normalized.ageMin, null);
});

test('Robinhood volume and total fees fail closed below thresholds or when missing', () => {
  assert.equal(
    evaluateRobinhoodTokenCandidate(candidate({ volume: 99999.99 }), CONFIG, {}, NOW).reason,
    'VOLUME_BELOW_MIN'
  );
  assert.equal(
    evaluateRobinhoodTokenCandidate(candidate({ total_fee: 0.0999 }), CONFIG, {}, NOW).reason,
    'TOTAL_FEES_BELOW_MIN'
  );
  assert.equal(
    evaluateRobinhoodTokenCandidate(candidate({ total_fee: undefined }), CONFIG, {}, NOW).reason,
    'TOTAL_FEES_UNKNOWN'
  );
});

test('total fee extraction accepts documented totals and ignores average gas fee', () => {
  assert.equal(extractGmgnTotalFeesEth({ total_fee: '0.25', gas_fee: 99 }), 0.25);
  assert.equal(extractGmgnTotalFeesEth({ stat: { total_fees_eth: '0.4' } }), 0.4);
  assert.equal(extractGmgnTotalFeesEth({ fees: { total_eth: 0.5 } }), 0.5);
  assert.equal(extractGmgnTotalFeesEth({ gas_fee: 1 }), null);
});

test('formatter renders Robinhood card, optional N/A fields, and escaped text', () => {
  const normalized = evaluateRobinhoodTokenCandidate(candidate({
    name: '<Runner>',
    symbol: 'R&N',
    market_cap: undefined,
  }), CONFIG, {}, NOW).normalized;
  const message = formatRobinhoodTokenAlertMessage({ ...normalized, topHolderPercentages: [3.2, 2.5] });

  assert.match(message, /<b>💊 R&amp;N • N\/A<\/b>/);
  assert.match(message, /&lt;Runner&gt; \| Uniswap V3/);
  assert.match(message, /<code>MC\s+:<\/code> <b>N\/A<\/b>/);
  assert.match(message, /<code>Fees\s+:<\/code> <b>0\.1 ETH<\/b>/);
  assert.match(message, /<code>VOL • FEES<\/code>/);
  assert.match(message, new RegExp(`<code>${ADDRESS}</code>`));
});

function createHarness({ rows = [candidate()], sendAlert = async () => true } = {}) {
  const state = {};
  const sent = [];
  let intervalCalls = 0;
  let clearCalls = 0;
  const service = createRobinhoodTokenAlertService({
    fetchTrending: async () => rows,
    fetchTokenInfo: async () => ({}),
    fetchHolders: async () => [],
    sendAlert: async (...args) => {
      sent.push(args);
      return sendAlert(...args);
    },
    getConfig: () => CONFIG,
    getState: (key) => state[key] || {},
    setState: (key, value) => { state[key] = value; },
    now: () => NOW,
    setIntervalFn: () => {
      intervalCalls += 1;
      return { intervalCalls };
    },
    clearIntervalFn: () => { clearCalls += 1; },
  });
  return {
    service,
    state,
    sent,
    get intervalCalls() { return intervalCalls; },
    get clearCalls() { return clearCalls; },
  };
}

test('background runner start and stop are idempotent', () => {
  const harness = createHarness();
  assert.equal(harness.service.start(), true);
  assert.equal(harness.service.start(), false);
  assert.equal(harness.intervalCalls, 1);
  assert.equal(harness.service.status().running, true);
  assert.equal(harness.service.stop(), true);
  assert.equal(harness.service.stop(), false);
  assert.equal(harness.clearCalls, 1);
});

test('successful alert persists case-insensitive dedupe state', async () => {
  const harness = createHarness({ rows: [candidate({ address: ADDRESS.toUpperCase().replace('0X', '0x') })] });
  const first = await harness.service.scanOnce({ source: 'test' });
  const second = await harness.service.scanOnce({ source: 'repeat' });
  assert.equal(first.alerted, 1);
  assert.equal(second.alerted, 0);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.state.robinhoodTokenAlertsSeen[ADDRESS].alertedAt, NOW);
});

test('failed Telegram delivery remains retryable', async () => {
  const harness = createHarness({ sendAlert: async () => false });
  const first = await harness.service.scanOnce({ source: 'test' });
  const second = await harness.service.scanOnce({ source: 'retry' });
  assert.equal(first.failed, 1);
  assert.equal(first.errorCode, 'TELEGRAM_SEND_FAILED');
  assert.equal(second.failed, 1);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.state.robinhoodTokenAlertsSeen[ADDRESS], undefined);
});
