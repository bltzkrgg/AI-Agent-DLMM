import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('daily risk state persists across module reloads and uses USD consistently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-safety-'));
  process.env.BOT_CONFIG_PATH = join(root, 'user-config.json');
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const firstLoad = await importFresh(join(repoRoot, 'src/safety/safetyManager.js'));
  firstLoad.setStartingBalanceUsd(1000);
  firstLoad.recordPnlUsd(-150);

  const secondLoad = await importFresh(join(repoRoot, 'src/safety/safetyManager.js'));
  const daily = secondLoad.getDailyPnl();
  assert.equal(daily.startingBalanceUsd, 1000);
  assert.equal(daily.totalPnlUsd, -150);

  const drawdown = secondLoad.checkMaxDrawdown();
  assert.equal(drawdown.triggered, true);
  assert.equal(drawdown.drawdownPct, -15);
});

test('validateStrategyForMarket blocks weak DLMM flow for spot strategies', async () => {
  const safety = await importFresh(join(repoRoot, 'src/safety/safetyManager.js'));
  const result = safety.validateStrategyForMarket('spot', {
    binStep: 10,
    feeRate: '0.10%',
    tokenYSymbol: 'SOL',
    feeApr: 18,
    tvl: 100000,
    fees24h: 120,
    volume24h: 25000,
  });

  assert.equal(result.valid, false);
  assert.equal(result.recommendation, 'spot');
  assert.match(result.warning, /kurang produktif/i);
});

test('validateStrategyForMarket recommends bid_ask for overheated flow', async () => {
  const safety = await importFresh(join(repoRoot, 'src/safety/safetyManager.js'));
  const result = safety.validateStrategyForMarket('spot', {
    binStep: 15,
    feeRate: '0.15%',
    tokenYSymbol: 'SOL',
    feeApr: 180,
    tvl: 50000,
    fees24h: 3000,
    volume24h: 400000,
  });

  assert.equal(result.valid, false);
  assert.equal(result.recommendation, 'bid_ask');
  assert.match(result.warning, /terlalu panas/i);
});
