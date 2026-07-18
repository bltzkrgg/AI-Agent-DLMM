import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  deleteRuntimeCollectionItem,
  deleteRuntimeState,
  getRuntimeCollection,
  getRuntimeCollectionItem,
  updateRuntimeCollectionItem,
} from '../runtime/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAPER_POSITIONS_RUNTIME_KEY = 'paper_open_positions';

function getPaperLedgerPath() {
  return process.env.PAPER_POSITION_LEDGER_PATH ||
    join(__dirname, '../../paper-position-ledger.jsonl');
}

function nowIso() {
  return new Date().toISOString();
}

function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function createPaperPositionId(poolAddress) {
  const pool = String(poolAddress || 'unknown');
  const suffix = Math.random().toString(36).slice(2, 8) || '000000';
  return `paper:${pool}:${Date.now()}:${suffix}`;
}

function normalizeOpenRecord(metadata = {}) {
  const openedAt = metadata.openedAt || metadata.deployedAt || nowIso();
  const deploySol = finiteOr(metadata.deploySol ?? metadata.capitalInSol, 0);
  const currentValueSol = finiteOr(metadata.currentValueSol, deploySol);
  const pnlSol = finiteOr(metadata.pnlSol ?? metadata.pnlTotalSol, currentValueSol - deploySol);
  const pnlPct = finiteOr(
    metadata.pnlPct ?? metadata.pnlTotalPct,
    deploySol > 0 ? (pnlSol / deploySol) * 100 : 0
  );
  const rangeMin = finiteOr(metadata.rangeMin, null);
  const rangeMax = finiteOr(metadata.rangeMax, null);

  return {
    ...metadata,
    id: String(metadata.id || createPaperPositionId(metadata.poolAddress)),
    executionMode: 'paper',
    lifecycle: 'open',
    lifecycleState: 'open',
    lifecycle_state: 'open',
    poolAddress: String(metadata.poolAddress || ''),
    openedAt,
    deployedAt: metadata.deployedAt || openedAt,
    createdAt: metadata.createdAt || openedAt,
    updatedAt: metadata.updatedAt || openedAt,
    closedAt: null,
    closeReason: null,
    entryMetadata: metadata.entryMetadata && typeof metadata.entryMetadata === 'object'
      ? metadata.entryMetadata
      : {},
    entryActiveBin: finiteOr(metadata.entryActiveBin, null),
    entryPrice: finiteOr(metadata.entryPrice, null),
    entrySnapshotAt: metadata.entrySnapshotAt || openedAt,
    deploySol,
    capitalInSol: finiteOr(metadata.capitalInSol, deploySol),
    hwmPct: finiteOr(metadata.hwmPct, pnlPct),
    mfePct: finiteOr(metadata.mfePct, Math.max(0, pnlPct)),
    maePct: finiteOr(metadata.maePct, Math.min(0, pnlPct)),
    currentValueSol,
    pnlSol,
    pnlPct,
    pnlTotalSol: finiteOr(metadata.pnlTotalSol, pnlSol),
    pnlTotalPct: finiteOr(metadata.pnlTotalPct, pnlPct),
    feePnlSol: finiteOr(metadata.feePnlSol, 0),
    feePnlPct: finiteOr(metadata.feePnlPct, 0),
    pricePnlSol: finiteOr(metadata.pricePnlSol, pnlSol),
    rangeMin,
    rangeMax,
    rangeWidthBins: finiteOr(
      metadata.rangeWidthBins,
      rangeMin !== null && rangeMax !== null ? rangeMax - rangeMin + 1 : null
    ),
    activeBinId: finiteOr(metadata.activeBinId, metadata.entryActiveBin ?? null),
    activePrice: finiteOr(metadata.activePrice, metadata.entryPrice ?? null),
    inRange: typeof metadata.inRange === 'boolean' ? metadata.inRange : null,
    rangeChecks: finiteOr(metadata.rangeChecks, 0),
    inRangeChecks: finiteOr(metadata.inRangeChecks, 0),
    outOfRangeChecks: finiteOr(metadata.outOfRangeChecks, 0),
    inRangePct: finiteOr(metadata.inRangePct, null),
    inRangeSince: metadata.inRangeSince ?? null,
    inRangeMs: finiteOr(metadata.inRangeMs, 0),
    oorSince: metadata.oorSince ?? null,
    oorState: metadata.oorState ?? null,
    oorMs: finiteOr(metadata.oorMs, 0),
    outOfRangeMs: finiteOr(metadata.outOfRangeMs, 0),
    outOfRangeSide: metadata.outOfRangeSide ?? null,
    outOfRangeBins: finiteOr(metadata.outOfRangeBins, 0),
    lastOorAt: metadata.lastOorAt ?? null,
    lastOorAlertAt: metadata.lastOorAlertAt ?? null,
  };
}

export function createPaperPosition(metadata = {}) {
  const record = normalizeOpenRecord(metadata);
  return updateRuntimeCollectionItem(PAPER_POSITIONS_RUNTIME_KEY, record.id, record);
}

export function updatePaperPosition(id, patch = {}) {
  const positionId = String(id || '');
  if (!positionId) return null;

  return updateRuntimeCollectionItem(PAPER_POSITIONS_RUNTIME_KEY, positionId, (current) => {
    if (!current) return null;

    const nextCurrentValueSol = finiteOr(patch.currentValueSol, current.currentValueSol);
    const nextPnlSol = finiteOr(
      patch.pnlSol ?? patch.pnlTotalSol,
      nextCurrentValueSol - finiteOr(current.deploySol, 0)
    );
    const nextPnlPct = finiteOr(patch.pnlPct ?? patch.pnlTotalPct, current.pnlPct);
    return {
      ...current,
      ...patch,
      id: current.id,
      poolAddress: current.poolAddress,
      executionMode: 'paper',
      lifecycle: 'open',
      lifecycleState: 'open',
      lifecycle_state: 'open',
      currentValueSol: nextCurrentValueSol,
      pnlSol: nextPnlSol,
      pnlPct: nextPnlPct,
      pnlTotalSol: finiteOr(patch.pnlTotalSol, nextPnlSol),
      pnlTotalPct: finiteOr(patch.pnlTotalPct, nextPnlPct),
      hwmPct: Math.max(finiteOr(current.hwmPct, 0), finiteOr(patch.hwmPct, nextPnlPct)),
      mfePct: Math.max(finiteOr(current.mfePct, 0), finiteOr(patch.mfePct, nextPnlPct)),
      maePct: Math.min(finiteOr(current.maePct, 0), finiteOr(patch.maePct, nextPnlPct)),
      updatedAt: nowIso(),
      closedAt: null,
      closeReason: null,
    };
  });
}

export function closePaperPosition(id, finalPatch = {}) {
  const current = updatePaperPosition(id, finalPatch);
  if (!current) return null;

  const closedAt = finalPatch.closedAt || nowIso();
  const closed = {
    ...current,
    ...finalPatch,
    id: current.id,
    poolAddress: current.poolAddress,
    executionMode: 'paper',
    lifecycle: 'closed',
    lifecycleState: 'closed',
    lifecycle_state: 'closed',
    updatedAt: closedAt,
    closedAt,
    closeReason: finalPatch.closeReason || finalPatch.reason || 'PAPER_CLOSE',
  };

  appendFileSync(getPaperLedgerPath(), `${JSON.stringify(closed)}\n`, 'utf8');
  deleteRuntimeCollectionItem(PAPER_POSITIONS_RUNTIME_KEY, current.id);
  return closed;
}

export function getPaperPosition(id) {
  return getRuntimeCollectionItem(PAPER_POSITIONS_RUNTIME_KEY, String(id || ''), null);
}

export function listPaperPositions() {
  return Object.values(getRuntimeCollection(PAPER_POSITIONS_RUNTIME_KEY));
}

export function getPaperPositionCount() {
  return listPaperPositions().length;
}

export function hasPaperPoolPosition(poolAddress) {
  const pool = String(poolAddress || '');
  return pool !== '' && listPaperPositions().some(position => position.poolAddress === pool);
}

export function resetPaperPositionsForTests() {
  deleteRuntimeState(PAPER_POSITIONS_RUNTIME_KEY);
}
