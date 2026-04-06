import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('daily risk state persists across module reloads and uses USD consistently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-safety-'));
  process.env.BOT_CONFIG_PATH = join(root, 'user-config.json');
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const firstLoad = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/safety/safetyManager.js');
  firstLoad.setStartingBalanceUsd(1000);
  firstLoad.recordPnlUsd(-150);

  const secondLoad = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/safety/safetyManager.js');
  const daily = secondLoad.getDailyPnl();
  assert.equal(daily.startingBalanceUsd, 1000);
  assert.equal(daily.totalPnlUsd, -150);

  const drawdown = secondLoad.checkMaxDrawdown();
  assert.equal(drawdown.triggered, true);
  assert.equal(drawdown.drawdownPct, -15);
});
