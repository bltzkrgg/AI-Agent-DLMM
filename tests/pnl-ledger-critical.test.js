import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const evilPandaPath = resolve(process.cwd(), 'src/sniper/evilPanda.js');

test('position ledger file constant is defined', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const POSITION_LEDGER_LOG = join\(__dirname, '\.\.\/\.\.\/position-ledger\.jsonl'\)/);
});

test('position ledger appender persists cashflow fields', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /function appendPositionLedger/);
  assert.match(src, /capitalInSol/);
  assert.match(src, /capitalOutSol/);
  assert.match(src, /pnlTotalSol/);
  assert.match(src, /pnlTotalPct/);
});

test('exit flow writes both harvest and position ledger', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /appendHarvestLog\(/);
  assert.match(src, /appendPositionLedger\(/);
  assert.match(src, /const pnlTotalSol = solRecovered - reg\.deploySol/);
});

