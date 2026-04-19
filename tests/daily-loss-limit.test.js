/**
 * Sprint 1.3 — Daily loss limit gate
 *
 * Source assertions verifying that src/index.js enforces dailyLossLimitUsd:
 *  1. Hunter screening exits early when dailyPnl < -dailyLossLimitUsd
 *  2. The check reads liveCfg.dailyLossLimitUsd (live config, not stale startup value)
 *  3. An urgentNotify call alerts the operator on first breach (12h cooldown)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot   = join(__dirname, '..');
const src        = readFileSync(join(repoRoot, 'src/index.js'), 'utf-8');

test('dailyLossLimitUsd: screening loop returns early when daily PnL breaches limit', () => {
  // Guard: daily circuit breaker conditional must compare against liveCfg.dailyLossLimitUsd
  assert.match(src, /dailyPnl\s*<\s*-liveCfg\.dailyLossLimitUsd/);

  // Must return (skip entry) when the limit is breached — look for the console.log and return together
  assert.match(src, /Daily Circuit Breaker.*Skip screening/);
  assert.match(src, /Daily Circuit Breaker[\s\S]{0,100}return/);
});

test('dailyLossLimitUsd: breach triggers urgentNotify with DAILY CIRCUIT BREAKER message', () => {
  assert.match(src, /DAILY CIRCUIT BREAKER/);
  assert.match(src, /urgentNotify\(/);
});

test('dailyLossLimitUsd: notification uses 12h cooldown to avoid alert spam', () => {
  // Must gate on a time comparison involving 12 hours
  assert.match(src, /12\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});
