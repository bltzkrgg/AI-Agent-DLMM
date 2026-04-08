#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const TARGET_DIRS = ['src', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.cursor', '.github']);

function walk(dir, out) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith('.js')) out.push(rel);
  }
}

const files = [];
for (const dir of TARGET_DIRS) {
  walk(join(ROOT, dir), files);
}

let failed = false;
for (const file of files) {
  try {
    execFileSync('node', ['--check', file], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    failed = true;
    process.stderr.write(`Syntax check failed: ${file}\n`);
    if (error?.stderr) process.stderr.write(String(error.stderr));
  }
}

if (failed) process.exit(1);
console.log(`Lint syntax check passed (${files.length} files).`);
