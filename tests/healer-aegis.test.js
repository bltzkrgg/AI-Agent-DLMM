import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('Aegis technical sweep routes emergency exits through zap_out flow', () => {
  const healerPath = join(repoRoot, 'src/agents/healerAlpha.js');
  const source = readFileSync(healerPath, 'utf-8');
  assert.match(source, /AEGIS PRIORITY EXIT[\s\S]*executeTool\('zap_out'/);
});
