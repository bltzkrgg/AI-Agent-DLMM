/**
 * src/strategies/strategyManager.js — Stub (Linear Sniper RPC-First)
 *
 * Strategy manager disederhanakan. Di arsitektur Linear Sniper,
 * hanya ada satu strategi aktif: "Evil Panda" (deep-range DLMM).
 * Tidak ada dynamic strategy loading dari library.
 */

'use strict';

import { getConfig } from '../config.js';

const EVIL_PANDA = {
  name: 'Evil Panda',
  displayName: 'Evil Panda (Deep Range)',
  description: 'Deep-range DLMM liquidity provisioning — 90%+ price range coverage',
  allowedBinSteps: [100, 125],
  deploy: {
    priceRangePct: 90,
    binStep: 100,
  },
  exit: {
    maxHoldHours: 72,
    takeProfitPct: 15,
    stopLossPct: 10,
  },
};

/** Ambil strategi berdasarkan nama — selalu return Evil Panda */
export function getStrategy(name) {
  void name;
  const cfg = getConfig();
  return {
    ...EVIL_PANDA,
    deploy: {
      ...EVIL_PANDA.deploy,
      priceRangePct: cfg.targetRangePct || 90,
      binStep: cfg.minBinStep || 100,
    },
    exit: {
      ...EVIL_PANDA.exit,
      maxHoldHours: cfg.maxHoldHours || 72,
      stopLossPct: cfg.stopLossPct || 10,
    },
  };
}

/** Alias untuk backward compat dengan claude.js */
export function getStrategyByName(name) {
  return getStrategy(name);
}

/** List semua strategi — hanya Evil Panda */
export function getAllStrategies() {
  return [getStrategy('Evil Panda')];
}

/** Parse strategy parameters dari string atau object */
export function parseStrategyParameters(input) {
  if (!input) return getStrategy('Evil Panda');
  if (typeof input === 'object') return { ...getStrategy('Evil Panda'), ...input };
  return getStrategy('Evil Panda');
}
