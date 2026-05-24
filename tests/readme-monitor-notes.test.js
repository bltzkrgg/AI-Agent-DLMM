import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readmePath = resolve(process.cwd(), 'README.md');

test('README explains fast-path, slow-path, and monitor trade offs', () => {
  const source = readFileSync(readmePath, 'utf8');

  assert.match(source, /Exit monitoring now uses a hybrid model:/);
  assert.match(source, /Fast-path: lightweight checks/);
  assert.match(source, /Slow-path: detailed valuation plus TA\/logging/);
  assert.match(source, /Trade off: faster exits usually need more wake-ups/);
  assert.match(source, /monitorFastLaneFallbackPollMs/);
});
