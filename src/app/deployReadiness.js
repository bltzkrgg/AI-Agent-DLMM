export function evaluateDeployReadiness(input = {}) {
  const {
    solanaReady = true,
    circuitState = 'CLOSED',
    pendingReconcile = 0,
    manualReviewOpen = 0,
    manualReviewThreshold = 1,
    autoPauseOnManualReview = true,
    failedOps6h = 0,
    deploymentStage = 'full',
    targetStage = null,
    dryRun = false,
    autoScreeningEnabled = false,
    autonomyMode = 'active',
    taeExitCount = 0,
    taeWinRatePct = null,
    minTaeSamplesForFullStage = 10,
    minTaeWinRateForFullStage = 45,
    worktreeClean = true,
    worktreeDirtyCount = 0,
    worktreeCheckAvailable = true,
    signalReportRequired = false,
    signalReportAvailable = false,
    signalReportPassed = false,
    signalReportAgeHours = null,
    signalReportMaxAgeHours = 24,
  } = input;

  const blockers = [];
  const warnings = [];
  const stageForGate = String(targetStage || deploymentStage || 'full').toLowerCase();
  let score = 100;

  if (!solanaReady) {
    blockers.push('Wallet/RPC belum siap.');
    score -= 35;
  }

  if (String(circuitState).toUpperCase() !== 'CLOSED') {
    blockers.push(`Circuit Breaker state=${circuitState}.`);
    score -= 25;
  }

  if (pendingReconcile > 0) {
    blockers.push(`Pending reconcile masih ada (${pendingReconcile}).`);
    score -= 20;
  }

  if (autoPauseOnManualReview && manualReviewOpen >= manualReviewThreshold) {
    blockers.push(`manual_review terbuka (${manualReviewOpen}) mencapai ambang ${manualReviewThreshold}.`);
    score -= 15;
  }

  if (failedOps6h >= 10) {
    blockers.push(`Failed operation 6 jam terakhir tinggi (${failedOps6h}).`);
    score -= 20;
  } else if (failedOps6h >= 3) {
    warnings.push(`Failed operation 6 jam terakhir meningkat (${failedOps6h}).`);
    score -= 8;
  }

  if (deploymentStage === 'shadow') {
    warnings.push('Stage SHADOW aktif (entry live diblokir).');
    score -= 5;
  }

  if (dryRun) {
    warnings.push('Mode DRY RUN aktif.');
    score -= 5;
  }

  if (!autoScreeningEnabled) {
    warnings.push('Auto-screening sedang OFF.');
  }

  if (String(autonomyMode).toLowerCase() === 'paused') {
    warnings.push('Autonomy mode PAUSED (loop otonom dihentikan sementara).');
    score -= 5;
  }

  if (!worktreeCheckAvailable) {
    warnings.push('Git worktree check tidak tersedia (deploy hygiene tidak terverifikasi).');
    score -= 2;
  }

  if (!worktreeClean) {
    const msg = `Worktree dirty (${worktreeDirtyCount} perubahan belum di-commit).`;
    if (!dryRun) {
      blockers.push(`${msg} Commit/stash dulu sebelum live deploy.`);
      score -= 20;
    } else {
      warnings.push(msg);
      score -= 5;
    }
  }

  if (!dryRun && signalReportRequired) {
    if (!signalReportAvailable) {
      blockers.push('Rapor akurasi sinyal belum tersedia.');
      score -= 15;
    } else {
      if (signalReportPassed !== true) {
        blockers.push('Rapor akurasi sinyal belum lolos threshold.');
        score -= 12;
      }
      if (!Number.isFinite(signalReportAgeHours) || signalReportAgeHours > signalReportMaxAgeHours) {
        blockers.push(`Rapor akurasi sinyal stale (> ${signalReportMaxAgeHours} jam).`);
        score -= 10;
      }
    }
  } else if (signalReportAvailable && signalReportPassed !== true) {
    warnings.push('Rapor akurasi sinyal belum lolos. Jalankan mode konservatif.');
    score -= 4;
  }

  if (!dryRun && stageForGate === 'full') {
    if (taeExitCount < minTaeSamplesForFullStage) {
      blockers.push(`Sample TAE belum cukup (${taeExitCount}/${minTaeSamplesForFullStage}) untuk stage full.`);
      score -= 12;
    } else if (Number.isFinite(taeWinRatePct) && taeWinRatePct < minTaeWinRateForFullStage) {
      blockers.push(`Win rate TAE ${taeWinRatePct.toFixed(1)}% < batas ${minTaeWinRateForFullStage}% untuk stage full.`);
      score -= 10;
    }
  } else if (taeExitCount > 0 && Number.isFinite(taeWinRatePct) && taeWinRatePct < minTaeWinRateForFullStage) {
    warnings.push(`Win rate TAE rendah (${taeWinRatePct.toFixed(1)}%). Pertimbangkan tuning sebelum scale-up.`);
    score -= 4;
  }

  if (score < 0) score = 0;

  return {
    ready: blockers.length === 0,
    score,
    blockers,
    warnings,
  };
}
