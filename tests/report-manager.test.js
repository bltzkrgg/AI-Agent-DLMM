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

  assert.match(report, /Tahap gagal: <code>STAGE_2_GMGN<\/code>/);
  assert.match(report, /Alasan: <i>Top 10 Holders 31\.42% > 30% \| Dev Hold 6\.20% > 5%<\/i>/);
});
