import test from 'node:test';
import assert from 'node:assert/strict';
import reportManager from '../src/utils/reportManager.js';

function resetReportManager() {
  reportManager.currentCycle = [];
  reportManager.cycleId = 0;
  reportManager.setSlotSaturatedSummaryOnly(false);
  reportManager.newCycle();
}

test('report manager renders LP scanner brief with top pools and rejects', () => {
  resetReportManager();

  const chance = reportManager.addToken('CHANCE', 'MintChance');
  reportManager.setMetrics('CHANCE', {
    tvl: 469432,
    vol: 5621400,
    mcap: 887670,
    feeTvlRatio: 0.019,
    binStep: 100,
    fees24h: 0.83,
    holders: 124,
    gmgn: { rug_ratio: 12, bundlerPct: 9.1, top10Pct: 31.4, devHoldPct: 6.2, insiderPct: 2.8 },
    volumeTrend: 'ACCELERATING',
    freshnessState: 'ACTIVE',
    freshnessPriorityDelta: 90,
    activityPercentile: 0.82,
    activityState: 'ACTIVE',
    activityWindow: '1h',
    activitySwapCount: 2504,
    flowTrendScore: 76,
  });
  reportManager.currentCycle.find((t) => t.name === 'CHANCE').signalScore = 84;
  reportManager.updateGate('CHANCE', 'STAGE_0_DISCOVERY', 'PASS');
  reportManager.setFinalVerdict('CHANCE', 'DEPLOYED');

  const kins = reportManager.addToken('KINS', 'MintKins');
  reportManager.setMetrics('KINS', {
    tvl: 9225836,
    vol: 2841200,
    mcap: 4123400,
    feeTvlRatio: 0.028,
    binStep: 125,
    holders: 58,
    gmgn: { rug_ratio: 4, bundlerPct: 3.7 },
  });
  const waitReason = 'Reclaim valid, breakout fresh belum terkonfirmasi';
  reportManager.updateGate('KINS', 'SCOUT_AGENT', 'FAIL', waitReason);
  reportManager.setFinalVerdict('KINS', 'REJECT', waitReason);
  kins.details.SCOUT_AGENT = waitReason;

  const report = reportManager.generateReport();

  assert.match(report, /📊 DLMM SCANNER/);
  assert.match(report, /🕒 \d{2} \w{3} \d{4} · \d{2}:\d{2} WIB/);
  assert.match(report, /Slot: <b>WATCH<\/b> · Next: <b>15m<\/b>/);
  assert.match(report, /<b>1\. CHANCE<\/b>/);
  assert.match(report, /TVL \$469\.4K · Vol \$5\.6M · Fee\/TVL 1\.9%/);
  assert.match(report, /Swaps 2,504 · Top10 31\.4% · Bundler 9\.1%/);
  assert.match(report, /✅ <b>DEPLOYED<\/b>/);
  assert.match(report, /<b>2\. KINS<\/b>/);
  assert.match(report, /⏸ <b>WAIT<\/b> — Reclaim valid, menunggu breakout fresh/);
  assert.doesNotMatch(report, /Freshness|Activity Pctl|Flow \+|VolTrend|GMGN \d+ holders/);
  assert.match(report, /<b>Action:<\/b> HOLD new entries/);
});

test('report manager keeps working with partial pool and gmgn data', () => {
  resetReportManager();

  reportManager.addToken('FCM', 'MintFcm');
  reportManager.setMetrics('FCM', {
    tvl: 0,
    vol: 0,
    mcap: 0,
    binStep: 200,
  });
  reportManager.currentCycle.find((t) => t.name === 'FCM').signalScore = 52;
  reportManager.setFinalVerdict('FCM', 'REJECT', 'waiting for live confirmation');

  const report = reportManager.generateReport();

  assert.match(report, /📊 DLMM SCANNER/);
  assert.match(report, /Slot: <b>WATCH<\/b>/);
  assert.match(report, /<b>1\. FCM<\/b>/);
  assert.match(report, /Fee\/TVL N\/A/);
  assert.match(report, /Swaps N\/A · Top10 N\/A · Bundler N\/A/);
  assert.match(report, /⏸ <b>WAIT<\/b> — waiting for live confirmation/);
  assert.match(report, /<b>Action:<\/b> HOLD new entries/);
});

test('report manager renders internal feeTvlRatio field instead of falling back to N/A', () => {
  resetReportManager();

  reportManager.addToken('BOUNTYWORK', 'MintBounty');
  reportManager.setMetrics('BOUNTYWORK', {
    tvl: 84100,
    vol: 201400,
    mcap: 683900,
    feeTvlRatio: 0.0194,
    binStep: 100,
    holders: 4823,
  });
  reportManager.setFinalVerdict('BOUNTYWORK', 'REJECT', 'bundler too high');

  const report = reportManager.generateReport();

  assert.match(report, /<b>1\. BOUNTYWORK<\/b>/);
  assert.match(report, /❌ <b>REJECT<\/b> — bundler too high/);
  assert.match(report, /Fee\/TVL 1\.9%/);
});

test('report manager keeps bearish Meridian veto as a clean reject', () => {
  resetReportManager();

  reportManager.addToken('world', 'MintWorld');
  reportManager.setMetrics('world', {
    tvl: 101300,
    vol: 219100,
    feeTvlRatio: 0.068,
    activitySwapCount: 1111,
    gmgn: { top10Pct: 14.9, bundlerPct: 28.5 },
  });
  reportManager.updateGate(
    'world',
    'MERIDIAN_VETO',
    'FAIL',
    'VETO: Trend 15m BEARISH via Meridian API',
  );
  reportManager.setFinalVerdict('world', 'REJECT', 'VETO: Trend 15m BEARISH via Meridian API');

  const report = reportManager.generateReport();

  assert.match(report, /❌ <b>REJECT<\/b> — Trend 15m bearish via Meridian/);
  assert.doesNotMatch(report, /⏸ <b>WAIT<\/b>/);
});

test('report manager shows N/A when feeTvlRatio is missing, not fake zero', () => {
  resetReportManager();

  reportManager.addToken('NODATA', 'MintNoData');
  reportManager.setMetrics('NODATA', {
    tvl: 25000,
    vol: 150000,
    mcap: 510400,
    binStep: 100,
    fees24h: 12.5,
    holders: 1788,
  });
  reportManager.setFinalVerdict('NODATA', 'REJECT', 'missing ratio');

  const report = reportManager.generateReport();

  assert.match(report, /TVL \$25\.0K · Vol \$150\.0K · Fee\/TVL N\/A/);
  assert.match(report, /❌ <b>REJECT<\/b> — missing ratio/);
});

test('slot-saturated summary mode keeps FULL 1/1 and still shows report shape', () => {
  resetReportManager();
  reportManager.setSlotSaturatedSummaryOnly(true);

  reportManager.addToken('JUNO', 'MintJuno');
  reportManager.setMetrics('JUNO', { tvl: 4800, vol: 28100, mcap: 2700, feeTvlRatio: 0.028, binStep: 125 });
  reportManager.currentCycle.find((t) => t.name === 'JUNO').signalScore = 61;
  reportManager.setFinalVerdict('JUNO', 'REJECT', 'bundler too high');

  const report = reportManager.generateReport();

  assert.match(report, /📊 DLMM SCANNER/);
  assert.match(report, /Slot: <b>FULL 1\/1<\/b> · Next: <b>15m<\/b>/);
  assert.match(report, /❌ <b>REJECT<\/b> — bundler too high/);
  assert.match(report, /<b>Action:<\/b> HOLD new entries/);
});

test('slot-saturated summary mode skips telegram send entirely', async () => {
  resetReportManager();
  reportManager.setSlotSaturatedSummaryOnly(true);
  reportManager.addToken('SKIPME', 'MintSkipMe');
  reportManager.setMetrics('SKIPME', {
    tvl: 1000,
    vol: 5000,
    mcap: 2000,
    feeTvlRatio: 0.02,
    binStep: 100,
  });
  reportManager.setFinalVerdict('SKIPME', 'REJECT', 'slot full');

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true };
  };

  try {
    await reportManager.sendTelegram();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 0);
});

test('slot-saturated summary mode survives newCycle when preserved', async () => {
  resetReportManager();
  reportManager.setSlotSaturatedSummaryOnly(true);
  reportManager.newCycle({ preserveSlotSaturatedSummaryOnly: true });

  reportManager.addToken('STAYQUIET', 'MintStayQuiet');
  reportManager.setFinalVerdict('STAYQUIET', 'REJECT', 'slot full');

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true };
  };

  try {
    await reportManager.sendTelegram();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 0);
});
