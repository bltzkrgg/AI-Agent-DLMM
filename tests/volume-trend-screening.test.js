import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function importFresh(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}_${Math.random()}`);
}

test('volume trend classifier keeps a simple 3-state soft signal', async () => {
  const mod = await importFresh(join(repoRoot, 'src/market/poolMemory.js'));

  const up = mod.classifyVolumeTrend(120, 100);
  assert.equal(up.state, 'ACCELERATING');
  assert.equal(up.priorityDelta > 0, true);

  const flat = mod.classifyVolumeTrend(104, 100);
  assert.equal(flat.state, 'STABLE');
  assert.equal(flat.priorityDelta, 0);

  const down = mod.classifyVolumeTrend(80, 100);
  assert.equal(down.state, 'DECELERATING');
  assert.equal(down.priorityDelta < 0, true);
});

test('pool memory updates previous/current volume snapshots and exposes volume trend in signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-volume-trend-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const mod = await importFresh(join(repoRoot, 'src/market/poolMemory.js'));
  const key = 'MintVolume111111111111111111111111111111111';

  mod.recordPoolDecision({
    key,
    decision: 'WATCH',
    snapshot: { taTrend: 'BULLISH', priceChangeM5: 1.1, volume24h: 100000 },
  });
  mod.recordPoolDecision({
    key,
    decision: 'WATCH',
    snapshot: { taTrend: 'BULLISH', priceChangeM5: 1.2, volume24h: 118000 },
  });

  const memory = mod.getPoolMemory(key);
  assert.equal(memory.previousVolume24h, 100000);
  assert.equal(memory.recentVolume24h, 118000);

  const signal = mod.getPoolMemorySignal(key);
  assert.equal(signal.volumeTrend.state, 'ACCELERATING');
});

test('hunter volume trend sort delta stays a ranking bias, not a deploy gate', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const source = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf8');

  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'ACCELERATING' } }), 1);
  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'DECELERATING' } }), -1);
  assert.equal(hunter.__volumeTrendSortDeltaForTests({ _volumeTrendSignal: { state: 'STABLE' } }), 0);

  assert.doesNotMatch(source, /volumeTrendEnabled/);
  assert.doesNotMatch(source, /VOLUME_TREND.*REJECT|REJECT.*VOLUME_TREND/);
});

test('hunter activity bias prefers living fee-flow pools without becoming a hard gate', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const active = {
    volume24h: 520000,
    feeActiveTvlRatio: 0.019,
    fees24h: 1400,
    activeTvl: 130000,
    _volumeTrendSignal: { state: 'ACCELERATING' },
  };
  const quiet = {
    volume24h: 42000,
    feeActiveTvlRatio: 0.004,
    fees24h: 70,
    activeTvl: 120000,
    _volumeTrendSignal: { state: 'DECELERATING' },
  };
  const source = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf8');

  assert.equal(hunter.__poolActivityBiasScoreForTests(active) > hunter.__poolActivityBiasScoreForTests(quiet), true);
  assert.doesNotMatch(source, /POOL_ACTIVITY.*REJECT|REJECT.*POOL_ACTIVITY/);
});

test('hunter pool selector prefers living flow over dry higher fee ratio pool', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const activeSpike = {
    volume24h: 910000,
    feeActiveTvlRatio: 0.018,
    fees24h: 1200,
    activeTvl: 135000,
    swapCount24h: 1700,
    _volumeTrendSignal: { state: 'ACCELERATING' },
  };
  const dryHigherRatio = {
    volume24h: 68000,
    feeActiveTvlRatio: 0.033,
    fees24h: 65,
    activeTvl: 21000,
    swapCount24h: 105,
    _volumeTrendSignal: { state: 'DECELERATING' },
  };

  assert.equal(hunter.__poolLivingFlowScoreForTests(activeSpike) > hunter.__poolLivingFlowScoreForTests(dryHigherRatio), true);
  assert.equal(
    hunter.__comparePoolsByFeeGenerationForTests(activeSpike, dryHigherRatio, [200, 125, 100]) < 0,
    true,
  );
});

test('hunter selector lets active cross-bin pool beat a stale preferred-bin pool', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const stalePreferredBin = {
    binStep: 100,
    volume24h: 900000,
    fees24h: 0,
    swapCount24h: 0,
    activityState: 'STALE_SPIKE',
    activeTvl: 30000,
  };
  const activeOtherBin = {
    binStep: 125,
    volume1h: 52000,
    volume24h: 120000,
    fees1h: 95,
    fees24h: 240,
    swapCount1h: 180,
    swapCount24h: 700,
    activityState: 'OBSERVED_ACTIVE',
    activeTvl: 18000,
  };

  assert.equal(hunter.__isObservedDryPoolForTests(stalePreferredBin), true);
  assert.equal(
    hunter.__comparePoolsByFeeGenerationForTests(activeOtherBin, stalePreferredBin, [100, 125, 200]) < 0,
    true,
  );
});

test('hunter activity display keeps unavailable evidence as N/A', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const active = hunter.__poolActivityDisplayMetaForTests({
    activityState: 'OBSERVED_ACTIVE',
    activityWindow: '1h',
    swapCount1h: 2504,
    flowTrendEvidenceAvailable: true,
    flowTrendScore: 76,
  });
  const unknown = hunter.__poolActivityDisplayMetaForTests({
    activityState: 'UNKNOWN_ACTIVITY',
    discoveryTimeframe: '1h',
    swapCount1h: null,
    flowTrendEvidenceAvailable: false,
  });

  assert.deepEqual(active, {
    state: 'ACTIVE',
    window: '1h',
    swapCount: 2504,
    flowTrendScore: 76,
  });
  assert.deepEqual(unknown, {
    state: 'UNKNOWN',
    window: '1h',
    swapCount: null,
    flowTrendScore: null,
  });
});

test('hunter screening rank uses batch percentile as ranking only, not a gate', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const active = {
    address: 'PoolActive',
    volume24h: 680000,
    fees24h: 1600,
    feeActiveTvlRatio: 0.021,
    activeTvl: 140000,
    swapCount24h: 1800,
    priceChangePct: 62,
  };
  const warm = {
    address: 'PoolWarm',
    volume24h: 185000,
    fees24h: 420,
    feeActiveTvlRatio: 0.011,
    activeTvl: 120000,
    swapCount24h: 540,
    priceChangePct: 18,
  };
  const cold = {
    address: 'PoolCold',
    volume24h: 24000,
    fees24h: 55,
    feeActiveTvlRatio: 0.003,
    activeTvl: 125000,
    swapCount24h: 64,
    priceChangePct: -6,
  };

  const pools = [active, warm, cold];
  const activeRank = hunter.__screeningRankScoreForTests(active, pools);
  const warmRank = hunter.__screeningRankScoreForTests(warm, pools);
  const coldRank = hunter.__screeningRankScoreForTests(cold, pools);

  assert.equal(activeRank.score > warmRank.score, true);
  assert.equal(warmRank.score > coldRank.score, true);
  assert.equal(activeRank.activityPercentile >= warmRank.activityPercentile, true);
  assert.equal(warmRank.activityPercentile >= coldRank.activityPercentile, true);
  assert.equal(activeRank.freshnessState, 'ACTIVE');
  assert.equal(warmRank.freshnessState, 'WARM');
  assert.equal(coldRank.freshnessState, 'STALE');
  assert.equal(activeRank.freshnessPriorityDelta > warmRank.freshnessPriorityDelta, true);
  assert.equal(warmRank.freshnessPriorityDelta > coldRank.freshnessPriorityDelta, true);
});

test('screening freshness classifier stays a soft priority layer', async () => {
  const hunter = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));
  const source = readFileSync(join(repoRoot, 'src/agents/hunterAlpha.js'), 'utf8');

  const active = hunter.__classifyScreeningFreshnessForTests({
    activityPercentile: 0.82,
    activityBias: 5,
    volumeTrend: 1,
    volume24h: 300000,
    fees24h: 900,
  });
  const warm = hunter.__classifyScreeningFreshnessForTests({
    activityPercentile: 0.42,
    activityBias: 1,
    volumeTrend: 0,
    volume24h: 80000,
    fees24h: 120,
  });
  const stale = hunter.__classifyScreeningFreshnessForTests({
    activityPercentile: 0.12,
    activityBias: -3,
    volumeTrend: -1,
    volume24h: 22000,
    fees24h: 40,
  });

  assert.equal(active.state, 'ACTIVE');
  assert.equal(warm.state, 'WARM');
  assert.equal(stale.state, 'STALE');
  assert.equal(active.priorityDelta > warm.priorityDelta, true);
  assert.equal(warm.priorityDelta > stale.priorityDelta, true);
  assert.doesNotMatch(source, /SCREENING_FRESHNESS.*REJECT|REJECT.*SCREENING_FRESHNESS/);
});
