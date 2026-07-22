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

test('resolvePositionSnapshot keeps pnl/status consistent across surfaces', async () => {
  const { resolvePositionSnapshot } = await importFresh(join(repoRoot, 'src/app/positionSnapshot.js'));

  const snapshot = resolvePositionSnapshot({
    dbPosition: {
      position_address: 'pos-1',
      deployed_sol: 2,
      status: 'open',
      lifecycle_state: 'open',
    },
    livePosition: {
      currentValueSol: 2.1,
      feeCollectedSol: 0.04,
      inRange: false,
    },
    providerPnlPct: 7.5,
  });

  assert.equal(snapshot.status, 'OutRange');
  assert.equal(snapshot.lifecycleState, 'open');
  assert.equal(snapshot.pnlPct, 7.5);
  assert.equal(snapshot.pnlSol, 0.15);
  assert.equal(snapshot.feeSol, 0.04);
  assert.equal(snapshot.pnlSource, 'lp_agent');
});

test('position runtime state persists peak pnl and oor markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-runtime-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const runtimeModule = await importFresh(join(repoRoot, 'src/app/positionRuntimeState.js'));
  runtimeModule.updatePositionRuntimeState('pos-abc', {
    peakPnlPct: 9.2,
    trailingActive: true,
    oorSince: 123456,
  });

  const runtimeModuleReloaded = await importFresh(join(repoRoot, 'src/app/positionRuntimeState.js'));
  const state = runtimeModuleReloaded.getPositionRuntimeState('pos-abc');
  assert.equal(state.peakPnlPct, 9.2);
  assert.equal(state.trailingActive, true);
  assert.equal(state.oorSince, 123456);
});

test('out-of-range monitor state waits, expires, and clears correctly', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const waiting = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: {},
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 0,
  });

  assert.equal(waiting.shouldExit, false);
  assert.equal(waiting.runtimePatch.oorSince, 0);
  assert.match(waiting.notifyMessage, /OOR \| OOR1-SOL/);
  assert.match(waiting.notifyMessage, /Duration: <code>0\.0 menit<\/code> \/ <code>1\.0 menit<\/code>/);

  const expired = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 61_000,
  });

  assert.equal(expired.shouldExit, true);
  assert.equal(expired.exitReason, 'OUT_OF_RANGE_1M');
  assert.match(expired.notifyMessage, /OOR LIMIT REACHED \| OOR1-SOL/);
  assert.match(expired.notifyMessage, /Action: <code>CLOSING<\/code>/);

  const recovered = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-1',
    symbol: 'OOR1',
    status: { inRange: true, currentValueSol: 0.4, pnlPct: -2.2 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 90_000,
  });

  assert.equal(recovered.clearOorMarkers, true);
  assert.deepEqual(recovered.runtimePatch, { oorSince: null, lastOorAlertAt: null });
  assert.match(recovered.notifyMessage, /RANGE RECOVERED \| OOR1-SOL/);
  assert.match(recovered.notifyMessage, /Duration OOR: <code>1\.5 menit<\/code>/);
});

test('out-of-range monitor display keeps alert cadence separate from the actual 30 minute close limit', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const waiting = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-2',
    symbol: 'OOR2',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -1.1 },
    runtimeState: {},
    cfg: { outOfRangeWaitMinutes: 30 },
    now: 0,
  });

  assert.equal(waiting.shouldExit, false);
  assert.match(waiting.notifyMessage, /OOR \| OOR2-SOL/);
  assert.match(waiting.notifyMessage, /Duration: <code>0\.0 menit<\/code> \/ <code>30 menit<\/code>/);
  assert.match(waiting.notifyMessage, /Status: <code>MONITORING<\/code>/);
  assert.doesNotMatch(waiting.notifyMessage, /Next check/);

  const expired = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-2',
    symbol: 'OOR2',
    status: { inRange: false, currentValueSol: 0.4, pnlPct: -1.1 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 30 },
    now: 30 * 60_000 + 1,
  });

  assert.equal(expired.shouldExit, true);
  assert.equal(expired.exitReason, 'OUT_OF_RANGE_30M');
  assert.match(expired.notifyMessage, /Duration: <code>30 menit<\/code> \/ <code>30 menit<\/code>/);
  assert.match(expired.logMessage, /wait=1800000ms/);
  assert.match(expired.logMessage, /alertCooldown=300000ms/);
});

test('out-of-range monitor state throttles OOR watch alerts by display wait minutes', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const cfg = { outOfRangeWaitMinutes: 45, oorDisplayWaitMinutes: 5 };

  const first = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: {},
    cfg,
    now: 0,
  });

  assert.equal(first.shouldExit, false);
  assert.match(first.notifyMessage, /OOR \| OOR3-SOL/);

  const second = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg,
    now: 60_000,
  });

  assert.equal(second.shouldExit, false);
  assert.equal(second.notifyMessage, null);
  assert.equal(second.logMessage, null);

  const third = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-3',
    symbol: 'OOR3',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: 0.19 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg,
    now: 5 * 60_000 + 1,
  });

  assert.equal(third.shouldExit, false);
  assert.match(third.notifyMessage, /OOR \| OOR3-SOL/);
  assert.match(third.notifyMessage, /Duration: <code>5\.0 menit<\/code> \/ <code>45 menit<\/code>/);
});

test('out-of-range monitor state can suppress OOR watch display while keeping exit logic', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const suppressed = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-4',
    symbol: 'OOR4',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: -0.2 },
    runtimeState: {},
    cfg: { outOfRangeWaitMinutes: 30, oorWatchDisplayEnabled: false },
    now: 0,
  });

  assert.equal(suppressed.shouldExit, false);
  assert.equal(suppressed.notifyMessage, null);
  assert.equal(suppressed.logMessage, null);

  const expired = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-4',
    symbol: 'OOR4',
    status: { inRange: false, currentValueSol: 0.5, pnlPct: -0.2 },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1, oorWatchDisplayEnabled: false },
    now: 61_000,
  });

  assert.equal(expired.shouldExit, true);
  assert.equal(expired.exitReason, 'OUT_OF_RANGE_1M');
  assert.match(expired.notifyMessage, /OOR LIMIT REACHED \| OOR4-SOL/);
});

test('invalid tracked pool registry falls back to manual withdrawn when position account is gone', async () => {
  const {
    __resolveInvalidTrackedPositionStatusForTests,
    __setActivePositionMetaForTests,
    __setQuoteOnlyDeployMarkerForTests,
  } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const positionPubkey = '11111111111111111111111111111111';
  __setActivePositionMetaForTests(positionPubkey, {
    poolAddress: '',
    tokenXMint: 'MintInvalid111111111111111111111111111111111',
    deploySol: 0.6,
    lifecycleState: 'open',
  });

  const status = await __resolveInvalidTrackedPositionStatusForTests({
    connection: {
      getAccountInfo: async () => null,
    },
    positionPubkey,
    poolAddress: '',
    marker: null,
  });

  assert.equal(status?.tracked, true);
  assert.equal(status?.manualWithdrawn, true);
  assert.equal(status?.reason, 'POSITION_REGISTRY_POOL_MISSING');

  __setActivePositionMetaForTests(positionPubkey, null);
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('invalid tracked pool registry preserves quote-only partial marker semantics', async () => {
  const {
    __resolveInvalidTrackedPositionStatusForTests,
    __setActivePositionMetaForTests,
    __setQuoteOnlyDeployMarkerForTests,
    __getQuoteOnlyDeployMarkerForTests,
  } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const positionPubkey = '11111111111111111111111111111111';
  __setActivePositionMetaForTests(positionPubkey, {
    poolAddress: '',
    tokenXMint: 'MintPartial111111111111111111111111111111111',
    deploySol: 0.6,
    lifecycleState: 'deploying',
  });
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, {
    poolAddress: '',
    tokenXMint: 'MintPartial111111111111111111111111111111111',
    phase: 'ADD_LIQUIDITY_FAILED',
    source: 'BOT_QUOTE_ONLY_POSITION_FIRST',
    ttlMs: 120000,
  });

  const marker = __getQuoteOnlyDeployMarkerForTests(positionPubkey);
  const status = await __resolveInvalidTrackedPositionStatusForTests({
    connection: {
      getAccountInfo: async () => null,
    },
    positionPubkey,
    poolAddress: '',
    marker,
  });

  assert.equal(status?.manualWithdrawn, false);
  assert.equal(status?.reason, 'BOT_DEPLOY_PARTIAL_EMPTY_POSITION');
  assert.equal(status?.registryIssue, 'POSITION_REGISTRY_POOL_MISSING');

  __setActivePositionMetaForTests(positionPubkey, null);
  __setQuoteOnlyDeployMarkerForTests(positionPubkey, null);
});

test('manual close cleanup releases slot after stale tracked position is reconciled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-manual-close-slot-'));
  process.env.BOT_RUNTIME_STATE_PATH = join(root, 'runtime-state.json');

  const {
    getActivePositionCount,
    markPositionManuallyClosed,
    setPositionLifecycle,
  } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const positionPubkey = '11111111111111111111111111111111';
  await setPositionLifecycle(positionPubkey, 'open', {
    poolAddress: '',
    tokenXMint: 'MintSlot11111111111111111111111111111111111',
    tokenYMint: 'So11111111111111111111111111111111111111112',
    deploySol: 0.6,
    currentValueSol: 0.6,
    feePnlSol: 0.0001,
    feePnlPct: 0.01,
    feePnlAvailable: true,
  }, { flush: true });

  assert.equal(getActivePositionCount(), 1);

  await markPositionManuallyClosed(positionPubkey, 'MANUAL_WITHDRAW_DETECTED_POSITION_REGISTRY_POOL_MISSING');

  assert.equal(getActivePositionCount(), 0);
});

test('out-of-range monitor state trusts canonical active bin range over stale inRange flag', async () => {
  const { evaluateOutOfRangeMonitorState } = await importFresh(join(repoRoot, 'src/agents/hunterAlpha.js'));

  const recovered = evaluateOutOfRangeMonitorState({
    positionPubkey: 'pos-oor-canonical',
    symbol: 'OORC',
    status: {
      inRange: false,
      activeBinId: 105,
      rangeMin: 100,
      rangeMax: 110,
      currentValueSol: 0.8,
      pnlPct: -0.5,
    },
    runtimeState: { oorSince: 0, lastOorAlertAt: 0 },
    cfg: { outOfRangeWaitMinutes: 1 },
    now: 20_000,
  });

  assert.equal(recovered.clearOorMarkers, true);
  assert.deepEqual(recovered.runtimePatch, { oorSince: null, lastOorAlertAt: null });
  assert.match(recovered.notifyMessage, /RANGE RECOVERED \| OORC-SOL/);
});

test('position lifecycle state is stored alongside close records', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-db-'));
  process.env.BOT_DB_PATH = join(root, 'test.db');

  let dbModule;
  try {
    dbModule = await importFresh(join(repoRoot, 'src/db/database.js'));
  } catch (error) {
    const message = String(error?.message || '');
    if (
      message.includes('Could not locate the bindings file') ||
      message.includes('native binding tidak cocok') ||
      message.includes('NODE_MODULE_VERSION')
    ) {
      t.skip('better-sqlite3 native binding is not available in this test environment');
      return;
    }
    throw error;
  }

  dbModule.savePosition({
    pool_address: 'pool-1',
    position_address: 'position-1',
    token_x: 'mint-x',
    token_y: 'mint-y',
    deployed_sol: 1.5,
  });

  dbModule.updatePositionLifecycle('position-1', 'closing');
  let open = dbModule.getOpenPositions().find((p) => p.position_address === 'position-1');
  assert.equal(open.lifecycle_state, 'closing');

  dbModule.closePositionWithPnl('position-1', {
    pnlUsd: 12.3,
    pnlPct: 8.2,
    feesUsd: 1.1,
    closeReason: 'TAKE_PROFIT',
    lifecycleState: 'closed_pending_swap',
  });

  const closed = dbModule.getClosedPositions().find((p) => p.position_address === 'position-1');
  assert.equal(closed.lifecycle_state, 'closed_pending_swap');
  assert.equal(closed.status, 'closed');
});

test('defensive Supertrend exit requires a short confirmation window', async () => {
  const { __evaluateDefensiveExitConfirmationForTests } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const reg = {};
  const firstBearish = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 10_000,
    outOfRangeSide: 'LOW',
    nowMs: 1_000,
  });

  assert.equal(firstBearish.allowExit, false);
  assert.match(firstBearish.holdReason, /position age 10s < 30s minimum/);
  assert.equal(reg.defensiveExitBearishSince, 1_000);

  const secondBearish = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 35_000,
    outOfRangeSide: 'LOW',
    nowMs: 20_000,
  });

  assert.equal(secondBearish.allowExit, false);
  assert.match(secondBearish.holdReason, /bearish confirmation 19s < 30s/);

  const confirmedBearish = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 65_000,
    outOfRangeSide: 'LOW',
    nowMs: 32_000,
  });

  assert.equal(confirmedBearish.allowExit, true);
  assert.equal(confirmedBearish.holdReason, null);

  const recovery = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: false, scenario: null, reason: 'Signal unavailable — HOLD' },
    ageMs: 70_000,
    nowMs: 40_000,
  });

  assert.equal(recovery.allowExit, false);
  assert.equal(recovery.holdReason, null);
  assert.equal('defensiveExitBearishSince' in reg, false);
});

test('defensive Supertrend exit respects fresh bullish entry confirmation before allowing scenario C', async () => {
  const { __evaluateDefensiveExitConfirmationForTests } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const reg = {
    entryFinalSupertrend15m: 'BULLISH',
    entryFinalSupertrendSource: 'fresh_fetch',
    entryFinalSupertrendAt: 10_000,
  };

  const freshBullishEntryHold = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 45_000,
    outOfRangeSide: 'LOW',
    nowMs: 25_000,
  });

  assert.equal(freshBullishEntryHold.allowExit, false);
  assert.match(freshBullishEntryHold.holdReason, /entry bullish confirmation 15s < 30s/);

  const matureBullishEntry = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 75_000,
    outOfRangeSide: 'LOW',
    nowMs: 56_000,
  });

  assert.equal(matureBullishEntry.allowExit, true);
  assert.equal(matureBullishEntry.holdReason, null);
});

test('defensive Supertrend exit stays blocked while position is still in range', async () => {
  const { __evaluateDefensiveExitConfirmationForTests } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const reg = {
    entryFinalSupertrend15m: 'BULLISH',
    entryFinalSupertrendSource: 'fresh_fetch',
    entryFinalSupertrendAt: 10_000,
  };

  const decision = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 75_000,
    inRange: true,
    nowMs: 56_000,
  });

  assert.equal(decision.allowExit, false);
  assert.match(decision.holdReason, /position still in range/i);
});

test('defensive Supertrend exit allows only out-of-range low condition', async () => {
  const { __evaluateDefensiveExitConfirmationForTests } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const reg = {
    entryFinalSupertrend15m: 'BULLISH',
    entryFinalSupertrendSource: 'fresh_fetch',
    entryFinalSupertrendAt: 10_000,
  };

  const oorLowFirst = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 75_000,
    inRange: false,
    outOfRangeSide: 'LOW',
    nowMs: 60_000,
  });

  assert.equal(oorLowFirst.allowExit, false);
  assert.match(oorLowFirst.holdReason, /bearish confirmation 0s < 30s/i);

  const oorLowConfirmed = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 110_000,
    inRange: false,
    outOfRangeSide: 'LOW',
    nowMs: 91_000,
  });

  assert.equal(oorLowConfirmed.allowExit, true);
  assert.equal(oorLowConfirmed.holdReason, null);

  const oorHigh = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 90_000,
    inRange: false,
    outOfRangeSide: 'HIGH',
    nowMs: 90_000,
  });

  assert.equal(oorHigh.allowExit, false);
  assert.match(oorHigh.holdReason, /out of range high/i);

  const unknownOor = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 90_000,
    inRange: false,
    outOfRangeSide: 'UNKNOWN',
    nowMs: 90_000,
  });

  assert.equal(unknownOor.allowExit, false);
  assert.match(unknownOor.holdReason, /waiting confirmed out-of-range low/i);
});

test('defensive Supertrend exit does not trust non-canonical bullish entry stamp', async () => {
  const { __evaluateDefensiveExitConfirmationForTests } = await importFresh(join(repoRoot, 'src/sniper/evilPanda.js'));

  const reg = {
    entryFinalSupertrend15m: 'BULLISH',
    entryFinalSupertrendSource: 'live_snapshot',
    entryFinalSupertrendAt: 10_000,
  };

  const decision = __evaluateDefensiveExitConfirmationForTests({
    reg,
    exitDecision: { shouldExit: true, scenario: 'C', reason: 'Struktur Support Jebol (Supertrend = BEARISH)' },
    ageMs: 45_000,
    outOfRangeSide: 'LOW',
    nowMs: 25_000,
  });

  assert.equal(decision.allowExit, false);
  assert.match(decision.holdReason, /bearish confirmation 0s < 30s/);
});
