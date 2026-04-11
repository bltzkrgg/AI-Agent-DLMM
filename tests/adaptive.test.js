import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('adaptive strategy refresh tightens weak Wave Enjoyer setups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-adaptive-'));
  const configPath = join(root, 'user-config.json');
  const adaptivePath = join(root, 'strategy-adaptive.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath, JSON.stringify({}, null, 2));

  process.env.BOT_CONFIG_PATH = configPath;
  process.env.BOT_ADAPTIVE_STRATEGY_PATH = adaptivePath;

  const adaptiveModule = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/strategies/adaptive.js');
  const profilesModule = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/strategies/profiles.js');

  const closedPositions = [
    {
      strategy_used: 'Wave Enjoyer',
      pnl_pct: -6.2,
      range_efficiency_pct: 18,
      close_reason: 'OUT_OF_RANGE',
      created_at: '2026-04-10T00:00:00.000Z',
      closed_at: '2026-04-10T00:18:00.000Z',
    },
    {
      strategy_used: 'Wave Enjoyer',
      pnl_pct: -2.4,
      range_efficiency_pct: 22,
      close_reason: 'OUT_OF_RANGE',
      created_at: '2026-04-10T01:00:00.000Z',
      closed_at: '2026-04-10T01:14:00.000Z',
    },
    {
      strategy_used: 'Wave Enjoyer',
      pnl_pct: 4.2,
      range_efficiency_pct: 81,
      close_reason: 'TAKE_PROFIT',
      created_at: '2026-04-10T02:00:00.000Z',
      closed_at: '2026-04-10T02:12:00.000Z',
    },
  ];

  const result = adaptiveModule.refreshAdaptiveStrategyOverrides({ closedPositions, persist: true });
  assert.equal(result.updated, true);
  assert.ok(result.strategies['Wave Enjoyer']);
  assert.ok(result.strategies['Wave Enjoyer'].entry.minVolume5mUsd >= 100000);
  assert.ok(result.strategies['Wave Enjoyer'].exit.holdMaxMinutes <= 20);

  const profile = profilesModule.getStrategyProfile('Wave Enjoyer');
  assert.ok(profile.entry.minVolume5mUsd >= 100000);
  assert.ok(profile.exit.holdMaxMinutes <= 20);
});

test('manual strategy overrides still win over adaptive tuning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-adaptive-manual-'));
  const configPath = join(root, 'user-config.json');
  const adaptivePath = join(root, 'strategy-adaptive.json');
  mkdirSync(root, { recursive: true });

  process.env.BOT_CONFIG_PATH = configPath;
  process.env.BOT_ADAPTIVE_STRATEGY_PATH = adaptivePath;

  writeFileSync(configPath, JSON.stringify({
    strategyOverrides: {
      'Wave Enjoyer': {
        exit: { holdMaxMinutes: 25 },
      },
    },
  }, null, 2));

  const adaptiveModule = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/strategies/adaptive.js');
  const profilesModule = await importFresh('/Users/mkhtramn/Documents/New project/repo/src/strategies/profiles.js');

  adaptiveModule.refreshAdaptiveStrategyOverrides({
    closedPositions: [
      {
        strategy_used: 'Wave Enjoyer',
        pnl_pct: -7.1,
        range_efficiency_pct: 15,
        close_reason: 'OUT_OF_RANGE',
        created_at: '2026-04-10T00:00:00.000Z',
        closed_at: '2026-04-10T00:10:00.000Z',
      },
      {
        strategy_used: 'Wave Enjoyer',
        pnl_pct: -4.2,
        range_efficiency_pct: 12,
        close_reason: 'OUT_OF_RANGE',
        created_at: '2026-04-10T01:00:00.000Z',
        closed_at: '2026-04-10T01:09:00.000Z',
      },
      {
        strategy_used: 'Wave Enjoyer',
        pnl_pct: 3.8,
        range_efficiency_pct: 75,
        close_reason: 'TAKE_PROFIT',
        created_at: '2026-04-10T02:00:00.000Z',
        closed_at: '2026-04-10T02:13:00.000Z',
      },
    ],
    persist: true,
  });

  const profile = profilesModule.getStrategyProfile('Wave Enjoyer');
  assert.equal(profile.exit.holdMaxMinutes, 25);
});
