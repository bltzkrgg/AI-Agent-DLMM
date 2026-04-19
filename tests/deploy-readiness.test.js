import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeployReadiness } from '../src/app/deployReadiness.js';

test('deploy readiness blocks unsafe live conditions', () => {
  const result = evaluateDeployReadiness({
    solanaReady: false,
    circuitState: 'OPEN',
    pendingReconcile: 2,
    manualReviewOpen: 1,
    manualReviewThreshold: 1,
    autoPauseOnManualReview: true,
    failedOps6h: 12,
    deploymentStage: 'full',
    targetStage: 'full',
    dryRun: false,
    autoScreeningEnabled: true,
    taeExitCount: 20,
    taeWinRatePct: 55,
    minTaeSamplesForFullStage: 10,
    minTaeWinRateForFullStage: 45,
  });

  assert.equal(result.ready, false);
  assert.equal(result.blockers.length >= 4, true);
  assert.equal(result.score < 60, true);
});

test('deploy readiness stays ready with only non-critical warnings', () => {
  const result = evaluateDeployReadiness({
    solanaReady: true,
    circuitState: 'CLOSED',
    pendingReconcile: 0,
    manualReviewOpen: 0,
    manualReviewThreshold: 1,
    autoPauseOnManualReview: true,
    failedOps6h: 2,
    deploymentStage: 'canary',
    dryRun: true,
    autoScreeningEnabled: false,
    autonomyMode: 'paused',
    taeExitCount: 2,
    taeWinRatePct: 35,
    minTaeSamplesForFullStage: 10,
    minTaeWinRateForFullStage: 45,
  });

  assert.equal(result.ready, true);
  assert.equal(result.warnings.length >= 1, true);
  assert.equal(result.score <= 100, true);
});

test('deploy readiness blocks stage full when TAE sample is insufficient', () => {
  const result = evaluateDeployReadiness({
    solanaReady: true,
    circuitState: 'CLOSED',
    pendingReconcile: 0,
    manualReviewOpen: 0,
    manualReviewThreshold: 1,
    autoPauseOnManualReview: true,
    failedOps6h: 0,
    deploymentStage: 'canary',
    targetStage: 'full',
    dryRun: false,
    autoScreeningEnabled: true,
    taeExitCount: 3,
    taeWinRatePct: 80,
    minTaeSamplesForFullStage: 10,
    minTaeWinRateForFullStage: 45,
  });

  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /sample tae/i);
});

test('deploy readiness blocks stage full when TAE win rate is below threshold', () => {
  const result = evaluateDeployReadiness({
    solanaReady: true,
    circuitState: 'CLOSED',
    pendingReconcile: 0,
    manualReviewOpen: 0,
    manualReviewThreshold: 1,
    autoPauseOnManualReview: true,
    failedOps6h: 0,
    deploymentStage: 'canary',
    targetStage: 'full',
    dryRun: false,
    autoScreeningEnabled: true,
    taeExitCount: 20,
    taeWinRatePct: 32,
    minTaeSamplesForFullStage: 10,
    minTaeWinRateForFullStage: 45,
  });

  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /win rate tae/i);
});

test('deploy readiness blocks live deploy when worktree is dirty', () => {
  const result = evaluateDeployReadiness({
    solanaReady: true,
    circuitState: 'CLOSED',
    pendingReconcile: 0,
    manualReviewOpen: 0,
    manualReviewThreshold: 1,
    autoPauseOnManualReview: true,
    failedOps6h: 0,
    deploymentStage: 'canary',
    dryRun: false,
    autoScreeningEnabled: true,
    autonomyMode: 'active',
    taeExitCount: 20,
    taeWinRatePct: 60,
    minTaeSamplesForFullStage: 10,
    minTaeWinRateForFullStage: 45,
    worktreeClean: false,
    worktreeDirtyCount: 12,
    worktreeCheckAvailable: true,
  });

  assert.equal(result.ready, false);
  assert.match(result.blockers.join(' '), /worktree dirty/i);
});
