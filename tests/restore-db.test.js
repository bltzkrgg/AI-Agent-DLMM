import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('restore-db exits with clear error when --from has no value', () => {
  const result = spawnSync('node', ['scripts/restore-db.js', '--from'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing value for --from/);
});
