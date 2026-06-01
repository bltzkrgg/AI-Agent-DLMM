'use strict';

import { getConfig } from '../config.js';
import { getActivePositionKeys } from '../sniper/evilPanda.js';
import { flushRuntimeState, getRuntimeState, setRuntimeState } from '../runtime/state.js';

const SLOT_STATE_KEY = 'deploySlotReservations';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
let _reserveLock = false;

function nowMs() {
  return Date.now();
}

function readReservations() {
  const raw = getRuntimeState(SLOT_STATE_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

function writeReservations(rows) {
  setRuntimeState(SLOT_STATE_KEY, Array.isArray(rows) ? rows : []);
}

function normalizeRow(row = {}) {
  return {
    id: String(row.id || ''),
    owner: String(row.owner || 'unknown'),
    mint: String(row.mint || ''),
    symbol: String(row.symbol || ''),
    poolAddress: String(row.poolAddress || ''),
    source: String(row.source || 'unknown'),
    reservedAt: Number(row.reservedAt || nowMs()),
    expiresAt: Number(row.expiresAt || (nowMs() + DEFAULT_TTL_MS)),
  };
}

export function cleanupExpiredDeploySlots(now = nowMs()) {
  const rows = readReservations().map(normalizeRow);
  const fresh = rows.filter((row) => row.expiresAt > now);
  if (fresh.length !== rows.length) {
    writeReservations(fresh);
  }
  return { removed: rows.length - fresh.length, remaining: fresh.length };
}

export function getDeploySlotUsage() {
  const cfg = getConfig();
  const maxPositions = Math.max(1, Number(cfg.maxPositions || 1));
  const active = getActivePositionKeys().length;
  const reserved = cleanupExpiredDeploySlots().remaining;
  const available = Math.max(0, maxPositions - active - reserved);
  return { maxPositions, active, reserved, available };
}

export function canReserveDeploySlot(extra = {}) {
  const usage = getDeploySlotUsage();
  if (usage.available <= 0) {
    return { ok: false, reason: `Slot penuh: ${usage.active + usage.reserved}/${usage.maxPositions}` };
  }
  return reserveDeploySlot(extra);
}

export function reserveDeploySlot({ owner = 'unknown', mint = '', symbol = '', poolAddress = '', ttlMs = DEFAULT_TTL_MS, source = 'unknown' } = {}) {
  if (_reserveLock) {
    const usage = getDeploySlotUsage();
    return { ok: false, reason: `Slot reservation locked`, usage };
  }

  _reserveLock = true;
  try {
    const cfg = getConfig();
    const maxPositions = Math.max(1, Number(cfg.maxPositions || 1));
    const active = getActivePositionKeys().length;

    const current = readReservations().map(normalizeRow);
    const now = nowMs();
    const fresh = current.filter((row) => row.expiresAt > now);
    if (fresh.length !== current.length) {
      writeReservations(fresh);
    }

    const reserved = fresh.length;
    const available = Math.max(0, maxPositions - active - reserved);
    const usage = { maxPositions, active, reserved, available };
    if (available <= 0) {
      return { ok: false, reason: `Slot penuh: ${active + reserved}/${maxPositions}`, usage };
    }

    const id = `${owner}:${mint || symbol || poolAddress || 'slot'}:${now}:${Math.random().toString(36).slice(2, 8)}`;
    const nextRows = [...fresh, normalizeRow({
      id,
      owner,
      mint,
      symbol,
      poolAddress,
      source,
      reservedAt: now,
      expiresAt: now + Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS),
    })];
    writeReservations(nextRows);

    const usageAfter = {
      maxPositions,
      active,
      reserved: nextRows.length,
      available: Math.max(0, maxPositions - active - nextRows.length),
    };
    return { ok: true, id, usage: usageAfter };
  } finally {
    _reserveLock = false;
  }
}

export async function releaseDeploySlot(reservationId) {
  if (!reservationId) return { ok: false, reason: 'NO_RESERVATION_ID' };
  const rows = readReservations().map(normalizeRow);
  const next = rows.filter((row) => row.id !== reservationId);
  if (next.length !== rows.length) {
    writeReservations(next);
    await flushRuntimeState().catch(() => {});
  }
  return { ok: true, removed: rows.length - next.length, remaining: next.length };
}
