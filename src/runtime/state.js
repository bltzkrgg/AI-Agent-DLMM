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
