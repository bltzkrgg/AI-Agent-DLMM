import { getConfig } from '../config.js';
import { checkMaxDrawdown } from '../safety/safetyManager.js';
import { getActiveOperation, getOpenPositions, listPendingReconcileIssues } from '../db/database.js';
import { getConnection, getWallet } from '../solana/wallet.js';

function ensureRuntimeReady() {
  if (!getConnection() || !getWallet()) {
    throw new Error('Solana runtime belum siap. Wallet/RPC belum terinisialisasi.');
  }
}

function ensureNoDuplicateOperation(operationType, entityId) {
  const active = operationType === 'OPEN_POSITION'
    ? getActiveOperation(operationType)
    : getActiveOperation(operationType, entityId);
  if (active) {
    throw new Error(`Operasi ${operationType} untuk ${entityId || 'entity ini'} masih berjalan.`);
  }
}

function ensureEntryCapacity() {
  const cfg = getConfig();
  const openPositions = getOpenPositions();
  if (openPositions.length >= cfg.maxPositions) {
    throw new Error(`Posisi sudah penuh (${openPositions.length}/${cfg.maxPositions}).`);
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
}) {
  if (requiresRuntime) ensureRuntimeReady();
  if (blocksOnDrawdown) {
    const drawdown = checkMaxDrawdown();
    if (drawdown.triggered) throw new Error(drawdown.reason);
  }
  ensureNoDuplicateOperation(operationType, entityId);
  if (isEntryOperation) ensureEntryCapacity();
}
