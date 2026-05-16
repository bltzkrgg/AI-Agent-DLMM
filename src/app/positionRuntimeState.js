import {
  deleteRuntimeCollectionItem,
  getRuntimeCollectionItem,
  updateRuntimeCollectionItem,
} from '../runtime/state.js';

const POSITION_RUNTIME_KEY = 'position_runtime_state';

function normalizeRuntimeState(state = {}) {
  const poolImpactSamples = Array.isArray(state.poolImpactSamples)
    ? state.poolImpactSamples.slice(-20).map((sample) => ({
        activeBin: Number.isFinite(sample?.activeBin) ? sample.activeBin : null,
        price: Number.isFinite(sample?.price) ? sample.price : null,
        at: Number.isFinite(sample?.at) ? sample.at : Date.now(),
      })).filter(sample => sample.activeBin !== null || sample.price !== null)
    : [];
  return {
    peakPnlPct: Number.isFinite(state.peakPnlPct) ? state.peakPnlPct : null,
    trailingActive: state.trailingActive === true,
    oorSince: Number.isFinite(state.oorSince) ? state.oorSince : null,
    lastOorAlertAt: Number.isFinite(state.lastOorAlertAt) ? state.lastOorAlertAt : null,
    lastMarketSignal: state.lastMarketSignal || null,
    lastExitReason: state.lastExitReason || null,
    pendingSwap: state.pendingSwap === true,
    poolImpactSamples,
    lastPoolImpactAlertAt: Number.isFinite(state.lastPoolImpactAlertAt) ? state.lastPoolImpactAlertAt : null,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : Date.now(),
  };
}

export function getPositionRuntimeState(positionAddress) {
  return normalizeRuntimeState(getRuntimeCollectionItem(POSITION_RUNTIME_KEY, positionAddress, {}));
}

export function updatePositionRuntimeState(positionAddress, patch = {}) {
  return updateRuntimeCollectionItem(POSITION_RUNTIME_KEY, positionAddress, (current) => ({
    ...normalizeRuntimeState(current || {}),
    ...patch,
    updatedAt: Date.now(),
  }));
}

export function clearPositionRuntimeState(positionAddress) {
  deleteRuntimeCollectionItem(POSITION_RUNTIME_KEY, positionAddress);
}
