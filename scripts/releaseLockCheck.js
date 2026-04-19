#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function getDirtyFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

try {
  const dirty = getDirtyFiles();
  if (dirty.length > 0) {
    console.error(`[release-lock] FAIL: worktree dirty (${dirty.length} file changes)`);
    console.error(dirty.slice(0, 20).join('\n'));
    process.exit(2);
  }
  console.log('[release-lock] PASS: worktree clean');
} catch (error) {
  console.error(`[release-lock] ERROR: ${error?.message || error}`);
  process.exit(1);
}
