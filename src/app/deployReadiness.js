'use strict';

export function evaluateDeployReadiness(input = {}) {
  const blockers = [];
  const warnings = [];
  let score = 100;

  const {
    solanaReady = true,
    circuitState = 'CLOSED',
    pendingReconcile = 0,
    manualReviewOpen = 0,
    manualReviewThreshold = 1,
    autoPauseOnManualReview = true,
    failedOps6h = 0,
    deploymentStage = 'canary',
    targetStage = deploymentStage,
    dryRun = true,
    autoScreeningEnabled = false,
    autonomyMode = 'active',
    taeExitCount = 0,
    taeWinRatePct = 0,
    minTaeSamplesForFullStage = 10,
    minTaeWinRateForFullStage = 45,
    worktreeCheckAvailable = false,
    worktreeClean = true,
    worktreeDirtyCount = 0,
    signalReportRequired = false,
    signalReportAvailable = true,
    signalReportPassed = true,
    signalReportAgeHours = 0,
    signalReportMaxAgeHours = 24,
  } = input;

  if (!solanaReady) { blockers.push('Solana belum siap'); score -= 20; }
  if (String(circuitState).toUpperCase() !== 'CLOSED') { blockers.push('Circuit breaker OPEN'); score -= 20; }
  if (Number(pendingReconcile) > 0) { blockers.push('Pending reconcile masih ada'); score -= 10; }
  if (autoPauseOnManualReview && Number(manualReviewOpen) >= Number(manualReviewThreshold || 1)) {
    blockers.push('Manual review melebihi threshold'); score -= 10;
  }
  if (Number(failedOps6h) >= 10) { blockers.push('Failed ops 6h terlalu tinggi'); score -= 10; }

  if (!dryRun && !autoScreeningEnabled) {
    blockers.push('Auto-screening harus aktif untuk live'); score -= 10;
  }
  if (!dryRun && String(autonomyMode).toLowerCase() === 'paused') {
    warnings.push('Autonomy mode masih paused'); score -= 5;
  }

  if ((targetStage === 'full' || deploymentStage === 'full') && Number(taeExitCount) < Number(minTaeSamplesForFullStage || 10)) {
    blockers.push('Sample TAE belum cukup untuk full stage'); score -= 15;
  }
  if ((targetStage === 'full' || deploymentStage === 'full') && Number(taeWinRatePct) < Number(minTaeWinRateForFullStage || 45)) {
    blockers.push('Win rate TAE di bawah ambang'); score -= 15;
  }

  if (!dryRun && worktreeCheckAvailable && !worktreeClean) {
    blockers.push(`Worktree dirty (${Number(worktreeDirtyCount) || 0} file)`); score -= 15;
  }

  if (!dryRun && signalReportRequired) {
    if (!signalReportAvailable) {
      blockers.push('Rapor akurasi sinyal belum tersedia');
      score -= 10;
    }
    if (!signalReportPassed) {
      blockers.push('Rapor akurasi sinyal belum lolos threshold');
      score -= 10;
    }
    if (Number(signalReportAgeHours) > Number(signalReportMaxAgeHours || 24)) {
      blockers.push('Signal report stale');
      score -= 10;
    }
  }

  if (dryRun) warnings.push('Mode dry-run aktif');
  if (!autoScreeningEnabled) warnings.push('Auto-screening nonaktif');
  if (Number(failedOps6h) > 0 && Number(failedOps6h) < 10) warnings.push('Ada failed ops minor 6h');

  score = Math.max(0, Math.min(100, score));
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    score,
  };
}

