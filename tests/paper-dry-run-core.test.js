import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hunterPath = resolve(process.cwd(), 'src/agents/hunterAlpha.js');
const evilPandaPath = resolve(process.cwd(), 'src/sniper/evilPanda.js');
const queuePath = resolve(process.cwd(), 'src/utils/pendingDeployQueue.js');
const slotGuardPath = resolve(process.cwd(), 'src/utils/deploySlotGuard.js');

test('paper deploy returns before transaction construction and priority fee fetch', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  const paperReturnAt = src.indexOf('[PAPER] deploy plan ready');
  const priorityFeeAt = src.indexOf('microLamports = await getPriorityFee()', paperReturnAt);
  const txBuildAt = src.indexOf('const buildPreparedAttemptState', paperReturnAt);

  assert.notEqual(paperReturnAt, -1);
  assert.ok(priorityFeeAt > paperReturnAt);
  assert.ok(txBuildAt > paperReturnAt);
  assert.match(src.slice(paperReturnAt, priorityFeeAt), /paper:\s*true/);
});

test('direct paper deploy opens paper state before real learning lifecycle', () => {
  const src = readFileSync(hunterPath, 'utf8');
  const paperBranchAt = src.indexOf('deployResult.paper === true');
  const learningAt = src.indexOf('recordPoolPatternEntry({', paperBranchAt);

  assert.notEqual(paperBranchAt, -1);
  assert.ok(learningAt > paperBranchAt);
  assert.match(
    src.slice(paperBranchAt, learningAt),
    /openPaperPositionFromDeployPlan\(deployResult/
  );
  assert.match(src.slice(paperBranchAt, learningAt), /return true;/);
});

test('queue carries execution mode through slot reservation and deploy call', () => {
  const src = readFileSync(queuePath, 'utf8');

  assert.match(src, /function getQueueExecutionMode\(cfg = getConfig\(\)\)/);
  assert.match(src, /reserveDeploySlot\(\{[\s\S]*executionMode,/);
  assert.match(src, /_deployFn\(poolAddress, \{\s*executionMode,/);
  assert.match(src, /classifiedResult\.status === 'PAPER_PLAN'/);
  assert.match(src, /await _monitorFn\(result, symbol, poolAddress, \{/);
});

test('paper and real deploy slots use separate active and reservation counts', () => {
  const src = readFileSync(slotGuardPath, 'utf8');

  assert.match(
    src,
    /const active = mode === 'paper' \? getPaperPositionCount\(\) : getActivePositionKeys\(\)\.length/
  );
  assert.match(src, /row\.executionMode === mode/);
  assert.match(src, /executionMode:\s*mode/);
});

test('paper monitor closes only through paper ledger path', () => {
  const src = readFileSync(hunterPath, 'utf8');
  const monitorAt = src.indexOf('async function paperMonitorLoop');
  const nextSectionAt = src.indexOf('function getIdleDelayMin', monitorAt);
  const monitorBlock = src.slice(monitorAt, nextSectionAt);

  assert.match(monitorBlock, /evaluatePositionExitPolicy\(\{/);
  assert.match(monitorBlock, /evaluateOutOfRangeMonitorState\(\{/);
  assert.match(monitorBlock, /evaluatePoolImpactGuard\(\{/);
  assert.match(monitorBlock, /closePaperPosition\(positionId,/);
  assert.doesNotMatch(monitorBlock, /exitPosition\(/);
  assert.doesNotMatch(monitorBlock, /recordPoolPatternEntry\(/);
  assert.doesNotMatch(monitorBlock, /appendHarvestLog\(/);
});

test('paper valuation rejects missing live price and active bin instead of coercing them to zero', () => {
  const src = readFileSync(hunterPath, 'utf8');
  const valuationAt = src.indexOf('export function evaluatePaperPositionValue');
  const monitorAt = src.indexOf('async function openPaperPositionFromDeployPlan', valuationAt);
  const valuationBlock = src.slice(valuationAt, monitorAt);

  assert.match(valuationBlock, /const currentPrice = toFiniteNumber\(activePrice, null\)/);
  assert.match(valuationBlock, /const currentBin = toFiniteNumber\(activeBinId, null\)/);
  assert.doesNotMatch(valuationBlock, /const currentPrice = Number\(activePrice\)/);
  assert.doesNotMatch(valuationBlock, /const currentBin = Number\(activeBinId\)/);
});

test('deploy execution no longer branches on the mutable global dry-run toggle', () => {
  const src = readFileSync(evilPandaPath, 'utf8');

  assert.doesNotMatch(src, /import \{ getConfig, isDryRun \} from '\.\.\/config\.js'/);
  assert.doesNotMatch(src, /isDryRun\(\)/);
  assert.match(src, /const paperMode = executionMode === 'paper'/);
});

test('paper monitors restore after restart and remain isolated from real shutdown closes', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');

  assert.match(hunterSrc, /export function spawnMonitorForRestoredPaperPositions\(\)/);
  assert.match(hunterSrc, /paperMonitorLoop\(position\.id\)/);
  assert.match(hunterSrc, /\[PAPER\] RESTORE scanned=/);
  const restoreAt = hunterSrc.indexOf('export function spawnMonitorForRestoredPaperPositions');
  const restoreBlock = hunterSrc.slice(restoreAt, hunterSrc.indexOf('// ── Exit helper', restoreAt));
  assert.doesNotMatch(restoreBlock, /safeExit\(/);
  assert.doesNotMatch(restoreBlock, /exitPosition\(/);
});

test('paper monitor sends realtime paper reporting on the configured interval', () => {
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  const monitorAt = hunterSrc.indexOf('async function paperMonitorLoop');
  const monitorEnd = hunterSrc.indexOf('function getIdleDelayMin', monitorAt);
  const monitorBlock = hunterSrc.slice(monitorAt, monitorEnd);

  assert.match(monitorBlock, /shouldLogRealtimePnl\(positionId\)/);
  assert.match(monitorBlock, /formatPaperRealtimeNotification/);
  assert.match(monitorBlock, /getRealtimePnlIntervalMs\(\)/);
});
