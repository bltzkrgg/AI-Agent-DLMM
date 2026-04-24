import { getConfig, getEntryCapacity } from '../config.js';
import { checkMaxDrawdown } from '../safety/safetyManager.js';
import { getActiveOperation, getOpenPositions, listPendingReconcileIssues } from '../db/database.js';
import { getConnection, getWallet } from '../solana/wallet.js';

function ensureRuntimeReady() {
  if (!getConnection() || !getWallet()) {
    throw new Error('Solana runtime belum siap. Wallet/RPC belum terinisialisasi.');
  }
}

function ensureNoDuplicateOperation(operationType, entityId) {
  const active = getActiveOperation(operationType, entityId);
  if (active) {
    throw new Error(`Operasi ${operationType} untuk ${entityId || 'entity ini'} masih berjalan.`);
  }
}

function ensureEntryCapacity(maxPositionsOverride = null) {
  const cfg = getConfig();
  const capacity = getEntryCapacity(cfg, maxPositionsOverride);
  if (capacity.blocked) {
    throw new Error(capacity.reason);
  }
  const maxPositions = capacity.maxPositions;
  const openPositions = getOpenPositions();
  if (openPositions.length >= maxPositions) {
    throw new Error(`Posisi sudah penuh (${openPositions.length}/${maxPositions}).`);
  }
  const pendingReconcile = listPendingReconcileIssues(1);
  if (pendingReconcile.length > 0) {
    throw new Error('Entry diblokir karena ada item manual_review/reconcile yang belum selesai.');
  }
}

// ── Aggressive Priority Fee Config ───────────────────────────────
// Returns microLamports + computeUnits tuned for high-congestion entry.
// urgent=true: peak volatility — bant gas habis supaya TX langsung landing.
// urgent=false: normal entry — still aggressive but cost-aware.
// Callers pass this into injectPriorityFee() or Jupiter swap params.

export function getAggressivePriorityConfig({ urgent = false, largeTx = false } = {}) {
  const cfg = getConfig();
  const baseline = urgent
    ? (cfg.urgentPriorityMicroLamports   ?? 2_000_000)
    : (cfg.normalPriorityMicroLamports   ?? 750_000);

  // Multiply by 1.5x on top of Helius recommended when the network is hot.
  // The actual multiplier is applied in meteora.js after fetching recommended fee;
  // here we set the floor so we never fall below it.
  return {
    microLamportsFloor: baseline,
    computeUnits:       largeTx ? 1_400_000 : urgent ? 1_200_000 : 800_000,
    heliusMultiplier:   urgent ? 1.5 : 1.2,
    maxRetries:         urgent ? 5 : 3,
  };
}

export function validateExecutionPolicy({
  operationType,
  entityId = null,
  requiresRuntime = true,
  blocksOnDrawdown = true,
  isEntryOperation = false,
  entryMaxPositions = null,
}) {
  if (requiresRuntime) ensureRuntimeReady();
  if (blocksOnDrawdown) {
    const drawdown = checkMaxDrawdown();
    if (drawdown.triggered) throw new Error(drawdown.reason);
  }
  ensureNoDuplicateOperation(operationType, entityId);
  if (isEntryOperation) ensureEntryCapacity(entryMaxPositions);
}
