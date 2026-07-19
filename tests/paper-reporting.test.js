import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPaperClosedNotification,
  formatPaperOpenedNotification,
  formatPaperPositionsTelegram,
  formatPaperRealtimeNotification,
} from '../src/paper/paperReporting.js';

const position = {
  id: 'paper:Pool111111:123456:test',
  symbol: 'TEST',
  poolAddress: 'Pool111111111111',
  deploySol: 0.6,
  currentValueSol: 0.63,
  pnlSol: 0.03,
  pnlPct: 5,
  entryPrice: 0.001,
  entryActiveBin: 100,
  activeBinId: 98,
  rangeMin: 40,
  rangeMax: 100,
  inRange: true,
  action: 'HOLD',
  dataState: 'LIVE',
  openedAt: '2026-07-18T00:00:00.000Z',
};

const estimatedPosition = {
  ...position,
  feePnlSol: 0.006,
  feePnlPct: 1,
  feePnlAvailable: true,
  feePnlSource: 'paper_pool_fee_tvl_estimate_v1',
  estimatedNetPnlSol: 0.036,
  estimatedNetPnlPct: 6,
  estimatedNetValueSol: 0.636,
};

test('paper status report exposes execution mode and keeps fees unavailable', () => {
  const report = formatPaperPositionsTelegram([position], { dryRun: true });

  assert.match(report, /New Entry Mode: <code>PAPER<\/code>/);
  assert.match(report, /Active Paper Positions: <code>1<\/code>/);
  assert.match(report, /Price PnL: <code>\+0\.030000 SOL \/ \+5\.00%<\/code>/);
  assert.match(report, /Estimated Fees: <code>N\/A<\/code>/);
});

test('paper open notification states that no on-chain transaction occurs', () => {
  const report = formatPaperOpenedNotification(position);

  assert.match(report, /PAPER OPENED \| TEST-SOL/);
  assert.match(report, /Virtual Deposit: <code>0\.6000 SOL<\/code>/);
  assert.match(report, /Tidak ada modal, signing, atau transaksi on-chain/);
});

test('paper realtime report separates estimated fees from price pnl', () => {
  const report = formatPaperRealtimeNotification({
    position: estimatedPosition,
    status: estimatedPosition,
    intervalSec: 15,
  });

  assert.match(report, /PAPER REALTIME \| TEST-SOL/);
  assert.match(report, /Price PnL: <code>\+0\.030000 SOL \/ \+5\.00%<\/code>/);
  assert.match(report, /Estimated Fees: <code>\+0\.006000 SOL<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Estimated Net PnL: <code>\+0\.036000 SOL \/ \+6\.00%<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Estimated Net Value: <code>0\.6360 SOL<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Interval: <code>15s<\/code>/);
});

test('paper close report keeps estimated fees explicit', () => {
  const report = formatPaperClosedNotification({
    position: estimatedPosition,
    closed: {
      ...estimatedPosition,
      closedAt: '2026-07-18T02:29:00.000Z',
    },
    action: 'TAKE_PROFIT',
    reason: 'Trailing Profit Trigger',
  });

  assert.match(report, /PAPER CLOSED \| TEST-SOL/);
  assert.match(report, /Virtual Value at Exit \(Price\): <code>0\.6300 SOL<\/code>/);
  assert.match(report, /Estimated Fees: <code>\+0\.006000 SOL<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Estimated Net Value at Exit: <code>0\.6360 SOL<\/code> <i>\[ESTIMATED\]<\/i>/);
  assert.match(report, /Exit: <code>TAKE_PROFIT<\/code>/);
  assert.match(report, /Duration: <code>2h 29m<\/code>/);
  assert.match(report, /bukan fee aktual per bin/);
});
