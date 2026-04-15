import { existsSync, readFileSync, promises as fs, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from '../utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.BOT_RUNTIME_STATE_PATH || join(__dirname, '../../runtime-state.json');

// ─── In-memory state singleton ────────────────────────────────────
let _cachedState = null;
let _isPersisting = false;
let _needsPersist = false;
let _persistTimeout = null;

function loadStateSync() {
  if (_cachedState !== null) return _cachedState;
  if (!existsSync(STATE_PATH)) {
    _cachedState = {};
    return _cachedState;
  }
  try {
    _cachedState = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`[state] Failed to parse state file, starting fresh: ${e.message}`);
    _cachedState = {};
  }
  return _cachedState;
}

// ─── Throttled Persistence ────────────────────────────────────────
// Persists state to disk asynchronously, throttled to 500ms.
async function persistState() {
  if (_isPersisting) {
    _needsPersist = true;
    return;
  }

  _isPersisting = true;
  _needsPersist = false;

  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    const data = stringify(_cachedState, 2);
    await fs.writeFile(tmpPath, data, 'utf-8');
    // Atomic swap
    renameSync(tmpPath, STATE_PATH);
  } catch (e) {
    console.error(`[state] Failed to persist state to disk: ${e.message}`);
  } finally {
    _isPersisting = false;
    if (_needsPersist) {
      // If another update happened while we were writing, write again
      triggerPersist();
    }
  }
}

function triggerPersist() {
  if (_persistTimeout) clearTimeout(_persistTimeout);
  _persistTimeout = setTimeout(persistState, 500);
}

// ─── Public API ───────────────────────────────────────────────────

export function getRuntimeState(key, fallback = null) {
  const state = loadStateSync();
  return key in state ? state[key] : fallback;
}

export function setRuntimeState(key, value) {
  const state = loadStateSync();
  state[key] = value;
  triggerPersist();
  return value;
}

export function deleteRuntimeState(key) {
  const state = loadStateSync();
  delete state[key];
  triggerPersist();
}

export function getRuntimeCollection(key) {
  const value = getRuntimeState(key, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function setRuntimeCollection(key, value) {
  const safeValue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return setRuntimeState(key, safeValue);
}

export function getRuntimeCollectionItem(key, itemKey, fallback = null) {
  const collection = getRuntimeCollection(key);
  return itemKey in collection ? collection[itemKey] : fallback;
}

export function updateRuntimeCollectionItem(key, itemKey, updater) {
  const state = loadStateSync();
  const collection = state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])
    ? state[key]
    : {};

  const currentValue = itemKey in collection ? collection[itemKey] : null;
  const nextValue = typeof updater === 'function' ? updater(currentValue) : updater;

  if (nextValue == null) {
    delete collection[itemKey];
  } else {
    collection[itemKey] = nextValue;
  }

  state[key] = collection;
  triggerPersist();
  return nextValue;
}

export function deleteRuntimeCollectionItem(key, itemKey) {
  const state = loadStateSync();
  const collection = state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])
    ? state[key]
    : {};

  delete collection[itemKey];
  state[key] = collection;
  triggerPersist();
}
