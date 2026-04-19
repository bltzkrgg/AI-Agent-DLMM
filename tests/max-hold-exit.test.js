import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('healer enforces MAX_HOLD_EXIT trigger code and force-close path', () => {
  const healerPath = join(repoRoot, 'src/agents/healerAlpha.js');
  const source = readFileSync(healerPath, 'utf-8');

  // Max hold threshold is computed from maxHoldHours and force-overrides decision.
  assert.match(source, /const maxHoldTriggered\s*=\s*positionAgeMin\s*>=\s*maxHoldMinutes/);
  assert.match(source, /if \(maxHoldTriggered\)\s*\{\s*decision\s*=\s*'CLOSE'/);

  // Trigger code must be explicit and stable for downstream analytics/cooldown.
  assert.match(source, /maxHoldTriggered\s*\?\s*'MAX_HOLD_EXIT'/);
  assert.match(source, /closeReason:\s*triggerCode/);
  assert.match(source, /exitTrigger:\s*triggerCode/);
});
