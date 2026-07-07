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
  assert.equal(configModule.isConfigKeySupported('deployRangeMinBinOffset'), true);
  assert.equal(configModule.isConfigKeySupported('deployRangeMaxBinOffset'), true);
  assert.equal(configModule.isConfigKeySupported('dlmmLiquidityShape'), true);
  assert.equal(configModule.isConfigKeySupported('oorDisplayWaitMinutes'), true);
  assert.equal(configModule.isConfigKeySupported('oorWatchDisplayEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('closeSwapMode'), true);
  assert.equal(configModule.isConfigKeySupported('takeProfitMinNetPnlPct'), true);
  assert.equal(configModule.isConfigKeySupported('smartExitRsi'), true);
  assert.equal(configModule.isConfigKeySupported('manualTAExitEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('totallyUnknownKey'), false);

  assert.equal(configModule.resolveNestedKey('strategy.outOfRangeWaitMinutes')?.flatKey, 'outOfRangeWaitMinutes');
  assert.equal(configModule.resolveNestedKey('oor.displayWaitMinutes')?.flatKey, 'oorDisplayWaitMinutes');
  assert.equal(configModule.resolveNestedKey('oor.watchDisplayEnabled')?.flatKey, 'oorWatchDisplayEnabled');
  assert.equal(configModule.resolveNestedKey('strategy.liquidityShape')?.flatKey, 'dlmmLiquidityShape');
  assert.equal(configModule.resolveNestedKey('strategy.shape')?.flatKey, 'dlmmLiquidityShape');
  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMinBinOffset')?.flatKey, 'deployRangeMinBinOffset');
  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMaxBinOffset')?.flatKey, 'deployRangeMaxBinOffset');
  assert.equal(configModule.resolveNestedKey('strategy.closeSwapMode')?.flatKey, 'closeSwapMode');
  assert.equal(configModule.resolveNestedKey('strategy.closeResidualSwapEnabled')?.flatKey, 'closeResidualSwapEnabled');
  assert.equal(configModule.resolveNestedKey('strategy.takeProfitMinNetPnlPct')?.flatKey, 'takeProfitMinNetPnlPct');
  assert.equal(configModule.resolveNestedKey('strategy.smartExitRsi')?.flatKey, 'smartExitRsi');
  assert.equal(configModule.resolveNestedKey('strategy.manualTAExitEnabled')?.flatKey, 'manualTAExitEnabled');
  configModule.updateConfig({
    signalWeights: { volume: 0.99 },
    deployRangeMinBinOffset: -44,
    deployRangeMaxBinOffset: 0,
    closeSwapMode: 'all',
    closeResidualSwapEnabled: true,
    closeAutoSwapMinOutSol: 0.001,
    closeAutoSwapMinNetSol: 0.0005,
    closeEstimatedSwapCostSol: 0.0002,
    oorWatchDisplayEnabled: false,
    takeProfitMinNetPnlPct: 0.15,
    totallyUnknownKey: 123,
  });

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.deepEqual(saved.signalWeights, {
    mcap: 2.5,
    feeActiveTvlRatio: 2.3,
    volume: 0.99,
    holderCount: 0.3,
  });
  assert.equal(saved.deployRangeMinBinOffset, -44);
  assert.equal(saved.deployRangeMaxBinOffset, 0);
  assert.equal(saved.closeSwapMode, 'all');
  assert.equal(saved.closeResidualSwapEnabled, true);
  assert.equal(saved.closeAutoSwapMinOutSol, 0.001);
  assert.equal(saved.closeAutoSwapMinNetSol, 0.0005);
  assert.equal(saved.closeEstimatedSwapCostSol, 0.0002);
  assert.equal(saved.oorWatchDisplayEnabled, false);
  assert.equal(saved.takeProfitMinNetPnlPct, 0.15);
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
  const restoredPrimary = readFileSync(configPath, 'utf-8');
  const backup = readFileSync(`${configPath}.bak`, 'utf-8');

  assert.equal(cfg.deployAmountSol, 0.8);
  assert.equal(cfg.maxPositions, 2);
  assert.notEqual(restoredPrimary.trim(), '');
  assert.equal(restoredPrimary, backup);
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
  assert.equal(cfg.maxPriceImpactPct, 1.5);
  assert.equal(cfg.maxMcap, 0);
  assert.equal(cfg.poolImpactGuardEnabled, false);
  assert.equal(cfg.poolImpactCheckIntervalMs, 3000);
  assert.equal(cfg.poolImpactPriceDropForceExitPct, 6);
  assert.equal(cfg.poolImpactConsecutiveDropTicks, 3);
  assert.equal(cfg.poolImpactLowerRangeBufferPct, 15);
  assert.equal(cfg.poolPatternLearningEnabled, false);
  assert.equal(cfg.poolPatternLearningShadowMode, true);
  assert.equal(cfg.poolPatternLearningMinSamples, 10);
  assert.equal(cfg.poolPatternLearningMaxScoreDelta, 8);
  assert.equal(cfg.poolPatternLearningLookbackDays, 14);
  assert.equal(cfg.dlmmLiquidityShape, 'spot');
  assert.equal(cfg.closeSwapMode, 'fee_only');
  assert.equal(cfg.closeResidualSwapEnabled, false);
  assert.equal(cfg.closeAutoSwapMinOutSol, 0.0003);
  assert.equal(cfg.closeAutoSwapMinNetSol, 0.00015);
  assert.equal(cfg.closeEstimatedSwapCostSol, 0.00012);
  assert.equal(cfg.takeProfitMinNetPnlPct, 0);
  assert.equal(cfg.manualTAExitEnabled, false);
  assert.equal(cfg.entryCandleSanityEnabled, true);
  assert.equal(cfg.entryRequireGreenCandle, true);
  assert.equal(cfg.entryRequireVolumeConfirm, true);
  assert.equal(cfg.entryMinVolumeRatio, 1.5);
  assert.equal(cfg.entryVolumeLookbackCandles, 12);
  assert.equal(cfg.entryCandleMaxAgeSec, 420);
  assert.equal(cfg.entryDecisionMode, 'strict');
  assert.equal(cfg.entryM15RequireGreenCandle, true);
  assert.equal(cfg.entryM15RequireVolumeConfirm, true);
  assert.equal(cfg.entryM15MinVolumeRatio, 0.7);
  assert.equal(cfg.entryM15VolumeLookbackCandles, 8);
  assert.equal(cfg.entryM15MaxAgeSec, 1800);
  assert.equal(cfg.entryM5HardGateEnabled, true);
  assert.equal(cfg.entryDeferOnM15PreviousUnknown, true);
  assert.equal(cfg.deployQueueHoldNotifyCooldownSec, 180);
  assert.equal(cfg.deployRangeMinBinOffset, -60);
  assert.equal(cfg.deployRangeMaxBinOffset, 0);
  assert.deepEqual(cfg.allowedBinSteps, [100, 125]);
});

test('user-config.example includes pool pattern learning keys', () => {
  const raw = readFileSync(join(repoRoot, 'user-config.example.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.poolPatternLearningEnabled, false);
  assert.equal(parsed.poolPatternLearningShadowMode, true);
  assert.equal(parsed.poolPatternLearningMinSamples, 10);
  assert.equal(parsed.poolPatternLearningMaxScoreDelta, 8);
  assert.equal(parsed.poolPatternLearningLookbackDays, 14);
  assert.equal(parsed.dlmmLiquidityShape, 'spot');
  assert.equal(parsed.closeSwapMode, 'fee_only');
  assert.equal(parsed.closeResidualSwapEnabled, false);
  assert.equal(parsed.closeAutoSwapMinOutSol, 0.0003);
  assert.equal(parsed.closeAutoSwapMinNetSol, 0.00015);
  assert.equal(parsed.closeEstimatedSwapCostSol, 0.00012);
  assert.equal(parsed.takeProfitMinNetPnlPct, 0);
  assert.equal(parsed.manualTAExitEnabled, false);
  assert.equal(parsed.entryCandleSanityEnabled, true);
  assert.equal(parsed.entryRequireGreenCandle, true);
  assert.equal(parsed.entryRequireVolumeConfirm, true);
  assert.equal(parsed.entryMinVolumeRatio, 1.5);
  assert.equal(parsed.entryVolumeLookbackCandles, 12);
  assert.equal(parsed.entryCandleMaxAgeSec, 420);
  assert.equal(parsed.entryDecisionMode, 'strict');
  assert.equal(parsed.entryM15RequireGreenCandle, true);
  assert.equal(parsed.entryM15RequireVolumeConfirm, true);
  assert.equal(parsed.entryM15MinVolumeRatio, 0.7);
  assert.equal(parsed.entryM15VolumeLookbackCandles, 8);
  assert.equal(parsed.entryM15MaxAgeSec, 1800);
  assert.equal(parsed.entryM5HardGateEnabled, true);
  assert.equal(parsed.entryDeferOnM15PreviousUnknown, true);
  assert.equal(parsed.deployQueueHoldNotifyCooldownSec, 180);
  assert.equal(parsed.deployRangeMinBinOffset, -60);
  assert.equal(parsed.deployRangeMaxBinOffset, 0);
  assert.equal(parsed.monitorFastLaneEnabled, true);
  assert.equal(parsed.monitorFastLaneThrottleMs, 1200);
  assert.equal(parsed.monitorFastLaneFallbackPollMs, 12000);
  assert.equal(parsed.monitorFastLaneUsePoolAccount, true);
  assert.equal(parsed.monitorFastLaneUsePositionAccount, true);
  assert.equal(parsed.maxMcap, 0);
});

test('entry candle sanity keys can be overridden from user-config.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-entry-candle-config-'));
  const configPath = join(root, 'user-config.json');
  writeFileSync(configPath, JSON.stringify({
    entryCandleSanityEnabled: false,
    entryRequireGreenCandle: false,
    entryRequireVolumeConfirm: false,
    entryMinVolumeRatio: 1.2,
    entryVolumeLookbackCandles: 9,
    entryCandleMaxAgeSec: 600,
  }, null, 2), 'utf-8');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const cfg = configModule.getConfig();

  assert.equal(cfg.entryCandleSanityEnabled, false);
  assert.equal(cfg.entryRequireGreenCandle, false);
  assert.equal(cfg.entryRequireVolumeConfirm, false);
  assert.equal(cfg.entryMinVolumeRatio, 1.2);
  assert.equal(cfg.entryVolumeLookbackCandles, 9);
  assert.equal(cfg.entryCandleMaxAgeSec, 600);
});

test('deployQueueHoldNotifyCooldownSec supports override and bounds validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-hold-notify-cooldown-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({ deployQueueHoldNotifyCooldownSec: 300 });
  let cfg = configModule.getConfig();
  assert.equal(cfg.deployQueueHoldNotifyCooldownSec, 300);

  configModule.updateConfig({ deployQueueHoldNotifyCooldownSec: 10 });
  cfg = configModule.getConfig();
  assert.equal(cfg.deployQueueHoldNotifyCooldownSec, 300);

  configModule.updateConfig({ deployQueueHoldNotifyCooldownSec: 2000 });
  cfg = configModule.getConfig();
  assert.equal(cfg.deployQueueHoldNotifyCooldownSec, 300);
});

test('nested entry config keys flatten into runtime config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-entry-nested-config-'));
  const configPath = join(root, 'user-config.json');
  writeFileSync(configPath, JSON.stringify({
    entry: {
      candleSanityEnabled: false,
      requireGreenCandle: false,
      requireVolumeConfirm: false,
      minVolumeRatio: 1.8,
      volumeLookbackCandles: 10,
      candleMaxAgeSec: 900,
    },
  }, null, 2), 'utf-8');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const cfg = configModule.getConfig();

  assert.equal(cfg.entryCandleSanityEnabled, false);
  assert.equal(cfg.entryRequireGreenCandle, false);
  assert.equal(cfg.entryRequireVolumeConfirm, false);
  assert.equal(cfg.entryMinVolumeRatio, 1.8);
  assert.equal(cfg.entryVolumeLookbackCandles, 10);
  assert.equal(cfg.entryCandleMaxAgeSec, 900);
  assert.equal(configModule.resolveNestedKey('entry.minVolumeRatio')?.flatKey, 'entryMinVolumeRatio');
  assert.equal(configModule.resolveNestedKey('entry.candleMaxAgeSec')?.flatKey, 'entryCandleMaxAgeSec');
  assert.equal(configModule.resolveNestedKey('entry.decisionMode')?.flatKey, 'entryDecisionMode');
  assert.equal(configModule.resolveNestedKey('entry.m15MinVolumeRatio')?.flatKey, 'entryM15MinVolumeRatio');
  assert.equal(configModule.resolveNestedKey('entry.m15MaxAgeSec')?.flatKey, 'entryM15MaxAgeSec');
  assert.equal(configModule.resolveNestedKey('entry.m5HardGateEnabled')?.flatKey, 'entryM5HardGateEnabled');
  assert.equal(configModule.resolveNestedKey('entry.deferOnM15PreviousUnknown')?.flatKey, 'entryDeferOnM15PreviousUnknown');
});

test('lp_simple_m15 mode defaults m5 hard gate and previous unknown defer to false unless explicitly set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-lp-simple-m15-defaults-'));
  const configPath = join(root, 'user-config.json');
  writeFileSync(configPath, JSON.stringify({
    entryDecisionMode: 'lp_simple_m15',
  }, null, 2), 'utf-8');
  process.env.BOT_CONFIG_PATH = configPath;
  let configModule = await importFresh(join(repoRoot, 'src/config.js'));
  let cfg = configModule.getConfig();
  assert.equal(cfg.entryDecisionMode, 'lp_simple_m15');
  assert.equal(cfg.entryM5HardGateEnabled, false);
  assert.equal(cfg.entryDeferOnM15PreviousUnknown, false);

  writeFileSync(configPath, JSON.stringify({
    entryDecisionMode: 'lp_simple_m15',
    entryM5HardGateEnabled: true,
    entryDeferOnM15PreviousUnknown: true,
  }, null, 2), 'utf-8');
  configModule = await importFresh(join(repoRoot, 'src/config.js'));
  cfg = configModule.getConfig();
  assert.equal(cfg.entryM5HardGateEnabled, true);
  assert.equal(cfg.entryDeferOnM15PreviousUnknown, true);
});

test('nested lp_simple_m15 entry config maps correctly to flat runtime keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-entry-lp-simple-nested-'));
  const configPath = join(root, 'user-config.json');
  writeFileSync(configPath, JSON.stringify({
    entry: {
      decisionMode: 'lp_simple_m15',
      m15RequireGreenCandle: true,
      m15RequireVolumeConfirm: false,
      m15MinVolumeRatio: 0.9,
      m15VolumeLookbackCandles: 9,
      m15MaxAgeSec: 1500,
      m5HardGateEnabled: true,
      deferOnM15PreviousUnknown: true,
    },
  }, null, 2), 'utf-8');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  const cfg = configModule.getConfig();

  assert.equal(cfg.entryDecisionMode, 'lp_simple_m15');
  assert.equal(cfg.entryM15RequireGreenCandle, true);
  assert.equal(cfg.entryM15RequireVolumeConfirm, false);
  assert.equal(cfg.entryM15MinVolumeRatio, 0.9);
  assert.equal(cfg.entryM15VolumeLookbackCandles, 9);
  assert.equal(cfg.entryM15MaxAgeSec, 1500);
  assert.equal(cfg.entryM5HardGateEnabled, true);
  assert.equal(cfg.entryDeferOnM15PreviousUnknown, true);
});

test('entryDecisionMode updateConfig validates strict/lp_simple_m15 enum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-entry-decision-mode-enum-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({ entryDecisionMode: 'invalid_mode' });
  let cfg = configModule.getConfig();
  assert.equal(cfg.entryDecisionMode, 'strict');

  configModule.updateConfig({ entryDecisionMode: 'lp_simple_m15' });
  cfg = configModule.getConfig();
  assert.equal(cfg.entryDecisionMode, 'lp_simple_m15');
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

test('removed legacy keys are no longer supported in config schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-legacy-keys-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('requireConfirmation'), false);
  assert.equal(configModule.isConfigKeySupported('maxDailyDrawdownPct'), false);
  assert.equal(configModule.isConfigKeySupported('jupiterMaxChecksPerScan'), false);
  assert.equal(configModule.isConfigKeySupported('maxBinStep'), false);
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

test('monitor fast-lane config keys are supported and persist via updateConfig', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-monitor-fastlane-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('monitorFastLaneEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('monitorFastLaneThrottleMs'), true);
  assert.equal(configModule.isConfigKeySupported('monitorFastLaneFallbackPollMs'), true);
  assert.equal(configModule.isConfigKeySupported('monitorFastLaneUsePoolAccount'), true);
  assert.equal(configModule.isConfigKeySupported('monitorFastLaneUsePositionAccount'), true);
  assert.equal(configModule.resolveNestedKey('watch.monitorFastLaneEnabled')?.flatKey, 'monitorFastLaneEnabled');
  assert.equal(configModule.resolveNestedKey('watch.monitorFastLaneThrottleMs')?.flatKey, 'monitorFastLaneThrottleMs');

  configModule.updateConfig({
    monitorFastLaneEnabled: false,
    monitorFastLaneThrottleMs: 2500,
    monitorFastLaneFallbackPollMs: 18000,
    monitorFastLaneUsePoolAccount: false,
    monitorFastLaneUsePositionAccount: true,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.monitorFastLaneEnabled, false);
  assert.equal(cfg.monitorFastLaneThrottleMs, 2500);
  assert.equal(cfg.monitorFastLaneFallbackPollMs, 18000);
  assert.equal(cfg.monitorFastLaneUsePoolAccount, false);
  assert.equal(cfg.monitorFastLaneUsePositionAccount, true);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.monitorFastLaneEnabled, false);
  assert.equal(saved.monitorFastLaneThrottleMs, 2500);
  assert.equal(saved.monitorFastLaneFallbackPollMs, 18000);
});

test('deploy range active-bin offsets are configurable and persisted via updateConfig', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-deploy-offset-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.resolveNestedKey('deployRangeMinBinOffset')?.flatKey, 'deployRangeMinBinOffset');
  assert.equal(configModule.resolveNestedKey('deployRangeMaxBinOffset')?.flatKey, 'deployRangeMaxBinOffset');
  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMinBinOffset')?.flatKey, 'deployRangeMinBinOffset');
  assert.equal(configModule.resolveNestedKey('strategy.deployRangeMaxBinOffset')?.flatKey, 'deployRangeMaxBinOffset');

  configModule.updateConfig({
    deployRangeMinBinOffset: -72,
    deployRangeMaxBinOffset: 0,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.deployRangeMinBinOffset, -72);
  assert.equal(cfg.deployRangeMaxBinOffset, 0);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.deployRangeMinBinOffset, -72);
  assert.equal(saved.deployRangeMaxBinOffset, 0);
});

test('OOR display wait minutes is configurable and persists independently from close wait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-oor-display-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({
    outOfRangeWaitMinutes: 30,
    oorDisplayWaitMinutes: 7,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.outOfRangeWaitMinutes, 30);
  assert.equal(cfg.oorDisplayWaitMinutes, 7);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.outOfRangeWaitMinutes, 30);
  assert.equal(saved.oorDisplayWaitMinutes, 7);
});

test('/config output and OOR help distinguish close wait from display cadence', async () => {
  const indexPath = join(repoRoot, 'src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /outOfRangeWaitMinutes = \$\{cfg\.outOfRangeWaitMinutes\} \(close threshold\)/);
  assert.match(content, /oorDisplayWaitMinutes = \$\{cfg\.oorDisplayWaitMinutes\} \(display only\)/);
  assert.match(content, /outOfRangeWaitMinutes mengatur kapan posisi benar-benar ditutup/);
  assert.match(content, /oorDisplayWaitMinutes hanya mengatur seberapa sering status OOR muncul/);
});

test('pool impact guard config keys are supported and persisted via user config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-pool-impact-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('poolImpactGuardEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactCheckIntervalMs'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactPriceDropWarnPct'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactPriceDropPreExitPct'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactPriceDropForceExitPct'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactConsecutiveDropTicks'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactLowerRangeBufferPct'), true);
  assert.equal(configModule.isConfigKeySupported('poolImpactAlertCooldownMs'), true);

  configModule.updateConfig({
    poolImpactGuardEnabled: true,
    poolImpactCheckIntervalMs: 5000,
    poolImpactPriceDropWarnPct: 3,
    poolImpactPriceDropPreExitPct: 5,
    poolImpactPriceDropForceExitPct: 8,
    poolImpactConsecutiveDropTicks: 4,
    poolImpactLowerRangeBufferPct: 20,
    poolImpactAlertCooldownMs: 120000,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.poolImpactGuardEnabled, true);
  assert.equal(cfg.poolImpactCheckIntervalMs, 5000);
  assert.equal(cfg.poolImpactPriceDropWarnPct, 3);
  assert.equal(cfg.poolImpactPriceDropPreExitPct, 5);
  assert.equal(cfg.poolImpactPriceDropForceExitPct, 8);
  assert.equal(cfg.poolImpactConsecutiveDropTicks, 4);
  assert.equal(cfg.poolImpactLowerRangeBufferPct, 20);
  assert.equal(cfg.poolImpactAlertCooldownMs, 120000);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.poolImpactGuardEnabled, true);
  assert.equal(saved.poolImpactCheckIntervalMs, 5000);
  assert.equal(saved.poolImpactPriceDropForceExitPct, 8);
});

test('pool pattern learning config keys are supported and persisted via user config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-pattern-learning-config-'));
  const configPath = join(root, 'user-config.json');

  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.isConfigKeySupported('poolPatternLearningEnabled'), true);
  assert.equal(configModule.isConfigKeySupported('poolPatternLearningShadowMode'), true);
  assert.equal(configModule.isConfigKeySupported('poolPatternLearningMinSamples'), true);
  assert.equal(configModule.isConfigKeySupported('poolPatternLearningMaxScoreDelta'), true);
  assert.equal(configModule.isConfigKeySupported('poolPatternLearningLookbackDays'), true);

  configModule.updateConfig({
    poolPatternLearningEnabled: true,
    poolPatternLearningShadowMode: false,
    poolPatternLearningMinSamples: 12,
    poolPatternLearningMaxScoreDelta: 6,
    poolPatternLearningLookbackDays: 21,
  });

  const cfg = configModule.getConfig();
  assert.equal(cfg.poolPatternLearningEnabled, true);
  assert.equal(cfg.poolPatternLearningShadowMode, false);
  assert.equal(cfg.poolPatternLearningMinSamples, 12);
  assert.equal(cfg.poolPatternLearningMaxScoreDelta, 6);
  assert.equal(cfg.poolPatternLearningLookbackDays, 21);

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.poolPatternLearningEnabled, true);
  assert.equal(saved.poolPatternLearningShadowMode, false);
  assert.equal(saved.poolPatternLearningMinSamples, 12);
  assert.equal(saved.poolPatternLearningMaxScoreDelta, 6);
  assert.equal(saved.poolPatternLearningLookbackDays, 21);
});

test('/setconfig whitelist is curated for operational keys only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-setconfig-whitelist-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  const keys = Object.keys(configModule.SETCONFIG_WHITELIST);

  assert.equal(keys.includes('deployAmountSol'), true);
  assert.equal(keys.includes('minTvl'), true);
  assert.equal(keys.includes('maxMcap'), true);
  assert.equal(keys.includes('dlmmLiquidityShape'), true);
  assert.equal(keys.includes('deployRangeMinBinOffset'), true);
  assert.equal(keys.includes('deployRangeMaxBinOffset'), true);
  assert.equal(keys.includes('watchIntervalSec'), true);
  assert.equal(keys.includes('outOfRangeWaitMinutes'), true);
  assert.equal(keys.includes('poolImpactGuardEnabled'), true);
  assert.equal(keys.includes('poolPatternLearningEnabled'), true);
  assert.equal(keys.includes('entryCandleSanityEnabled'), true);
  assert.equal(keys.includes('entryDecisionMode'), true);
  assert.equal(keys.includes('entryMinVolumeRatio'), true);
  assert.equal(keys.includes('entryFinalProximityMaxDriftPct'), true);
  assert.equal(keys.includes('entryCandleMaxAgeSec'), true);
  assert.equal(keys.includes('entryRequireVolumeConfirm'), true);
  assert.equal(keys.includes('entryM15MinVolumeRatio'), true);
  assert.equal(keys.includes('entryM15MaxAgeSec'), true);
  assert.equal(keys.includes('entryM5HardGateEnabled'), true);
  assert.equal(keys.includes('entryDeferOnM15PreviousUnknown'), true);
  assert.equal(keys.includes('deployQueueHoldNotifyCooldownSec'), true);
  assert.equal(keys.includes('entryRequireGreenCandle'), false);
  assert.equal(keys.includes('entryVolumeLookbackCandles'), false);

  assert.equal(keys.includes('maxPoolAgeDays'), false);
  assert.equal(keys.includes('maxMcapUsd'), false);
  assert.equal(keys.includes('screeningIntervalMin'), false);
  assert.equal(keys.includes('realtimePnlIntervalSec'), false);
  assert.equal(keys.includes('jupiterMaxChecksPerScan'), false);
  assert.equal(keys.includes('retestIntervalMin'), false);
  assert.equal(keys.includes('retestTtlMin'), false);
  assert.equal(keys.includes('retestMaxAttempts'), false);
  assert.equal(keys.includes('retestMaxReadyPerScan'), false);
  assert.equal(keys.includes('poolImpactCheckIntervalMs'), false);
  assert.equal(keys.includes('poolImpactAlertCooldownMs'), false);
  assert.equal(keys.includes('poolPatternLearningLookbackDays'), false);
});

test('dlmmLiquidityShape supports nested strategy alias and persists normalized values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-liquidity-shape-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({ dlmmLiquidityShape: 'bid-ask' });
  let cfg = configModule.getConfig();
  assert.equal(cfg.dlmmLiquidityShape, 'bidask');

  const resolved = configModule.resolveNestedKey('strategy.liquidityShape');
  assert.equal(resolved?.flatKey, 'dlmmLiquidityShape');

  configModule.updateConfig({ [resolved.flatKey]: 'spot' });
  cfg = configModule.getConfig();
  assert.equal(cfg.dlmmLiquidityShape, 'spot');

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.dlmmLiquidityShape, 'spot');
});

test('dlmmLiquidityShape from config file invalid value falls back to spot with warning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-liquidity-shape-invalid-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  writeFileSync(configPath, JSON.stringify({
    dlmmLiquidityShape: 'curve',
  }, null, 2), 'utf-8');

  const warnLogs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnLogs.push(args.map((v) => String(v)).join(' ')); };
  try {
    const configModule = await importFresh(join(repoRoot, 'src/config.js'));
    const cfg = configModule.getConfig();
    assert.equal(cfg.dlmmLiquidityShape, 'spot');
    assert.equal(
      warnLogs.some((line) => line.includes('Invalid dlmmLiquidityShape "curve"') && line.includes('fallback ke "spot"')),
      true
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('dlmmLiquidityShape accepts mixed separator/case values and normalizes to bidask', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-liquidity-shape-normalize-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  configModule.updateConfig({ dlmmLiquidityShape: ' Bid_Ask ' });
  const cfg = configModule.getConfig();
  assert.equal(cfg.dlmmLiquidityShape, 'bidask');
});

test('setconfig help and shape alias keep spot/bidask global tuning visible', async () => {
  const indexPath = join(repoRoot, 'src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /\/setconfig strategy\.liquidityShape bidask/);
  assert.match(content, /\/setconfig strategy\.liquidityShape spot/);
  assert.match(content, /shape ini global, jadi sekali diubah akan dipakai semua jalur deploy berikutnya/);
  assert.match(content, /\/setconfig entryFinalProximityMaxDriftPct 2\.5/);
});

test('nested discovery maxMcap and legacy maxMcapUsd both map to canonical maxMcap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-mcap-alias-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  writeFileSync(configPath, JSON.stringify({
    discovery: {
      maxMcap: 1234567,
    },
  }, null, 2), 'utf-8');

  const configModule = await importFresh(join(repoRoot, 'src/config.js'));
  let cfg = configModule.getConfig();
  assert.equal(cfg.maxMcap, 1234567);
  assert.equal(configModule.resolveNestedKey('discovery.maxMcap')?.flatKey, 'maxMcap');
  assert.equal(configModule.resolveNestedKey('discovery.maxMcapUsd'), null);
  assert.equal(configModule.resolveNestedKey('discovery.category')?.flatKey, 'discoveryCategory');

  writeFileSync(configPath, JSON.stringify({
    discovery: {
      maxMcapUsd: 7654321,
    },
  }, null, 2), 'utf-8');
  const configModuleLegacy = await importFresh(join(repoRoot, 'src/config.js'));
  cfg = configModuleLegacy.getConfig();
  assert.equal(cfg.maxMcap, 7654321);
});

test('discovery category is writable via setconfig alias and persists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-discovery-category-'));
  const configPath = join(root, 'user-config.json');
  process.env.BOT_CONFIG_PATH = configPath;
  const configModule = await importFresh(join(repoRoot, 'src/config.js'));

  assert.equal(configModule.resolveNestedKey('discovery.category')?.flatKey, 'discoveryCategory');
  configModule.updateConfig({ discoveryCategory: 'top performers' });

  const cfg = configModule.getConfig();
  assert.equal(cfg.discoveryCategory, 'top performers');

  const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
  assert.equal(saved.discoveryCategory, 'top performers');
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
