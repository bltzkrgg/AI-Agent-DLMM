import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClosedPositionReport,
  formatClosedPositionDuration,
} from '../src/utils/exitReport.js';

test('closed position report uses green status for positive total PnL', () => {
  const report = buildClosedPositionReport({
    tokenLabel: 'Robbinghood',
    pnlSol: 0.0169,
    pnlPct: 5.62,
    feesSol: 0.0236,
    depositSol: 0.3,
    takeHomeSol: 0.3169,
    exitLabel: 'Trailing Profit',
    openedAt: '2026-07-15T00:00:00.000Z',
    closedAt: '2026-07-15T02:29:00.000Z',
    inRange: true,
  });

  assert.match(report, /🟢 <b>CLOSED \| Robbinghood-SOL<\/b>/);
  assert.match(report, /PnL : <code>\+0\.016900 SOL \(\+5\.62%\)<\/code>/);
  assert.match(report, /Fees: <code>0\.023600 SOL<\/code>/);
  assert.match(report, /Deposit: <code>0\.300000 SOL<\/code>/);
  assert.match(report, /Take Home Pay : <code>0\.316900 SOL<\/code>/);
  assert.match(report, /Exit : <code>Trailing Profit<\/code>/);
  assert.match(report, /Duration : <code>2h 29m<\/code> \| Range at Close: <code>IN_RANGE<\/code>/);
});

test('closed position report uses red status for negative total PnL', () => {
  const report = buildClosedPositionReport({
    tokenLabel: 'LOSS',
    pnlSol: -0.021,
    pnlPct: -7,
    feesSol: 0.0045,
    depositSol: 0.3,
    takeHomeSol: 0.279,
    exitLabel: 'Stop Loss',
    openedAt: '2026-07-15T00:00:00.000Z',
    closedAt: '2026-07-15T00:48:00.000Z',
    inRange: false,
  });

  assert.match(report, /🔴 <b>CLOSED \| LOSS-SOL<\/b>/);
  assert.match(report, /PnL : <code>-0\.021000 SOL \(-7\.00%\)<\/code>/);
  assert.match(report, /Range at Close: <code>OUT_OF_RANGE<\/code>/);
});

test('manual close report keeps unavailable accounting unknown instead of zero', () => {
  const report = buildClosedPositionReport({
    tokenLabel: 'MANUAL',
    pnlSol: null,
    pnlPct: null,
    feesSol: null,
    depositSol: 0.3,
    takeHomeSol: null,
    exitLabel: 'Manual Close via Meteora',
    openedAt: '2026-07-15T00:00:00.000Z',
    closedAt: '2026-07-15T00:48:00.000Z',
    inRange: null,
    rangeLabel: 'Range at Last Check',
  });

  assert.match(report, /⚪ <b>CLOSED \| MANUAL-SOL<\/b>/);
  assert.match(report, /PnL : <code>N\/A<\/code>/);
  assert.match(report, /Fees: <code>N\/A<\/code>/);
  assert.match(report, /Take Home Pay : <code>N\/A<\/code>/);
  assert.match(report, /Range at Last Check: <code>UNKNOWN<\/code>/);
  assert.doesNotMatch(report, /0\.000000 SOL/);
});

test('manual close snapshot report labels estimated values explicitly', () => {
  const report = buildClosedPositionReport({
    tokenLabel: 'MANUAL',
    pnlSol: 0.01,
    pnlPct: 3.33,
    feesSol: 0.004,
    depositSol: 0.3,
    takeHomeSol: 0.31,
    exitLabel: 'Manual Close via Meteora',
    openedAt: '2026-07-15T00:00:00.000Z',
    closedAt: '2026-07-15T00:48:00.000Z',
    inRange: true,
    rangeLabel: 'Range at Last Check',
    estimated: true,
    feesFromLastSnapshot: true,
  });

  assert.match(report, /PnL : <code>\+0\.010000 SOL \(\+3\.33%\)<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Fees: <code>0\.004000 SOL<\/code> <i>\[LAST SNAPSHOT\]<\/i>/);
  assert.match(report, /Take Home Pay : <code>0\.310000 SOL<\/code> <i>\[ESTIMATED\]<\/i>/);
});

test('closed duration formats days, hours, and minutes without decimals', () => {
  assert.equal(
    formatClosedPositionDuration('2026-07-15T00:00:00.000Z', '2026-07-16T02:29:00.000Z'),
    '1d 2h 29m'
  );
  assert.equal(formatClosedPositionDuration(null, Date.now()), 'UNKNOWN');
});
