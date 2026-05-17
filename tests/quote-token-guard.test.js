import test from 'node:test';
import assert from 'node:assert/strict';

import { isSupportedQuoteToken, getQuoteTokenLabel } from '../src/market/meridianVeto.js';

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
