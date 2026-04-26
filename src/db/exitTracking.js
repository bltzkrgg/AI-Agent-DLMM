/**
 * src/db/exitTracking.js — Stub (Linear Sniper RPC-First)
 *
 * Exit tracking tidak membutuhkan persistensi di arsitektur stateless.
 * Semua exports di-forward ke database.js in-memory.
 */

'use strict';

export { recordExitEvent, recordCircuitBreakerEvent } from './database.js';
