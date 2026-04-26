/**
 * src/config.js — Linear Sniper Configuration
 *
 * Pure flat-config. Tidak ada nested objects, tidak ada legacy baggage.
 * Variabel model LLM dibaca dari process.env — ganti di .env tanpa ubah kode.
 *
 * Modul aktif yang membaca config ini:
 *   - src/agents/hunterAlpha.js  (discovery, screening, deploy)
 *   - src/sniper/evilPanda.js    (position management, exit)
 *   - src/market/meridianVeto.js (VETO gates, pool discovery)
 *   - src/market/coinfilter.js   (GMGN screening)
 *   - src/agent/provider.js      (LLM model resolution)
 *   - src/index.js               (Telegram bot, status)
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from './utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || join(__dirname, '../user-config.json');

const DEFAULTS = {

  // ── Deployment & Sizing ──────────────────────────────────────────────────
  deployAmountSol:    1.0,    // SOL per posisi yang dibuka
  maxPositions:       3,      // Maksimum posisi terbuka bersamaan
  minSolToOpen:       0.10,   // Min saldo SOL sebelum boleh buka posisi
  gasReserve:         0.03,   // SOL cadangan untuk tx fees
  dailyLossLimitUsd:  25,     // Batas kerugian harian sebelum Hunter jeda

  // ── Bot Mode ─────────────────────────────────────────────────────────────
  dryRun:             false,  // true = tidak eksekusi TX apapun
  deploymentStage:    'full', // shadow | canary | full
  canaryMaxPositions: 1,
  autonomyMode:       'active', // active | paused
  autoScreeningEnabled: false,

  // ── LLM Models ───────────────────────────────────────────────────────────
  // Ganti model via .env tanpa menyentuh kode:
  //   SCREENING_MODEL   — dipakai Hunter saat evaluasi kandidat token
  //   MANAGEMENT_MODEL  — dipakai untuk analisis posisi & sinyal keluar
  //   AGENT_MODEL       — model utama untuk reasoning kompleks
  screeningModel:  process.env.SCREENING_MODEL  || 'nvidia/nemotron-3-super-120b-a12b:free',
  managementModel: process.env.MANAGEMENT_MODEL || 'minimax/minimax-m2.5:free',
  agentModel:      process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  generalModel:    process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  activeModel:     null, // Diset via /model command — override semua

  // ── Pool Discovery (hunterAlpha.js + meridianVeto.js) ────────────────────
  meteoraDiscoveryLimit: 180,        // Pool yang di-scan per siklus
  binStepPriority:  [200, 125, 100], // Urutan prioritas: fee tertinggi dulu
  allowedBinSteps:  [100, 125, 200], // Whitelist bin step
  minBinStep:       100,
  maxBinStep:       200,
  minFeeActiveTvlRatio: 0.002,       // Min fee/active_tvl ratio
  minDailyFeeYieldPct:  1.0,         // Min fee yield harian (%)
  maxPoolAgeHours:  2160,            // Max usia pool (default 90 hari)
  maxPoolAgeDays:   3,               // Freshness rule: reject pool > 3 hari

  // ── Meridian API ─────────────────────────────────────────────────────────
  publicApiKey:       '',            // API key Agent Meridian
  agentMeridianApiUrl: 'https://api.agentmeridian.xyz/api',
  maxAthDistancePct:  15,            // VETO jika harga > 85% ATH
  dominanceMinPct:    15,            // VETO jika pool < 15% total TVL token

  // ── GMGN Screening (coinfilter.js) ───────────────────────────────────────
  minMcap:            250000,
  maxMcap:            0,             // 0 = disabled
  minVolume24h:       1000000,
  minOrganic:         55,
  gmgnMinTotalFeesSol:    30,
  gmgnTop10HolderMaxPct:  30,
  gmgnDevHoldMaxPct:       5,
  gmgnInsiderMaxPct:       0,
  gmgnBundlerMaxPct:      60,
  gmgnWashTradeMaxPct:    35,
  gmgnRequireBurnedLp:    true,
  gmgnRequireZeroTax:     true,
  gmgnBlockCto:           true,
  gmgnBlockVamped:        true,
  gmgnFailClosedCritical: true,
  gmgnMinAgeHours:        0,
  gmgnMaxAgeHours:        168,       // 7 hari
  gmgnRequireKnownAge:    false,
  bannedNarratives: ['kanye', 'taylor', 'trump', 'biden', 'kamala', 'justice', 'bags', 'moo deng', 'pesto'],
  maxTvlMcapRatio:  0.20,
  maxPriceImpactPct: 1.5,

  // ── Evil Panda Position Parameters (evilPanda.js) ────────────────────────
  slippageBps:       150,    // Slippage DLMM TX (150 bps = 1.5%)
  trailingStopPct:   5.0,    // Trailing SL: exit jika turun X% dari HWM
  stopLossPct:       10,     // Hard stop loss (%)
  maxHoldHours:      72,     // Force-close jika posisi > N jam
  maxDailyPriorityFeeSol: 0.2,

  // ── OKX API ──────────────────────────────────────────────────────────────
  okxApiKey: process.env.OKX_API_KEY || '',

};

const KNOWN_CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

// ── CONFIG_BOUNDS — batas aman untuk AI-driven updates ───────────────────────
const CONFIG_BOUNDS = {
  deployAmountSol:        { min: 0.01,  max: 50 },
  maxPositions:           { min: 1,     max: 20 },
  minSolToOpen:           { min: 0.01,  max: 1 },
  gasReserve:             { min: 0.01,  max: 0.5 },
  dailyLossLimitUsd:      { min: 0,     max: 1000 },
  dryRun:                 { type: 'boolean' },
  deploymentStage:        { type: 'string' },
  canaryMaxPositions:     { min: 1,     max: 20 },
  autonomyMode:           { type: 'string' },
  autoScreeningEnabled:   { type: 'boolean' },

  // Pool discovery
  meteoraDiscoveryLimit:  { min: 50,    max: 500 },
  allowedBinSteps:        { type: 'array' },
  binStepPriority:        { type: 'array' },
  minBinStep:             { min: 1,     max: 400 },
  maxBinStep:             { min: 1,     max: 400 },
  minFeeActiveTvlRatio:   { min: 0,     max: 1 },
  minDailyFeeYieldPct:    { min: 0,     max: 20 },
  maxPoolAgeHours:        { min: 1,     max: 87600 },
  maxPoolAgeDays:         { min: 0.1,   max: 365 },

  // Meridian
  maxAthDistancePct:      { min: 1,     max: 50 },
  dominanceMinPct:        { min: 1,     max: 100 },

  // GMGN
  minMcap:                { min: 0,     max: 100_000_000 },
  maxMcap:                { min: 0,     max: 10_000_000_000 },
  minVolume24h:           { min: 0,     max: 1_000_000_000 },
  minOrganic:             { min: 0,     max: 100 },
  gmgnMinTotalFeesSol:    { min: 0,     max: 1_000_000 },
  gmgnTop10HolderMaxPct:  { min: 0,     max: 100 },
  gmgnDevHoldMaxPct:      { min: 0,     max: 100 },
  gmgnInsiderMaxPct:      { min: 0,     max: 100 },
  gmgnBundlerMaxPct:      { min: 0,     max: 100 },
  gmgnWashTradeMaxPct:    { min: 0,     max: 100 },
  gmgnRequireBurnedLp:    { type: 'boolean' },
  gmgnRequireZeroTax:     { type: 'boolean' },
  gmgnBlockCto:           { type: 'boolean' },
  gmgnBlockVamped:        { type: 'boolean' },
  gmgnFailClosedCritical: { type: 'boolean' },
  gmgnMinAgeHours:        { min: 0,     max: 720 },
  gmgnMaxAgeHours:        { min: 1,     max: 720 },
  gmgnRequireKnownAge:    { type: 'boolean' },
  bannedNarratives:       { type: 'array' },
  maxTvlMcapRatio:        { min: 0.01,  max: 1.0 },
  maxPriceImpactPct:      { min: 0.1,   max: 5 },

  // Evil Panda
  slippageBps:            { min: 10,    max: 1000 },
  trailingStopPct:        { min: 0.5,   max: 50 },
  stopLossPct:            { min: 1,     max: 50 },
  maxHoldHours:           { min: 1,     max: 168 },
  maxDailyPriorityFeeSol: { min: 0.01,  max: 10 },

  okxApiKey:              { type: 'string' },
};

// ── JSON helpers ──────────────────────────────────────────────────────────────

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('⚠️ [config] GAGAL MEMBACA user-config.json:', e.message);
    console.error('Bot akan menggunakan nilai DEFAULT. Periksa tanda koma/kutip di file!');
    return {};
  }
}

function loadUserConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return safeParseJSON(readFileSync(CONFIG_PATH, 'utf-8'));
}

// ── getConfig ─────────────────────────────────────────────────────────────────

export function getConfig() {
  const user   = loadUserConfig();
  const merged = { ...DEFAULTS, ...user };

  // Lenient numeric parsing — strips trailing units ("1.5 SOL" → 1.5)
  for (const key of Object.keys(merged)) {
    if (typeof DEFAULTS[key] === 'number' && typeof merged[key] === 'string') {
      const trimmed  = merged[key].trim();
      const clean    = trimmed.replace(/[^-0-9.]/g, '');
      const dotCount = (clean.match(/\./g) || []).length;
      if (dotCount > 1) {
        console.warn(`[config] Rejected malformed numeric "${key}": "${trimmed}" — using default ${DEFAULTS[key]}`);
        merged[key] = DEFAULTS[key];
        continue;
      }
      const parsed = parseFloat(clean);
      merged[key] = !isNaN(parsed) ? parsed : DEFAULTS[key];
    }
  }

  // Failsafe: maxPoolAgeHours tidak boleh 0 atau NaN
  merged.maxPoolAgeHours = (Number(merged.maxPoolAgeHours) > 0) ? Number(merged.maxPoolAgeHours) : 2160;

  return merged;
}

export function isConfigKeySupported(key) {
  return KNOWN_CONFIG_KEYS.has(key);
}

// ── updateConfig ──────────────────────────────────────────────────────────────

export function updateConfig(updates) {
  const validated = {};
  const rejected  = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!isConfigKeySupported(key)) {
      rejected.push(`${key}: unsupported key`);
      continue;
    }

    // Array keys
    if (key === 'allowedBinSteps' || key === 'binStepPriority') {
      if (!Array.isArray(value)) { rejected.push(`${key}: must be an array`); continue; }
      validated[key] = value.map(v => parseInt(v)).filter(v => !isNaN(v));
      continue;
    }
    if (key === 'bannedNarratives') {
      if (!Array.isArray(value)) { rejected.push(`${key}: must be an array`); continue; }
      validated[key] = value.map(v => String(v).toLowerCase().trim()).filter(Boolean);
      continue;
    }

    // Enum keys
    if (key === 'deploymentStage') {
      const stage   = String(value || '').toLowerCase();
      const allowed = ['shadow', 'canary', 'full'];
      if (!allowed.includes(stage)) { rejected.push(`${key}: must be one of ${allowed.join(', ')}`); continue; }
      validated[key] = stage;
      continue;
    }
    if (key === 'autonomyMode') {
      const mode    = String(value || '').toLowerCase();
      const allowed = ['active', 'paused'];
      if (!allowed.includes(mode)) { rejected.push(`${key}: must be one of ${allowed.join(', ')}`); continue; }
      validated[key] = mode;
      continue;
    }

    const bounds = CONFIG_BOUNDS[key];
    if (bounds && typeof value === 'number') {
      if (value < bounds.min || value > bounds.max) {
        rejected.push(`${key}: ${value} (allowed: ${bounds.min}–${bounds.max})`);
        continue;
      }
    }
    validated[key] = value;
  }

  if (rejected.length > 0) {
    console.warn('⚠️ Config updates rejected:', rejected.join(', '));
  }
  if (Object.keys(validated).length === 0) return getConfig();

  const current = loadUserConfig();
  const merged  = { ...current, ...validated };
  writeFileSync(CONFIG_PATH, stringify(merged, 2));
  console.log('✅ Config updated:', Object.keys(validated).join(', '));
  return getConfig();
}

// ── Utility exports ───────────────────────────────────────────────────────────

export function isDryRun() {
  return getConfig().dryRun === true;
}

export function getEntryCapacity(cfg = getConfig(), maxPositionsOverride = null) {
  const stage = String(cfg?.deploymentStage || 'full').toLowerCase();
  if (stage === 'shadow') {
    return { blocked: true, reason: 'deploymentStage=shadow', stage, stageMaxPositions: 0, maxPositions: 0 };
  }
  const stageMaxPositions = stage === 'canary'
    ? Math.min(cfg.maxPositions, Math.max(1, Number(cfg.canaryMaxPositions || 1)))
    : cfg.maxPositions;
  const requestedMax = Number.isFinite(maxPositionsOverride)
    ? Math.max(1, Math.floor(maxPositionsOverride))
    : stageMaxPositions;
  return {
    blocked: false, reason: null, stage,
    stageMaxPositions,
    maxPositions: Math.min(requestedMax, stageMaxPositions),
  };
}
