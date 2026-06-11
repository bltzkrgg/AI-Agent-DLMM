import test from 'node:test';
import assert from 'node:assert/strict';
import reportManager from '../src/utils/reportManager.js';

test('report manager prefers gate-specific details over generic reject reason', () => {
  reportManager.currentCycle = [];
  reportManager.cycleId = 0;
  reportManager.newCycle();

  const token = reportManager.addToken('BANK', 'Mint123');
  reportManager.updateGate('BANK', 'STAGE_0_DISCOVERY', 'PASS');
  reportManager.updateGate('BANK', 'BLACKLIST_LOCAL', 'PASS');
  reportManager.updateGate('BANK', 'STAGE_1_PUBLIC', 'PASS');
  reportManager.updateGate('BANK', 'STAGE_2_GMGN', 'FAIL', 'Generic GMGN failure');
  token.details.STAGE_2_GMGN = 'Top 10 Holders 31.42% > 30% | Dev Hold 6.20% > 5%';
  reportManager.setFinalVerdict('BANK', 'REJECT', 'Generic GMGN failure');

  const report = reportManager.generateReport();

  assert.match(report, /📊 SCANNER REPORT/);
  assert.match(report, /Top 5:\n1\. BANK/);
  assert.match(report, /Slot: AVAILABLE/);
  assert.match(report, /Action: HOLD new entries/);
  assert.match(report, /Next scan: 15m/);
});

test('slot-saturated summary mode suppresses per-token reject details but keeps header counts', () => {
  reportManager.currentCycle = [];
  reportManager.cycleId = 0;
  reportManager.newCycle();
  reportManager.setSlotSaturatedSummaryOnly(true);

  const token = reportManager.addToken('KINS', 'MintKins');
  reportManager.updateGate('KINS', 'STAGE_0_DISCOVERY', 'PASS');
  reportManager.updateGate('KINS', 'BLACKLIST_LOCAL', 'PASS');
  reportManager.updateGate('KINS', 'STAGE_1_PUBLIC', 'FAIL', 'stale market snapshot');
  reportManager.setFinalVerdict('KINS', 'REJECT', 'stale market snapshot');

  const report = reportManager.generateReport();

  assert.match(report, /📊 SCANNER REPORT/);
  assert.match(report, /Top 5:\n1\. KINS/);
  assert.match(report, /Slot: FULL 1\/1/);
  assert.match(report, /Action: HOLD new entries/);
  assert.match(report, /Next scan: 15m/);
  assert.doesNotMatch(report, /VISUAL PROGRESS REPORT/);
  assert.doesNotMatch(report, /Tahap gagal:/);
  assert.doesNotMatch(report, /Alasan:/);
});
