import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('jupiter client uses current swap API bases and prefers lite without api key', async () => {
  delete process.env.JUPITER_API_KEY;
  delete process.env.JUP_API_KEY;

  const mod = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/solana/jupiter.js');
  assert.deepEqual(mod.getJupiterBaseUrls(), [
    'https://lite-api.jup.ag',
    'https://api.jup.ag',
  ]);
});

test('jupiter client prefers authenticated api base when api key is present', async () => {
  process.env.JUPITER_API_KEY = 'test-key';

  const mod = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/solana/jupiter.js');
  assert.deepEqual(mod.getJupiterBaseUrls(), ['https://api.jup.ag']);

  delete process.env.JUPITER_API_KEY;
});
