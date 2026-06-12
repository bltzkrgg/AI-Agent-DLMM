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

  assert.match(report, /📊 LP SCANNER BRIEF/);
  assert.match(report, /Top 5 Pools:/);
  assert.match(report, /<b>CHANCE<\/b>/);
  assert.doesNotMatch(report, /\[\d+\] CHANCE/);
  assert.match(report, /TVL \$469\.4K \| MCap \$887\.7K \| Vol24h \$5\.6M/);
  assert.match(report, /Signal Rug 12% \| Top10 31\.4% \| Dev 6\.2% \| Insider 2\.8% \| Bundler 9\.1%/);
  assert.match(report, /LP Score 84\/100/);
  assert.match(report, /Rejected:/);
  assert.match(report, /<b>KINS<\/b> — stale market snapshot/);
  assert.match(report, /Slot: AVAILABLE/);
  assert.match(report, /Action: HOLD new entries/);
  assert.match(report, /Next scan: 15m/);
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

  assert.match(report, /📊 LP SCANNER BRIEF/);
  assert.match(report, /Top 5 Pools:/);
  assert.match(report, /Signal N\/A/);
  assert.match(report, /<b>FCM<\/b>/);
  assert.match(report, /Fee\/TVL N\/A/);
  assert.match(report, /LP Score 52\/100/);
  assert.match(report, /Slot: AVAILABLE/);
  assert.match(report, /Action: HOLD new entries/);
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

  assert.match(report, /<b>BOUNTYWORK<\/b>/);
  assert.match(report, /Fee\/TVL 1\.9%/);
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

  assert.match(report, /Fee\/TVL N\/A/);
  assert.match(report, /Fees24h ◎12\.50/);
});

test('slot-saturated summary mode keeps FULL 1/1 and still shows report shape', () => {
  resetReportManager();
  reportManager.setSlotSaturatedSummaryOnly(true);

  reportManager.addToken('JUNO', 'MintJuno');
  reportManager.setMetrics('JUNO', { tvl: 4800, vol: 28100, mcap: 2700, feeTvlRatio: 0.028, binStep: 125 });
  reportManager.currentCycle.find((t) => t.name === 'JUNO').signalScore = 61;
  reportManager.setFinalVerdict('JUNO', 'REJECT', 'bundler too high');

  const report = reportManager.generateReport();

  assert.match(report, /📊 LP SCANNER BRIEF/);
  assert.match(report, /Slot: FULL 1\/1/);
  assert.match(report, /Rejected:/);
  assert.match(report, /Action: HOLD new entries/);
  assert.match(report, /Next scan: 15m/);
});
