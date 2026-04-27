/**
 * src/config.js — Linear Sniper Configuration
 *
 * Mendukung dua format user-config.json:
 *   - FLAT  : { deployAmountSol: 0.5, ... }            (legacy / manual)
 *   - NESTED: { finance: { deployAmountSol: 0.5 }, ... } (format baru)
 *
 * flattenUserConfig() mendeteksi dan menormalisasi keduanya secara otomatis.
 * Variabel model LLM: dibaca dari process.env terlebih dulu, fallback ke
 * user-config.json llm.*, lalu fallback ke DEFAULTS.
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

// ── DEFAULTS ──────────────────────────────────────────────────────────────────
// Semua nilai default dalam format flat. Nilai ini digunakan jika kunci tidak
// ditemukan di user-config.json maupun di process.env.

const DEFAULTS = {

  // ── Deployment & Sizing ──────────────────────────────────────────────────
  deployAmountSol:    1.0,
  maxPositions:       3,
  minSolToOpen:       0.10,
  gasReserve:         0.03,
  dailyLossLimitUsd:  25,

  // ── Bot Mode ─────────────────────────────────────────────────────────────
  dryRun:               false,
  deploymentStage:      'full',
  canaryMaxPositions:   1,
  autonomyMode:         'active',
  autoScreeningEnabled: false,
  requireConfirmation:  false, // true = minta konfirmasi Telegram sebelum deploy

  // ── Intervals ────────────────────────────────────────────────────────────
  managementIntervalMin:    15,
  screeningIntervalMin:     15,
  positionUpdateIntervalMin: 5,

  // ── LLM Models ───────────────────────────────────────────────────────────
  // Priority: process.env > user-config.json[llm.*] > DEFAULTS
  // Ganti model via .env tanpa sentuh kode:
  //   SCREENING_MODEL, MANAGEMENT_MODEL, AGENT_MODEL
  screeningModel:  process.env.SCREENING_MODEL  || 'nvidia/nemotron-3-super-120b-a12b:free',
  managementModel: process.env.MANAGEMENT_MODEL || 'minimax/minimax-m2.5:free',
  agentModel:      process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  generalModel:    process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  activeModel:     null,

  // ── Pool Discovery ────────────────────────────────────────────────────────
  meteoraDiscoveryLimit:  180,
  binStepPriority:        [200, 125, 100],
  allowedBinSteps:        [100, 125, 200],
  minBinStep:             100,
  maxBinStep:             200,
  minFeeActiveTvlRatio:   0.002,
  minDailyFeeYieldPct:    1.0,
  maxPoolAgeHours:        0,          // 0 = tidak ada batas umur pool (Market Maker mode)
  // maxPoolAgeDays dihapus — bot sekarang bisa detect pool tua (SOL/USDC, dsb)
  // Parameter discovery (dibaca oleh coinfilter.normalizeConfig — tanpa radar.* layer)
  discoveryTimeframe:     '1h',
  discoveryCategory:      'trending',
  minTvl:                 10000,
  maxTvl:                 1000000,
  minHolders:             100,

  // ── Meridian API ──────────────────────────────────────────────────────────
  publicApiKey:        '',
  agentMeridianApiUrl: 'https://api.agentmeridian.xyz/api',
  lpAgentRelayEnabled: false,   // true = route Jupiter/Meteora lewat Meridian relay
  maxAthDistancePct:   15,
  dominanceMinPct:     15,

  // ── GMGN Screening ────────────────────────────────────────────────────────
  minMcap:                250000,
  maxMcap:                0,
  minVolume:              100000,
  maxVolume:              0,
  minOrganic:             55,
  gmgnEnabled:            true,   // Master switch: false = skip semua filter GMGN
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
  gmgnMaxAgeHours:        168,
  gmgnRequireKnownAge:    false,
  bannedNarratives:       ['kanye', 'taylor', 'trump', 'biden', 'kamala', 'justice', 'bags', 'moo deng', 'pesto'],
  maxTvlMcapRatio:        0.20,
  maxPriceImpactPct:      1.5,

  // ── Evil Panda Position ───────────────────────────────────────────────────
  slippageBps:            250,
  stopLossPct:            10,
  trailingStopPct:        5.0,
  trailingTriggerPct:     10,
  trailingDropPct:        3.0,
  maxHoldHours:           72,
  outOfRangeWaitMinutes:  30,   // Tunggu N menit OOR sebelum close
  maxDailyPriorityFeeSol: 0.2,
  activeStrategy:         'Evil Panda',
  smartExitRsi:           90,   // RSI(2) threshold untuk Meridian Smart Exit
  depthPct:               90,   // Depth jaring SOL ke bawah (%)
  // ATR Guard — dynamic stop loss berbasis volatilitas
  atrGuardEnabled:        true,   // false = pakai stopLossPct static
  atrMultiplier:          1.5,    // SL = atrPct * multiplier
  maxDynamicSl:           20,     // Batas atas SL dinamis (%)
  // Blacklist
  blacklistEnabled:       true,   // false = abaikan blacklist lokal

  // ── OKX ──────────────────────────────────────────────────────────────────
  okxApiKey: process.env.OKX_API_KEY || '',

};

const KNOWN_CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

// ── CONFIG_BOUNDS ─────────────────────────────────────────────────────────────
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
  managementIntervalMin:  { min: 1,     max: 1440 },
  screeningIntervalMin:   { min: 5,     max: 1440 },
  positionUpdateIntervalMin: { min: 1,  max: 1440 },
  meteoraDiscoveryLimit:  { min: 50,    max: 500 },
  allowedBinSteps:        { type: 'array' },
  binStepPriority:        { type: 'array' },
  minBinStep:             { min: 1,     max: 400 },
  maxBinStep:             { min: 1,     max: 400 },
  minFeeActiveTvlRatio:   { min: 0,     max: 1 },
  minDailyFeeYieldPct:    { min: 0,     max: 20 },
  maxPoolAgeHours:        { min: 0,     max: 87600 },
  // maxPoolAgeDays dihapus dari bounds
  maxAthDistancePct:      { min: 1,     max: 50 },
  dominanceMinPct:        { min: 1,     max: 100 },
  minMcap:                { min: 0,     max: 100_000_000 },
  maxMcap:                { min: 0,     max: 10_000_000_000 },
  minVolume:              { min: 0,     max: 1_000_000_000 },
  maxVolume:              { min: 0,     max: 1_000_000_000 },
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
  slippageBps:            { min: 10,    max: 1000 },
  stopLossPct:            { min: 1,     max: 50 },
  trailingStopPct:        { min: 0.5,   max: 50 },
  trailingTriggerPct:     { min: 0.5,   max: 50 },
  trailingDropPct:        { min: 0.1,   max: 20 },
  maxHoldHours:           { min: 1,     max: 168 },
  outOfRangeWaitMinutes:  { min: 1,     max: 1440 },
  maxDailyPriorityFeeSol: { min: 0.01,  max: 10 },
  // Discovery bounds
  discoveryTimeframe:     { type: 'string' },
  discoveryCategory:      { type: 'string' },
  minTvl:                 { min: 0,     max: 100_000_000 },
  maxTvl:                 { min: 0,     max: 100_000_000 },
  minHolders:             { min: 0,     max: 1_000_000 },
  smartExitRsi:           { min: 50,    max: 100 },
  depthPct:               { min: 10,    max: 100 },
  okxApiKey:              { type: 'string' },
};

// ── flattenUserConfig ─────────────────────────────────────────────────────────
// Mendukung format nested (baru) dan flat (lama) secara transparan.
//
// Format nested:
//   { finance: { deployAmountSol: 0.5 }, strategy: { stopLossPct: 5 } }
// → flat:
//   { deployAmountSol: 0.5, stopLossPct: 5 }
//
// LLM dari nested `llm.*` hanya dipakai jika process.env tidak di-set.

// ── NESTED_SECTION_MAP ───────────────────────────────────────────────────────
// Mendefinisikan cara flatten setiap section nested ke flat keys.
//   null  = semua key di section langsung naik ke root (nama key tidak berubah)
//   object = mapping eksplisit: { keyDiSection: 'flatKeyDiConfig' }

const NESTED_SECTION_MAP = {
  // Flat passthrough — semua key langsung ke root
  finance:   null,
  intervals: null,

  // strategy: beberapa key memiliki alias
  strategy: {
    name:               'activeStrategy',
    depthPct:           'depthPct',
    targetBinSteps:     'allowedBinSteps',
    binStepPriority:    'binStepPriority',
    stopLossPct:        'stopLossPct',
    trailingStopPct:    'trailingStopPct',
    trailingTriggerPct: 'trailingTriggerPct',
    trailingDropPct:    'trailingDropPct',
    smartExitRsi:       'smartExitRsi',
    maxHoldHours:       'maxHoldHours',
    outOfRangeWaitMinutes: 'outOfRangeWaitMinutes',
  },

  // discovery: parameter pencarian pool Meteora
  discovery: {
    meteoraDiscoveryLimit: 'meteoraDiscoveryLimit',
    timeframe:             'discoveryTimeframe',
    category:              'discoveryCategory',
    minTvl:                'minTvl',
    maxTvl:                'maxTvl',
    minVolume:             'minVolume',
    maxVolume:             'maxVolume',
    minHolders:            'minHolders',
    minOrganic:            'minOrganic',
    minMcap:               'minMcap',
    maxMcapUsd:            'maxMcapUsd',
    // maxPoolAgeDays dihapus — tidak ada filter umur pool (Market Maker mode)
  },

  // security_gmgn: prefix gmgn* di flat config
  security_gmgn: {
    enabled:            'gmgnEnabled',
    requireBurnedLp:    'gmgnRequireBurnedLp',
    requireZeroTax:     'gmgnRequireZeroTax',
    blockCto:           'gmgnBlockCto',
    blockVamped:        'gmgnBlockVamped',
    failClosedCritical: 'gmgnFailClosedCritical',
    top10HolderMaxPct:  'gmgnTop10HolderMaxPct',
    insiderMaxPct:      'gmgnInsiderMaxPct',
    devHoldMaxPct:      'gmgnDevHoldMaxPct',
    bundlerMaxPct:      'gmgnBundlerMaxPct',
    minTotalFeesSol:    'gmgnMinTotalFeesSol',
    washTradeMaxPct:    'gmgnWashTradeMaxPct',
    minAgeHours:        'gmgnMinAgeHours',
    maxAgeHours:        'gmgnMaxAgeHours',
  },

  // llm: override oleh process.env (lihat akhir flattenUserConfig)
  llm: {
    screeningModel:  'screeningModel',
    managementModel: 'managementModel',
    agentModel:      'agentModel',
  },

  // meridian
  meridian: {
    publicApiKey:        'publicApiKey',
    agentMeridianApiUrl: 'agentMeridianApiUrl',
    lpAgentRelayEnabled: 'lpAgentRelayEnabled',
    maxAthDistancePct:   'maxAthDistancePct',
    dominanceMinPct:     'dominanceMinPct',
  },
};

function flattenUserConfig(raw) {
  const flat = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key in NESTED_SECTION_MAP && value && typeof value === 'object' && !Array.isArray(value)) {
      const mapping = NESTED_SECTION_MAP[key];

      if (mapping === null) {
        // Semua key di section langsung naik ke root
        Object.assign(flat, value);
      } else {
        // Gunakan mapping eksplisit (misal: llm.agentModel → agentModel)
        for (const [subKey, flatKey] of Object.entries(mapping)) {
          if (subKey in value) {
            flat[flatKey] = value[subKey];
          }
        }
      }
    } else {
      // Flat key langsung — kompatibel dengan format lama
      flat[key] = value;
    }
  }

  // process.env selalu override llm config dari file
  if (process.env.SCREENING_MODEL)  flat.screeningModel  = process.env.SCREENING_MODEL;
  if (process.env.MANAGEMENT_MODEL) flat.managementModel = process.env.MANAGEMENT_MODEL;
  if (process.env.AGENT_MODEL)      flat.agentModel      = process.env.AGENT_MODEL;
  if (process.env.AGENT_MODEL)      flat.generalModel    = process.env.AGENT_MODEL;

  return flat;
}

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
  const raw    = loadUserConfig();
  const user   = flattenUserConfig(raw);
  const merged = { ...DEFAULTS, ...user };

  // Lenient numeric parsing — strips trailing units ("1.5 SOL" → 1.5)
  for (const key of Object.keys(merged)) {
    if (typeof DEFAULTS[key] === 'number' && typeof merged[key] === 'string') {
      const trimmed  = merged[key].trim();
      const clean    = trimmed.replace(/[^-0-9.]/g, '');
      const dotCount = (clean.match(/\./g) || []).length;
      if (dotCount > 1) {
        console.warn(`[config] Rejected malformed numeric "${key}": "${trimmed}" — using default`);
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

// ── SETCONFIG_WHITELIST ───────────────────────────────────────────────────────
// Hanya kunci dalam section ini yang bisa diubah via /setconfig dari Telegram.
// Ini mencegah user merusak config inti (LLM model, RPC, dsb.).
// Format: { 'flatKey': 'section.displayKey' } untuk help text

export const SETCONFIG_WHITELIST = {
  // ── Finance ──────────────────────────────────────────────────────
  deployAmountSol:        { section: 'finance',    type: 'number',  desc: 'Modal SOL per posisi (0.01–50)' },
  maxPositions:           { section: 'finance',    type: 'number',  desc: 'Maks posisi bersamaan (1–20)' },
  minSolToOpen:           { section: 'finance',    type: 'number',  desc: 'Saldo minimum buka posisi' },
  gasReserve:             { section: 'finance',    type: 'number',  desc: 'Cadangan gas SOL' },
  dailyLossLimitUsd:      { section: 'finance',    type: 'number',  desc: 'Batas rugi harian (USD)' },
  maxDailyPriorityFeeSol: { section: 'finance',    type: 'number',  desc: 'Batas fee prioritas/hari' },
  slippageBps:            { section: 'finance',    type: 'number',  desc: 'Slippage (bps, 10–1000)' },
  // ── Discovery ─────────────────────────────────────────────────────
  meteoraDiscoveryLimit:  { section: 'discovery',  type: 'number',  desc: 'Jumlah pool discan per siklus' },
  discoveryTimeframe:     { section: 'discovery',  type: 'string',  desc: 'Timeframe chart (1m/5m/15m/1h)' },
  discoveryCategory:      { section: 'discovery',  type: 'string',  desc: 'Kategori pool (trending/new/…)' },
  minTvl:                 { section: 'discovery',  type: 'number',  desc: 'TVL minimum pool (USD)' },
  maxTvl:                 { section: 'discovery',  type: 'number',  desc: 'TVL maksimum pool (USD)' },
  minVolume:              { section: 'discovery',  type: 'number',  desc: 'Volume minimum (USD)' },
  maxVolume:              { section: 'discovery',  type: 'number',  desc: 'Volume maksimum (USD, 0 = unlimited)' },
  minHolders:             { section: 'discovery',  type: 'number',  desc: 'Holder minimum token' },
  minOrganic:             { section: 'discovery',  type: 'number',  desc: 'Organic score minimum (0–100)' },
  maxPoolAgeDays:         { section: 'discovery',  type: 'number',  desc: '[DEPRECATED] Gunakan maxPoolAgeHours. Umur pool maksimum (hari)' },
  minMcap:                { section: 'discovery',  type: 'number',  desc: 'Market Cap minimum token (USD, 0 = tidak filter)' },
  maxMcapUsd:             { section: 'discovery',  type: 'number',  desc: 'Market Cap maksimum token (USD, 0 = tidak filter)' },
  // ── Screening ─────────────────────────────────────────────────────
  autoScreeningEnabled:   { section: 'screening',  type: 'boolean', desc: 'Aktifkan auto-screening berkala (true/false)' },
  screeningIntervalMin:   { section: 'screening',  type: 'number',  desc: 'Interval auto-screening (menit, 5–1440)' },
};

// ── resolveNestedKey ─────────────────────────────────────────────────────────
// Resolve input dari /setconfig:
//   'deployAmountSol'         → { flatKey: 'deployAmountSol', meta }
//   'finance.deployAmountSol' → { flatKey: 'deployAmountSol', meta }
//   'discovery.timeframe'     → { flatKey: 'discoveryTimeframe', meta }
// Return null jika key tidak dikenali atau tidak di whitelist.

export function resolveNestedKey(input) {
  if (!input || typeof input !== 'string') return null;

  const parts = input.trim().split('.');

  let flatKey;
  if (parts.length === 1) {
    // Flat key langsung: 'deployAmountSol'
    flatKey = parts[0];
  } else {
    // Dot notation: 'section.subKey'
    const [section, subKey] = parts;
    const sectionMap = NESTED_SECTION_MAP[section];
    if (!sectionMap) {
      // Section null = passthrough (e.g. finance, intervals)
      flatKey = subKey;
    } else {
      // Cek di mapping eksplisit (e.g. discovery.timeframe → discoveryTimeframe)
      flatKey = sectionMap[subKey] || subKey;
    }
  }

  // Harus ada di whitelist
  const meta = SETCONFIG_WHITELIST[flatKey];
  if (!meta) return null;

  return { flatKey, meta, input };
}

// ── updateConfig ──────────────────────────────────────────────────────────────
// updateConfig selalu menulis ke format FLAT untuk kompatibilitas maksimal.
// Format nested di user-config.json tetap dibaca saat getConfig(), tapi update
// selalu ditulis sebagai flat key di root JSON.

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
    if (bounds && typeof value === 'number' && bounds.min !== undefined) {
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

  // Baca file asli (nested atau flat), merge flat updates di root
  const rawCurrent = loadUserConfig();
  const merged = { ...rawCurrent, ...validated };

  try {
    writeFileSync(CONFIG_PATH, stringify(merged, 2));
    console.log(`✅ Config updated & persisted to user-config.json: ${Object.keys(validated).join(', ')}`);
  } catch (writeErr) {
    // File mungkin terkunci sementara — update tetap aktif di memory, tapi tidak tersimpan
    console.error(`⚠️ Config write failed (in-memory only): ${writeErr.message}`);
  }

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
