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

test('manual close fee-only path keeps pending cases out of harvest history', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const manualAccounting = buildManualCloseAccounting\(reg\)/);
  assert.match(src, /appendHarvestLog\(\{\n\s*token: tokenSymbol,\n\s*positionPubkey,/);
  assert.match(src, /appendPositionLedger\(/);
  assert.match(src, /recordPoolOutcome\(\{\n\s*key: reg\.poolAddress \|\| reg\.tokenXMint,/);
  assert.match(src, /recordPoolPatternOutcome\(\{/);
});
