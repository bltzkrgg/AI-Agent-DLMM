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
  const cfg = getConfig();
  if (name === 'Wave Enjoyer') {
    const base = {
      name: 'Wave Enjoyer',
      deploy: { fixedBinsBelow: 24 },
      exit: { holdMinMinutes: 10, holdMaxMinutes: 20 },
    };
    const ov = (cfg.strategyOverrides && cfg.strategyOverrides['Wave Enjoyer']) || {};
    return {
      ...base,
      ...ov,
      deploy: { ...base.deploy, ...(ov.deploy || {}) },
      exit: { ...base.exit, ...(ov.exit || {}) },
    };
  }
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
  const base = getStrategy('Evil Panda');
  const strategy = (!input || typeof input !== 'object') ? base : { ...base, ...input };
  const deploy = strategy.deploy || strategy.parameters || {};

  let priceRangePercent = 94;
  if (Number.isFinite(Number(deploy.entryPriceOffsetMin)) && Number.isFinite(Number(deploy.entryPriceOffsetMax))) {
    priceRangePercent = Math.max(0, Number(deploy.entryPriceOffsetMax) - Number(deploy.entryPriceOffsetMin));
  }

  const strategyType = Number.isFinite(Number(deploy.strategyType))
    ? Number(deploy.strategyType)
    : ((strategy.type === 'single_side_y' || strategy.name === 'Evil Panda') ? 2 : 0);

  return {
    ...strategy,
    priceRangePercent,
    strategyType,
    tokenXWeight: strategyType === 2 ? 0 : 50,
    tokenYWeight: strategyType === 2 ? 100 : 50,
  };
}
