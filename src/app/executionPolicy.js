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
