import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('config rejects unknown keys and merges nested signal weights safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-config-'));
  const configPath = join(root, 'user-config.json');
  mkdirSync(root, { recursive: true });

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('deployAmountSol'), true);
  assert.equal(configModule.isConfigKeySupported('totallyUnknownKey'), false);

  configModule.updateConfig({
    signalWeights: { volume: 0.99 },
    totallyUnknownKey: 123,
  });

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.deepEqual(saved.signalWeights, {
    mcap: 2.5,
    feeActiveTvlRatio: 2.3,
    volume: 0.99,
    holderCount: 0.3,
  });
  assert.equal('totallyUnknownKey' in saved, false);
});

test('strategy overrides merge safely without replacing core config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-strategy-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const profileModule = await importFresh(join(repoRoot, 'src/strategies/profiles.js'));

  configModule.updateConfig({
    strategyOverrides: {
      'Wave Enjoyer': {
        exit: { holdMaxMinutes: 25 },
      },
    },
  });

  const profile = profileModule.getStrategyProfile('Wave Enjoyer');
  assert.equal(profile.exit.holdMaxMinutes, 25);
  assert.equal(profile.exit.holdMinMinutes, 10);
  assert.equal(profile.deploy.fixedBinsBelow, 24);
});
