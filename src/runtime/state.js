import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.BOT_RUNTIME_STATE_PATH || join(__dirname, '../../runtime-state.json');

function readStateFile() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStateFile(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function getRuntimeState(key, fallback = null) {
  const state = readStateFile();
  return key in state ? state[key] : fallback;
}

export function setRuntimeState(key, value) {
  const state = readStateFile();
  state[key] = value;
  writeStateFile(state);
  return value;
}

export function deleteRuntimeState(key) {
  const state = readStateFile();
  delete state[key];
  writeStateFile(state);
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
  const collection = getRuntimeCollection(key);
  const currentValue = itemKey in collection ? collection[itemKey] : null;
  const nextValue = typeof updater === 'function' ? updater(currentValue) : updater;

  if (nextValue == null) {
    delete collection[itemKey];
  } else {
    collection[itemKey] = nextValue;
  }

  setRuntimeCollection(key, collection);
  return nextValue;
}

export function deleteRuntimeCollectionItem(key, itemKey) {
  const collection = getRuntimeCollection(key);
  delete collection[itemKey];
  setRuntimeCollection(key, collection);
}
