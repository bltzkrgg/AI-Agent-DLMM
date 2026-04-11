import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getClosedPositions } from '../db/database.js';
import { BASE_STRATEGY_PROFILES, STRATEGY_NAMES } from './profileDefaults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTIVE_PATH = process.env.BOT_ADAPTIVE_STRATEGY_PATH || join(__dirname, '../../strategy-adaptive.json');

const DEFAULT_STATE = {
  updatedAt: null,
  strategies: {},
};

const MIN_SAMPLES = 3;
const MAX_RELATIVE_SHIFT = 0.2;

function loadState() {
  if (!existsSync(ADAPTIVE_PATH)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(ADAPTIVE_PATH, 'utf-8'));
    return {
      ...DEFAULT_STATE,
      ...raw,
      strategies: raw?.strategies && typeof raw.strategies === 'object' ? raw.strategies : {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  writeFileSync(ADAPTIVE_PATH, JSON.stringify(state, null, 2));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nudge(current, target, maxRelativeShift = MAX_RELATIVE_SHIFT) {
  if (!isFiniteNumber(current)) return target;
  if (!isFiniteNumber(target)) return current;
  const maxDelta = Math.abs(current) * maxRelativeShift;
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

function roundTo(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getHoldMinutes(position) {
  const createdAt = Date.parse(position.created_at || '');
  const closedAt = Date.parse(position.closed_at || '');
  if (!Number.isFinite(createdAt) || !Number.isFinite(closedAt) || closedAt <= createdAt) return null;
  return Math.max(0, (closedAt - createdAt) / 60000);
}

function normalizeReason(reason = '') {
  return String(reason).toLowerCase();
}

function isOorClose(position) {
  const reason = normalizeReason(position.close_reason);
  return reason.includes('out_of_range') || reason.includes('oor') || reason.includes('range');
}

function getStrategyRows(rows, strategyName) {
  return rows.filter((row) => row.strategy_used === strategyName);
}

function average(values = []) {
  const nums = values.filter(isFiniteNumber);
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function median(values = []) {
  const nums = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function summarizeStrategy(rows, baseProfile) {
  const sample = rows.length;
  if (sample === 0) {
    return {
      count: 0,
      winRate: 0,
      avgPnlPct: 0,
      avgHoldMinutes: null,
      avgRangeEfficiencyPct: null,
      oorRate: 0,
      winners: 0,
      losses: 0,
      avgWinPct: null,
      avgLossPct: null,
    };
  }

  const pnlValues = rows.map((row) => Number(row.pnl_pct || 0));
  const holdValues = rows.map((row) => getHoldMinutes(row));
  const rangeEffValues = rows.map((row) => Number(row.range_efficiency_pct || 0));
  const winners = rows.filter((row) => (row.pnl_pct || 0) > 0);
  const losses = rows.filter((row) => (row.pnl_pct || 0) < 0);
  const oorClosures = rows.filter((row) => isOorClose(row) || (Number(row.range_efficiency_pct || 0) > 0 && Number(row.range_efficiency_pct || 0) < 35));

  return {
    count: sample,
    winRate: (winners.length / sample) * 100,
    avgPnlPct: average(pnlValues) || 0,
    avgHoldMinutes: average(holdValues),
    medianHoldMinutes: median(holdValues),
    avgRangeEfficiencyPct: average(rangeEffValues.filter((n) => n > 0)),
    oorRate: (oorClosures.length / sample) * 100,
    winners: winners.length,
    losses: losses.length,
    avgWinPct: average(winners.map((row) => Number(row.pnl_pct || 0))),
    avgLossPct: average(losses.map((row) => Math.abs(Number(row.pnl_pct || 0)))),
    baseProfile,
  };
}

function buildWavePatch(summary, baseProfile) {
  const entry = {};
  const exit = {};
  const reasons = [];
  const supportBase = baseProfile.entry?.supportDistancePctMax ?? 8;
  const volumeBase = baseProfile.entry?.minVolume5mUsd ?? 100000;
  const holdBase = baseProfile.exit?.holdMaxMinutes ?? 20;
  const tpBase = baseProfile.exit?.takeProfitPct ?? 2.5;

  const weak = summary.winRate < 50 || summary.oorRate >= 35 || (summary.avgRangeEfficiencyPct != null && summary.avgRangeEfficiencyPct < 55);
  const strong = summary.winRate >= 65 && summary.oorRate < 20 && (summary.avgRangeEfficiencyPct == null || summary.avgRangeEfficiencyPct >= 70);

  if (weak) {
    entry.supportDistancePctMax = roundTo(clamp(nudge(supportBase, supportBase * 0.9), 4, supportBase), 1);
    entry.minVolume5mUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 1.15), 60000, 250000));
    exit.holdMaxMinutes = Math.round(clamp(nudge(holdBase, holdBase * 0.85), 8, 30));
    exit.takeProfitPct = roundTo(clamp(nudge(tpBase, tpBase * 0.95), 1.5, 4), 1);
    reasons.push('win rate / range efficiency lemah, entry diperketat dan hold dipendekkan');
  } else if (strong) {
    entry.supportDistancePctMax = roundTo(clamp(nudge(supportBase, supportBase * 1.05), 6, 10), 1);
    entry.minVolume5mUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 0.92), 60000, 250000));
    exit.holdMaxMinutes = Math.round(clamp(nudge(holdBase, holdBase * 1.1), 10, 30));
    exit.takeProfitPct = roundTo(clamp(nudge(tpBase, tpBase * 1.05), 1.5, 4), 1);
    reasons.push('performa kuat, range dan hold sedikit dilonggarkan');
  }

  if (summary.avgHoldMinutes != null && summary.avgHoldMinutes > holdBase) {
    exit.holdMaxMinutes = Math.min(exit.holdMaxMinutes || holdBase, Math.max(10, Math.round(summary.avgHoldMinutes * 1.15)));
    reasons.push('rata-rata hold lebih lama dari batas, holdMax diselaraskan');
  }

  if (summary.oorRate >= 40) {
    exit.emergencyStopLossPct = roundTo(clamp(nudge(baseProfile.exit?.emergencyStopLossPct ?? 4, (baseProfile.exit?.emergencyStopLossPct ?? 4) * 0.9), 2.5, 6), 1);
    reasons.push('OOR rate tinggi, emergency SL dipersempit');
  }

  return {
    patch: {
      entry,
      exit,
    },
    reasons,
  };
}

function buildNpcPatch(summary, baseProfile) {
  const entry = {};
  const exit = {};
  const reasons = [];
  const volumeBase = baseProfile.entry?.minVolume5mUsd ?? 50000;
  const holdBase = baseProfile.exit?.holdMaxMinutes ?? 360;
  const tpBase = baseProfile.exit?.takeProfitPct ?? 4;

  const weak = summary.winRate < 45 || summary.oorRate >= 35 || (summary.avgRangeEfficiencyPct != null && summary.avgRangeEfficiencyPct < 50);
  const strong = summary.winRate >= 65 && summary.oorRate < 20 && (summary.avgRangeEfficiencyPct == null || summary.avgRangeEfficiencyPct >= 65);

  if (weak) {
    entry.minVolume5mUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 1.15), 40000, 120000));
    exit.holdMaxMinutes = Math.round(clamp(nudge(holdBase, holdBase * 0.85), 90, 360));
    exit.takeProfitPct = roundTo(clamp(nudge(tpBase, tpBase * 0.9), 2.5, 6), 1);
    reasons.push('setup NPC lemah, volume threshold dinaikkan dan hold dipendekkan');
  } else if (strong) {
    entry.minVolume5mUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 0.95), 40000, 120000));
    exit.holdMaxMinutes = Math.round(clamp(nudge(holdBase, holdBase * 1.1), 180, 480));
    exit.takeProfitPct = roundTo(clamp(nudge(tpBase, tpBase * 1.05), 2.5, 6), 1);
    reasons.push('NPC performa bagus, hold window sedikit diperluas');
  }

  if (summary.avgWinPct != null) {
    const targetTP = clamp(summary.avgWinPct * 0.8, 2.5, 6);
    exit.takeProfitPct = roundTo(nudge(exit.takeProfitPct ?? tpBase, targetTP), 1);
    reasons.push('take profit diselaraskan dengan rata-rata winner');
  }

  if (summary.avgLossPct != null && summary.avgLossPct > (baseProfile.exit?.emergencyStopLossPct ?? 5) * 1.1) {
    exit.emergencyStopLossPct = roundTo(clamp(nudge(baseProfile.exit?.emergencyStopLossPct ?? 5, (baseProfile.exit?.emergencyStopLossPct ?? 5) * 0.9), 3, 8), 1);
    reasons.push('loss rata-rata besar, emergency SL diperketat');
  }

  return { patch: { entry, exit }, reasons };
}

function buildEvilPandaPatch(summary, baseProfile) {
  const entry = {};
  const exit = {};
  const reasons = [];
  const volumeBase = baseProfile.entry?.minVolume24hUsd ?? 1000000;
  const stopBase = baseProfile.exit?.emergencyStopLossPct ?? 8;

  const weak = summary.winRate < 50 || summary.oorRate >= 35 || (summary.avgRangeEfficiencyPct != null && summary.avgRangeEfficiencyPct < 55);
  const strong = summary.winRate >= 70 && summary.oorRate < 20 && (summary.avgRangeEfficiencyPct == null || summary.avgRangeEfficiencyPct >= 70);

  if (weak) {
    entry.minVolume24hUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 1.15), 750000, 3000000));
    exit.emergencyStopLossPct = roundTo(clamp(nudge(stopBase, stopBase * 0.9), 4, 10), 1);
    reasons.push('Evil Panda lemah, volume 24h dinaikkan dan emergency SL dipersempit');
  } else if (strong) {
    entry.minVolume24hUsd = Math.round(clamp(nudge(volumeBase, volumeBase * 0.9), 750000, 3000000));
    exit.emergencyStopLossPct = roundTo(clamp(nudge(stopBase, stopBase * 1.05), 4, 10), 1);
    reasons.push('Evil Panda kuat, volume 24h sedikit dilonggarkan');
  }

  return { patch: { entry, exit }, reasons };
}

function derivePatch(strategyName, summary) {
  const baseProfile = BASE_STRATEGY_PROFILES[strategyName];
  if (!baseProfile || summary.count < MIN_SAMPLES) {
    return { patch: null, reasons: [] };
  }

  switch (strategyName) {
    case 'Wave Enjoyer':
      return buildWavePatch(summary, baseProfile);
    case 'NPC':
      return buildNpcPatch(summary, baseProfile);
    case 'Evil Panda':
      return buildEvilPandaPatch(summary, baseProfile);
    default:
      return { patch: null, reasons: [] };
  }
}

export function refreshAdaptiveStrategyOverrides({ closedPositions = null, persist = true } = {}) {
  const rows = closedPositions || getClosedPositions();
  const previous = loadState();
  const next = { updatedAt: new Date().toISOString(), strategies: {} };
  const summaries = {};
  const changed = [];

  for (const strategyName of STRATEGY_NAMES) {
    const strategyRows = getStrategyRows(rows, strategyName);
    const summary = summarizeStrategy(strategyRows, BASE_STRATEGY_PROFILES[strategyName]);
    summaries[strategyName] = summary;
    const { patch, reasons } = derivePatch(strategyName, summary);

    if (patch) {
      next.strategies[strategyName] = {
        ...patch,
        meta: {
          count: summary.count,
          winRate: roundTo(summary.winRate, 1),
          avgPnlPct: roundTo(summary.avgPnlPct, 2),
          avgHoldMinutes: summary.avgHoldMinutes != null ? roundTo(summary.avgHoldMinutes, 1) : null,
          avgRangeEfficiencyPct: summary.avgRangeEfficiencyPct != null ? roundTo(summary.avgRangeEfficiencyPct, 1) : null,
          oorRate: roundTo(summary.oorRate, 1),
          reasons,
        },
      };
    }
  }

  const previousStr = JSON.stringify(previous.strategies || {});
  const nextStr = JSON.stringify(next.strategies || {});
  const updated = previousStr !== nextStr;

  if (persist && updated) {
    saveState(next);
  } else if (persist && !existsSync(ADAPTIVE_PATH)) {
    saveState(next);
  }

  return {
    updated,
    summaries,
    strategies: next.strategies,
    previous: previous.strategies || {},
    updatedAt: next.updatedAt,
  };
}

export function getAdaptiveStrategyOverrides() {
  return loadState().strategies || {};
}

export function getAdaptiveStrategyOverride(strategyName) {
  return getAdaptiveStrategyOverrides()[strategyName] || {};
}

export function getAdaptiveStrategyContext() {
  const state = loadState();
  const entries = Object.entries(state.strategies || {});
  if (entries.length === 0) return '';

  const lines = entries.map(([name, data]) => {
    const meta = data.meta || {};
    const reasons = meta.reasons?.length ? meta.reasons.join('; ') : 'no adaptive change';
    return `• ${name}: ${reasons} (n=${meta.count || 0}, win ${meta.winRate ?? 0}%, OOR ${meta.oorRate ?? 0}%)`;
  });

  return `\n\n🧪 ADAPTIVE STRATEGY TUNING:\n${lines.join('\n')}`;
}

