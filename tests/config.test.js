import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(configModule.isConfigKeySupported('autonomyMode'), true);
  assert.equal(configModule.isConfigKeySupported('deployRangeMaxBins'), true);
  assert.equal(configModule.isConfigKeySupported('totallyUnknownKey'), false);

  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMaxBins')?.flatKey, 'deployRangeMaxBins');

  configModule.updateConfig({
    signalWeights: { volume: 0.99 },
    deployRangeMaxBins: 48,
    totallyUnknownKey: 123,
  });

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.deepEqual(saved.signalWeights, {
    mcap: 2.5,
    feeActiveTvlRatio: 2.3,
    volume: 0.99,
    holderCount: 0.3,
  });
  assert.equal(saved.deployRangeMaxBins, 48);
  assert.equal('totallyUnknownKey' in saved, false);
});

test('config update writes atomic backup alongside primary file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-config-backup-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({ deployAmountSol: 0.7 });

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  const backup = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'));

  assert.equal(saved.deployAmountSol, 0.7);
  assert.equal(backup.deployAmountSol, 0.7);
});

test('config falls back to backup when primary file is empty or corrupt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-config-recover-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const initialModule = await importFresh(join(repoRoot, 'src/config.js'));
  initialModule.updateConfig({ deployAmountSol: 0.8, maxPositions: 2 });

  writeFileSync(configPath, '', 'utf-8');

  const recoveredModule = await importFresh(join(repoRoot, 'src/config.js'));
  const cfg = recoveredModule.getConfig();

  assert.equal(cfg.deployAmountSol, 0.8);
  assert.equal(cfg.maxPositions, 2);
});

test('strategy overrides merge safely without replacing core config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-strategy-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const strategyModule = await importFresh(join(repoRoot, 'src/strategies/strategyManager.js'));

  configModule.updateConfig({
    strategyOverrides: {
      'Wave Enjoyer': {
        exit: { holdMaxMinutes: 25 },
      },
    },
  });

  const strategy = strategyModule.getStrategy('Wave Enjoyer');
  assert.equal(strategy.exit.holdMaxMinutes, 25);
  assert.equal(strategy.exit.holdMinMinutes, 10);
  assert.equal(strategy.deploy.fixedBinsBelow, 24);
});

test('safer defaults stay conservative for real-capital usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-safe-defaults-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const cfg = configModule.getConfig();

  assert.equal(cfg.deployAmountSol, 1.0);
  assert.equal(cfg.maxPositions, 3);
  assert.equal(cfg.gasReserve, 0.03);
  assert.equal(cfg.requireConfirmation, true);
  assert.equal(cfg.realtimePnlIntervalSec, 15);
  assert.equal(cfg.maxDailyDrawdownPct, 6);
  assert.equal(cfg.maxPriceImpactPct, 1.5);
  assert.deepEqual(cfg.allowedBinSteps, [100, 125]);
});

test('realtime PnL terminal interval is configurable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-realtime-pnl-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('realtimePnlIntervalSec'), true);
  configModule.updateConfig({ realtimePnlIntervalSec: 30 });

  const cfg = configModule.getConfig();
  assert.equal(cfg.realtimePnlIntervalSec, 30);
});

test('watch layer config keys are supported and persist via updateConfig', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-watch-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('taWatchEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('taWatchMaxPools'), true);
  assert.equal(configModule.isConfigKeySupported('taWatchExpiryMin'), true);
  assert.equal(configModule.isConfigKeySupported('watchIntervalSec'), true);
  assert.equal(configModule.resolveNestedKey('watch.maxPools')?.flatKey, 'taWatchMaxPools');
  assert.equal(configModule.resolveNestedKey('watch.expiryMin')?.flatKey, 'taWatchExpiryMin');
  assert.equal(configModule.resolveNestedKey('watch.watchIntervalSec')?.flatKey, 'watchIntervalSec');

  configModule.updateConfig({
    taWatchEnabled: true,
    taWatchMaxPools: 12,
    taWatchExpiryMin: 45,
    watchIntervalSec: 20,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.taWatchEnabled, true);
  assert.equal(cfg.taWatchMaxPools, 12);
  assert.equal(cfg.taWatchExpiryMin, 45);
  assert.equal(cfg.watchIntervalSec, 20);
});

test('deploy range max bins is configurable and persisted via updateConfig', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-deploy-range-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.resolveNestedKey('deployRangeMaxBins')?.flatKey, 'deployRangeMaxBins');
  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMaxBins')?.flatKey, 'deployRangeMaxBins');

  configModule.updateConfig({
    deployRangeMaxBins: 40,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.deployRangeMaxBins, 40);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.deployRangeMaxBins, 40);
});

test('entry capacity respects deployment stage and clamps overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-entry-capacity-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({
    maxPositions: 6,
    canaryMaxPositions: 2,
    deploymentStage: 'canary',
  });

  const canary = configModule.getEntryCapacity(configModule.getConfig(), 10);
  assert.equal(canary.blocked, false);
  assert.equal(canary.maxPositions, 2);
  assert.equal(canary.stageMaxPositions, 2);

  configModule.updateConfig({ deploymentStage: 'full' });
  const full = configModule.getEntryCapacity(configModule.getConfig(), 4);
  assert.equal(full.blocked, false);
  assert.equal(full.maxPositions, 4);
  assert.equal(full.stageMaxPositions, 6);

  configModule.updateConfig({ deploymentStage: 'shadow' });
  const shadow = configModule.getEntryCapacity(configModule.getConfig(), 99);
  assert.equal(shadow.blocked, true);
  assert.match(shadow.reason, /shadow/i);
});
