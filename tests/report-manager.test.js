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
  reportManager.updateGate('KINS', 'STAGE_1_PUBLIC', 'FAIL', 'stale market snapshot');
  reportManager.setFinalVerdict('KINS', 'REJECT', 'stale market snapshot');
  kins.details.STAGE_1_PUBLIC = 'stale market snapshot';

  const report = reportManager.generateReport();

  assert.match(report, /AI-Agent Scanner Result/);
  assert.match(report, /\[ TOP 5 \]/);
  assert.match(report, /<b>1\. CHANCE<\/b>/);
  assert.match(report, /<b>TVL<\/b> \$469\.4K \| <b>Vol24h<\/b> \$5\.6M/);
  assert.match(report, /<b>Fee\/TVL<\/b> 1\.9% \| <b>Bin<\/b> 100/);
  assert.match(report, /GMGN: 124 holders/);
  assert.match(report, /GMGN: Top10 31\.4% \| Dev 6\.2% \| Insider 2\.8% \| Bundler 9\.1%/);
  assert.match(report, /VolTrend: ACCELERATING/);
  assert.match(report, /Status: DEPLOYED/);
  assert.match(report, /Status: REJECTED/);
  assert.match(report, /\[ REJECTED \]/);
  assert.match(report, /<b>KINS<\/b>: stale market snapshot/);
  assert.match(report, /\[ STATUS \]/);
  assert.match(report, /<b>Slot:<\/b> AVAILABLE/);
  assert.match(report, /<b>Action:<\/b> HOLD new entries/);
  assert.match(report, /<b>Next scan:<\/b> 15m/);
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

  assert.match(report, /AI-Agent Scanner Result/);
  assert.match(report, /\[ TOP 5 \]/);
  assert.match(report, /GMGN: N\/A holders/);
  assert.match(report, /<b>1\. FCM<\/b>/);
  assert.match(report, /<b>Fee\/TVL<\/b> N\/A/);
  assert.match(report, /Status: REJECTED/);
  assert.match(report, /<b>Slot:<\/b> AVAILABLE/);
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
  assert.match(report, /Status: REJECTED/);
  assert.match(report, /<b>Fee\/TVL<\/b> 1\.9%/);
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

  assert.match(report, /<b>TVL<\/b> \$25\.0K \| <b>Vol24h<\/b> \$150\.0K/);
  assert.match(report, /<b>Fee\/TVL<\/b> N\/A \| <b>Bin<\/b> 100/);
  assert.match(report, /Status: REJECTED/);
});

test('slot-saturated summary mode keeps FULL 1/1 and still shows report shape', () => {
  resetReportManager();
  reportManager.setSlotSaturatedSummaryOnly(true);

  reportManager.addToken('JUNO', 'MintJuno');
  reportManager.setMetrics('JUNO', { tvl: 4800, vol: 28100, mcap: 2700, feeTvlRatio: 0.028, binStep: 125 });
  reportManager.currentCycle.find((t) => t.name === 'JUNO').signalScore = 61;
  reportManager.setFinalVerdict('JUNO', 'REJECT', 'bundler too high');

  const report = reportManager.generateReport();

  assert.match(report, /AI-Agent Scanner Result/);
  assert.match(report, /<b>Slot:<\/b> FULL 1\/1/);
  assert.match(report, /<b>JUNO<\/b>: bundler too high/);
  assert.match(report, /<b>Action:<\/b> HOLD new entries/);
  assert.match(report, /<b>Next scan:<\/b> 15m/);
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
