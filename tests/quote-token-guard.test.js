import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { isSupportedQuoteToken, getQuoteTokenLabel, runMeridianVeto } from '../src/market/meridianVeto.js';

test('quote token guard allows SOL/WSOL symbol and WSOL mint', () => {
  assert.equal(isSupportedQuoteToken({ tokenYSymbol: 'SOL' }), true);
  assert.equal(isSupportedQuoteToken({ tokenYSymbol: 'wsol' }), true);
  assert.equal(isSupportedQuoteToken({ tokenYMint: 'So11111111111111111111111111111111111111112' }), true);
});

test('quote token guard rejects USDC/USDT and unknown quote tokens', () => {
  assert.equal(isSupportedQuoteToken({ tokenYSymbol: 'USDC' }), false);
  assert.equal(isSupportedQuoteToken({ tokenYSymbol: 'USDT' }), false);
  assert.equal(isSupportedQuoteToken({}), false);
});

test('quote token label resolves symbol/mint and falls back to UNKNOWN', () => {
  assert.equal(getQuoteTokenLabel({ tokenYSymbol: ' usdc ' }), 'USDC');
  assert.equal(getQuoteTokenLabel({ tokenYMint: 'MintQuote111' }), 'MintQuote111');
  assert.equal(getQuoteTokenLabel({}), 'UNKNOWN');
});

test('Meridian veto rejects unsupported quote before downstream gates', async () => {
  const result = await runMeridianVeto({
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'TOKEN',
    pool: { tokenYSymbol: 'USDC' },
  });

  assert.equal(result.veto, true);
  assert.equal(result.gate, 'UNSUPPORTED_QUOTE_TOKEN');
  assert.equal(result.reason, 'Unsupported quote token USDC; expected SOL/WSOL');
});

test('hunter report marks unsupported quote as failed discovery before PASS', () => {
  const src = readFileSync(new URL('../src/agents/hunterAlpha.js', import.meta.url), 'utf8');
  const quoteGuardAt = src.indexOf("if (!isSupportedQuoteToken(pool))");
  const discoveryPassAt = src.indexOf("reportManager.updateGate(tokenSymbol, 'STAGE_0_DISCOVERY', 'PASS')");

  assert.notEqual(quoteGuardAt, -1);
  assert.notEqual(discoveryPassAt, -1);
  assert.ok(quoteGuardAt < discoveryPassAt);
  assert.match(src, /Unsupported quote token \$\{getQuoteTokenLabel\(pool\)\}; expected SOL\/WSOL/);
});
