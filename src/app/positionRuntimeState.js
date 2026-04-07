import {
  deleteRuntimeCollectionItem,
  getRuntimeCollectionItem,
  updateRuntimeCollectionItem,
} from '../runtime/state.js';

const POSITION_RUNTIME_KEY = 'position_runtime_state';

function normalizeRuntimeState(state = {}) {
  return {
    peakPnlPct: Number.isFinite(state.peakPnlPct) ? state.peakPnlPct : null,
    trailingActive: state.trailingActive === true,
    oorSince: Number.isFinite(state.oorSince) ? state.oorSince : null,
    lastOorAlertAt: Number.isFinite(state.lastOorAlertAt) ? state.lastOorAlertAt : null,
    lastMarketSignal: state.lastMarketSignal || null,
    lastExitReason: state.lastExitReason || null,
    pendingSwap: state.pendingSwap === true,
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
