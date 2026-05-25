import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('Claude tool registry exposes zap_out', () => {
  const claudePath = join(repoRoot, 'src/agent/claude.js');
  const source = readFileSync(claudePath, 'utf-8');

  assert.match(source, /name:\s*'zap_out'/);
  assert.match(source, /description:\s*'Emergency exit all open positions to SOL/);
});

test('Claude executeTool has zap_out close + autoswap flow', () => {
  const claudePath = join(repoRoot, 'src/agent/claude.js');
  const source = readFileSync(claudePath, 'utf-8');

  assert.match(source, /case\s+'zap_out'\s*:\s*\{/);
  assert.match(source, /closePositionDLMM\(poolAddress,\s*positionAddress,\s*\{\},\s*\{\s*isUrgent:\s*true\s*\}\)/);
  assert.match(source, /swapAllToSOL\(mint,\s*null,\s*\{\s*isUrgent:\s*true\s*\}\)/);
});
