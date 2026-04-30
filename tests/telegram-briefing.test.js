import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatActivePositionsTelegram } from '../src/telegram/briefing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('formatActivePositionsTelegram renders compact active position summaries', () => {
  const html = formatActivePositionsTelegram([
    {
      pubkey: '9xA1b2C3d4E5f6G7h8',
      symbol: 'LUCA',
      poolAddress: 'PoolAbcd1234',
      lifecycleState: 'open',
      rangeMin: 12,
      rangeMax: 81,
      hwmPct: 3.21,
      deploySol: 0.5,
    },
    {
      pubkey: '7kD4e5F6g7H8i9J0k1',
      symbol: 'STOCKMAN',
      poolAddress: 'PoolEfgh5678',
      lifecycleState: 'open',
      rangeMin: 8,
      rangeMax: 64,
      hwmPct: -1.24,
      deploySol: 0.75,
    },
    {
      pubkey: '3mN7p8Q9r0S1t2U3v4',
      symbol: 'BELKA',
      poolAddress: 'PoolIJKL9012',
      lifecycleState: 'manual_closed',
      rangeMin: 5,
      rangeMax: 69,
      hwmPct: 0,
      deploySol: 1.0,
    },
  ], { maxItems: 5 });

  assert.match(html, /🏦 <b>Posisi Aktif<\/b>: <code>3<\/code>/);
  assert.match(html, /1\. <b>LUCA<\/b>/);
  assert.match(html, /2\. <b>STOCKMAN<\/b>/);
  assert.match(html, /3\. <b>BELKA<\/b>/);
  assert.match(html, /State: <code>OPEN<\/code>/);
  assert.match(html, /State: <code>MANUAL_CLOSED<\/code>/);
  assert.match(html, /Range: <code>12-81<\/code>/);
  assert.match(html, /HWM: <code>\+3\.21%<\/code>/);
});

test('formatActivePositionsTelegram truncates long lists with a tail note', () => {
  const positions = Array.from({ length: 6 }, (_, i) => ({
    pubkey: `pubkey-${i}`,
    symbol: `TOKEN${i}`,
    poolAddress: `pool-${i}`,
    lifecycleState: 'open',
    rangeMin: 1,
    rangeMax: 69,
    hwmPct: i,
    deploySol: 0.5,
  }));

  const html = formatActivePositionsTelegram(positions, { maxItems: 3 });

  assert.match(html, /🏦 <b>Posisi Aktif<\/b>: <code>6<\/code>/);
  assert.match(html, /\+3 posisi lagi/);
  assert.match(html, /1\. <b>TOKEN0<\/b>/);
  assert.match(html, /3\. <b>TOKEN2<\/b>/);
  assert.doesNotMatch(html, /4\. <b>TOKEN3<\/b>/);
});

test('briefing config block exposes realtime PnL interval', () => {
  const briefingPath = join(__dirname, '../src/telegram/briefing.js');
  const content = readFileSync(briefingPath, 'utf-8');

  assert.match(content, /Realtime PnL/);
  assert.match(content, /realtimePnlIntervalSec/);
});
