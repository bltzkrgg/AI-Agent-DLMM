import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = '/Users/mkhtramn/Documents/New project/repo';

test('ensure-anchor-esm registers the anchor ESM subpath export', () => {
  execFileSync('node', ['scripts/ensure-anchor-esm.js'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  const pkg = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', '@coral-xyz', 'anchor', 'package.json'), 'utf-8'),
  );

  assert.equal(pkg.exports['.'].import, './anchor-esm.mjs');
  assert.equal(pkg.exports['./anchor-esm.mjs'], './anchor-esm.mjs');
  assert.equal(pkg.exports['./*'], './*');
});
