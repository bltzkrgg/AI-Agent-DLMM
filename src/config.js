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

import { readFileSync, existsSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from './utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || join(__dirname, '../user-config.json');
const CONFIG_BACKUP_PATH = `${CONFIG_PATH}.bak`;

export function normalizeDlmmLiquidityShape(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return normalized === 'bidask' ? 'bidask' : 'spot';
}

function isValidDlmmLiquidityShape(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return normalized === 'spot' || normalized === 'bidask';
}

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
  screeningTopPoolsLimit: 5,
  entryGateMode:        'lp_fee_flow',
  entrySupertrendBreakMinPct: 1.25,
  entryFreshBreakoutMinAthDistancePct: 99.25,
  entryFreshWatchWindowSec: 90,
  entryFreshBreakoutMaxDriftPct: 2.5,
  entryCandleSanityEnabled: true,
  entryRequireGreenCandle: true,
  entryRequireVolumeConfirm: true,
  entryMinVolumeRatio: 1.5,
  entryVolumeLookbackCandles: 12,
  entryCandleMaxAgeSec: 420,
  entryDecisionMode: 'strict',
  entryM15RequireGreenCandle: true,
  entryM15RequireVolumeConfirm: true,
  entryM15MinVolumeRatio: 0.7,
  entryM15VolumeLookbackCandles: 8,
  entryM15MaxAgeSec: 1800,
  entryM5HardGateEnabled: true,
  entryDeferOnM15PreviousUnknown: true,
  taWatchEnabled:       true,
  taWatchMaxPools:      10,
  taWatchExpiryMin:     60,
  watchIntervalSec:     30,

  // ── Intervals ────────────────────────────────────────────────────────────
  managementIntervalMin:    15,
  screeningIntervalMin:     15,
  positionUpdateIntervalMin: 5,
  realtimePnlIntervalSec:    15,
  pendingRetestEnabled:      true,
  retestIntervalMin:         5,
  retestTtlMin:              60,
  retestMaxAttempts:         8,
  retestMaxReadyPerScan:     3,
  deployQueueExpiryMin:      5,
  deployQueueHoldNotifyCooldownSec: 180,
  monitorFastLaneEnabled: true,
  monitorFastLaneThrottleMs: 1200,
  monitorFastLaneFallbackPollMs: 12000,
  monitorFastLaneUsePoolAccount: true,
  monitorFastLaneUsePositionAccount: true,

  // ── LLM Models ───────────────────────────────────────────────────────────
  // Priority: process.env > user-config.json[llm.*] > DEFAULTS
  // Ganti model via .env tanpa sentuh kode:
  //   SCREENING_MODEL, MANAGEMENT_MODEL, AGENT_MODEL
  screeningModel:  process.env.SCREENING_MODEL  || 'nvidia/llama-3.1-nemotron-70b-instruct',
  managementModel: process.env.MANAGEMENT_MODEL || 'deepseek/deepseek-chat',
  agentModel:      process.env.AGENT_MODEL      || 'deepseek/deepseek-chat',
  generalModel:    process.env.AGENT_MODEL      || 'deepseek/deepseek-chat',
  activeModel:     null,

  // ── Pool Discovery ────────────────────────────────────────────────────────
  meteoraDiscoveryLimit:  180,
  binStepPriority:        [200, 125, 100],
  allowedBinSteps:        [100, 125],
  minBinStep:             100,
  minFeeActiveTvlRatio:   0.002,
  minDailyFeeYieldPct:    1.0,
  maxPoolAgeHours:        0,          // 0 = tidak ada batas umur pool (Market Maker mode)
  // Parameter discovery (dibaca oleh coinfilter.normalizeConfig — tanpa radar.* layer)
  discoveryTimeframe:     '1h',
  discoveryCategory:      'trending',
  minTvl:                 10000,
  maxTvl:                 1000000,
  minHolders:             100,
  maxMcap:                0,

  // ── Meridian API ──────────────────────────────────────────────────────────
  publicApiKey:        '',
  agentMeridianApiUrl: 'https://api.agentmeridian.xyz/api',
  meridianSupertrendTimeoutMs: 8000,
  meridianSupertrendRetries:   2,
  lpAgentRelayEnabled: false,   // true = route Jupiter/Meteora lewat Meridian relay
  maxAthDistancePct:   15,
  dominanceMinPct:     15,

  // ── GMGN Screening ────────────────────────────────────────────────────────
  minMcap:                250000,
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
  dlmmLiquidityShape:     'spot',
  stopLossPct:            10,
  trailingStopPct:        5.0,
  trailingTriggerPct:     10,
  trailingDropPct:        3.0,
  maxHoldHours:           72,
  outOfRangeWaitMinutes:  30,   // Tunggu N menit OOR sebelum close
  oorDisplayWaitMinutes:  5,    // Tampilan OOR di log/notify
  deployRangeMaxBins:     68,   // Lebar range deploy monolith
  poolImpactGuardEnabled: false,
  poolImpactCheckIntervalMs: 3000,
  poolImpactPriceDropWarnPct: 2.5,
  poolImpactPriceDropPreExitPct: 4,
  poolImpactPriceDropForceExitPct: 6,
  poolImpactConsecutiveDropTicks: 3,
  poolImpactLowerRangeBufferPct: 15,
  poolImpactAlertCooldownMs: 60000,
  poolPatternLearningEnabled: false,
  poolPatternLearningShadowMode: true,
  poolPatternLearningMinSamples: 10,
  poolPatternLearningMaxScoreDelta: 8,
  poolPatternLearningLookbackDays: 14,
  maxDailyPriorityFeeSol: 0.2,
  activeStrategy:         'Evil Panda',
  smartExitRsi:           90,   // RSI(2) threshold untuk Meridian Smart Exit
  depthPct:               90,   // Depth jaring SOL ke bawah (%)
  entrySupertrendMinDistancePct: 1.5,
  entrySupertrendMaxDistancePct: 18,
  entryBreakoutMinAthDistancePct: 95,
  // ATR Guard — dynamic stop loss berbasis volatilitas
  atrGuardEnabled:        true,   // false = pakai stopLossPct static
  atrMultiplier:          1.5,    // SL = atrPct * multiplier
  maxDynamicSl:           20,     // Batas atas SL dinamis (%)
  // Blacklist
  blacklistEnabled:       true,   // false = abaikan blacklist lokal

  // ── OKX ──────────────────────────────────────────────────────────────────
  okxApiKey: process.env.OKX_API_KEY || '',
  signalWeights: {
    mcap: 2.5,
    feeActiveTvlRatio: 2.3,
    volume: 1.0,
    holderCount: 0.3,
  },
  strategyOverrides: {},

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
  screeningTopPoolsLimit: { min: 1,     max: 20 },
  positionUpdateIntervalMin: { min: 1,  max: 1440 },
  realtimePnlIntervalSec: { min: 5,     max: 3600 },
  entryGateMode:          { type: 'string' },
  pendingRetestEnabled:   { type: 'boolean' },
  retestIntervalMin:      { min: 1,     max: 1440 },
  retestTtlMin:           { min: 1,     max: 1440 },
  retestMaxAttempts:      { min: 1,     max: 100 },
  retestMaxReadyPerScan:  { min: 1,     max: 20 },
  deployQueueExpiryMin:   { min: 1,     max: 60 },
  deployQueueHoldNotifyCooldownSec: { min: 30, max: 1800 },
  monitorFastLaneEnabled: { type: 'boolean' },
  monitorFastLaneThrottleMs: { min: 250, max: 60_000 },
  monitorFastLaneFallbackPollMs: { min: 1000, max: 120_000 },
  monitorFastLaneUsePoolAccount: { type: 'boolean' },
  monitorFastLaneUsePositionAccount: { type: 'boolean' },
  meteoraDiscoveryLimit:  { min: 50,    max: 500 },
  allowedBinSteps:        { type: 'array' },
  binStepPriority:        { type: 'array' },
  minBinStep:             { min: 1,     max: 400 },
  minFeeActiveTvlRatio:   { min: 0,     max: 1 },
  minDailyFeeYieldPct:    { min: 0,     max: 20 },
  maxPoolAgeHours:        { min: 0,     max: 87600 },
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
  dlmmLiquidityShape:     { type: 'string' },
  stopLossPct:            { min: 1,     max: 50 },
  trailingStopPct:        { min: 0.5,   max: 50 },
  trailingTriggerPct:     { min: 0.5,   max: 50 },
  trailingDropPct:        { min: 0.1,   max: 20 },
  maxHoldHours:           { min: 1,     max: 168 },
  outOfRangeWaitMinutes:  { min: 1,     max: 1440 },
  oorDisplayWaitMinutes:  { min: 1,     max: 1440 },
  deployRangeMaxBins:     { min: 5,     max: 68 },
  poolImpactGuardEnabled: { type: 'boolean' },
  poolImpactCheckIntervalMs: { min: 1000, max: 60000 },
  poolImpactPriceDropWarnPct: { min: 0.1, max: 50 },
  poolImpactPriceDropPreExitPct: { min: 0.1, max: 50 },
  poolImpactPriceDropForceExitPct: { min: 0.1, max: 80 },
  poolImpactConsecutiveDropTicks: { min: 1, max: 20 },
  poolImpactLowerRangeBufferPct: { min: 0, max: 100 },
  poolImpactAlertCooldownMs: { min: 1000, max: 3600000 },
  poolPatternLearningEnabled: { type: 'boolean' },
  poolPatternLearningShadowMode: { type: 'boolean' },
  poolPatternLearningMinSamples: { min: 1, max: 200 },
  poolPatternLearningMaxScoreDelta: { min: 0, max: 50 },
  poolPatternLearningLookbackDays: { min: 1, max: 180 },
  maxDailyPriorityFeeSol: { min: 0.01,  max: 10 },
  // Discovery bounds
  discoveryTimeframe:     { type: 'string' },
  discoveryCategory:      { type: 'string' },
  minTvl:                 { min: 0,     max: 100_000_000 },
  maxTvl:                 { min: 0,     max: 100_000_000 },
  minHolders:             { min: 0,     max: 1_000_000 },
  smartExitRsi:           { min: 50,    max: 100 },
  depthPct:               { min: 10,    max: 100 },
  entrySupertrendMinDistancePct: { min: 0, max: 100 },
  entrySupertrendMaxDistancePct: { min: 0, max: 100 },
  entrySupertrendBreakMinPct: { min: 0, max: 100 },
  entryFreshBreakoutMinAthDistancePct: { min: 0, max: 100 },
  entryFreshWatchWindowSec: { min: 5, max: 600 },
  entryFreshBreakoutMaxDriftPct: { min: 0.1, max: 100 },
  entryCandleSanityEnabled: { type: 'boolean' },
  entryRequireGreenCandle: { type: 'boolean' },
  entryRequireVolumeConfirm: { type: 'boolean' },
  entryMinVolumeRatio: { min: 0, max: 20 },
  entryVolumeLookbackCandles: { min: 1, max: 100 },
  entryCandleMaxAgeSec: { min: 60, max: 1800 },
  entryDecisionMode: { type: 'string' },
  entryM15RequireGreenCandle: { type: 'boolean' },
  entryM15RequireVolumeConfirm: { type: 'boolean' },
  entryM15MinVolumeRatio: { min: 0, max: 5 },
  entryM15VolumeLookbackCandles: { min: 3, max: 50 },
  entryM15MaxAgeSec: { min: 300, max: 3600 },
  entryM5HardGateEnabled: { type: 'boolean' },
  entryDeferOnM15PreviousUnknown: { type: 'boolean' },
  taWatchEnabled:         { type: 'boolean' },
  taWatchMaxPools:        { min: 1, max: 50 },
  taWatchExpiryMin:       { min: 5, max: 720 },
  watchIntervalSec:       { min: 15, max: 3600 },
  entryBreakoutMinAthDistancePct: { min: 0, max: 100 },
  okxApiKey:              { type: 'string' },
  signalWeights:          { type: 'object' },
  strategyOverrides:      { type: 'object' },
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
    liquidityShape:     'dlmmLiquidityShape',
    shape:              'dlmmLiquidityShape',
    stopLossPct:        'stopLossPct',
    trailingStopPct:    'trailingStopPct',
    trailingTriggerPct: 'trailingTriggerPct',
    trailingDropPct:    'trailingDropPct',
    smartExitRsi:       'smartExitRsi',
    maxHoldHours:       'maxHoldHours',
    outOfRangeWaitMinutes: 'outOfRangeWaitMinutes',
    oorDisplayWaitMinutes: 'oorDisplayWaitMinutes',
    deployRangeMaxBins: 'deployRangeMaxBins',
  },

  oor: {
    waitMinutes:       'outOfRangeWaitMinutes',
    displayWaitMinutes: 'oorDisplayWaitMinutes',
  },

  watch: {
    enabled:          'taWatchEnabled',
    maxPools:         'taWatchMaxPools',
    expiryMin:        'taWatchExpiryMin',
    watchIntervalSec: 'watchIntervalSec',
  },

  entry: {
    decisionMode:         'entryDecisionMode',
    candleSanityEnabled:   'entryCandleSanityEnabled',
    requireGreenCandle:    'entryRequireGreenCandle',
    requireVolumeConfirm:  'entryRequireVolumeConfirm',
    minVolumeRatio:        'entryMinVolumeRatio',
    volumeLookbackCandles: 'entryVolumeLookbackCandles',
    candleMaxAgeSec:       'entryCandleMaxAgeSec',
    m15RequireGreenCandle: 'entryM15RequireGreenCandle',
    m15RequireVolumeConfirm: 'entryM15RequireVolumeConfirm',
    m15MinVolumeRatio: 'entryM15MinVolumeRatio',
    m15VolumeLookbackCandles: 'entryM15VolumeLookbackCandles',
    m15MaxAgeSec: 'entryM15MaxAgeSec',
    m5HardGateEnabled: 'entryM5HardGateEnabled',
    deferOnM15PreviousUnknown: 'entryDeferOnM15PreviousUnknown',
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
    maxMcap:               'maxMcap',
    maxMcapUsd:            'maxMcap',
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

  // Backward compatibility: legacy key maxMcapUsd tetap diterima, tapi canonical key adalah maxMcap.
  if (flat.maxMcap === undefined && flat.maxMcapUsd !== undefined) {
    flat.maxMcap = flat.maxMcapUsd;
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

function persistConfigSnapshot(path, snapshot, label = 'config') {
  const serialized = typeof snapshot === 'string'
    ? snapshot
    : stringify(snapshot, 2);
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, serialized, 'utf8');
  renameSync(tmpPath, path);
  return serialized;
}

function readConfigFile(path, label = 'config') {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!String(raw || '').trim()) {
      console.warn(`⚠️ [config] ${label} file kosong: ${path}`);
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.warn(`⚠️ [config] ${label} file gagal dibaca (${path}): ${e.message}`);
    return null;
  }
}

function loadUserConfig() {
  const primary = readConfigFile(CONFIG_PATH, 'primary');
  if (primary) return primary;
  const backup = readConfigFile(CONFIG_BACKUP_PATH, 'backup');
  if (backup) {
    console.warn(`⚠️ [config] Menggunakan backup config dari ${CONFIG_BACKUP_PATH}`);
    try {
      persistConfigSnapshot(CONFIG_PATH, backup, 'primary-restore');
      console.warn(`✅ [config] Primary config dipulihkan dari backup: ${CONFIG_PATH}`);
    } catch (e) {
      console.error(`⚠️ [config] Gagal memulihkan primary config dari backup: ${e.message}`);
    }
    return backup;
  }
  return {};
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

  if (typeof merged.dlmmLiquidityShape === 'string') {
    const rawShape = merged.dlmmLiquidityShape;
    const normalizedShape = normalizeDlmmLiquidityShape(rawShape);
    if (!isValidDlmmLiquidityShape(rawShape)) {
      console.warn(
        `[config] Invalid dlmmLiquidityShape "${rawShape}" — fallback ke "spot" ` +
        `(valid: spot, bidask)`
      );
    }
    merged.dlmmLiquidityShape = normalizedShape;
  }

  // Failsafe: maxPoolAgeHours tidak boleh 0 atau NaN
  merged.maxPoolAgeHours = (Number(merged.maxPoolAgeHours) > 0) ? Number(merged.maxPoolAgeHours) : 2160;

  // LP Simple M15 mode: default non-M5-hard-gate and no auto-defer on prev unknown,
  // unless operator explicitly sets the key in user config.
  if (String(merged.entryDecisionMode || 'strict').toLowerCase() === 'lp_simple_m15') {
    if (!Object.prototype.hasOwnProperty.call(user, 'entryM5HardGateEnabled')) {
      merged.entryM5HardGateEnabled = false;
    }
    if (!Object.prototype.hasOwnProperty.call(user, 'entryDeferOnM15PreviousUnknown')) {
      merged.entryDeferOnM15PreviousUnknown = false;
    }
  }

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
  deployAmountSol:        { section: 'finance',            type: 'number',  desc: 'Modal SOL per posisi (0.01–50)' },
  maxPositions:           { section: 'finance',            type: 'number',  desc: 'Maks posisi bersamaan (1–20)' },
  minSolToOpen:           { section: 'finance',            type: 'number',  desc: 'Saldo minimum buka posisi' },
  gasReserve:             { section: 'finance',            type: 'number',  desc: 'Cadangan gas SOL' },
  slippageBps:            { section: 'finance',            type: 'number',  desc: 'Slippage (bps, 10–1000)' },
  dailyLossLimitUsd:      { section: 'finance',            type: 'number',  desc: 'Batas rugi harian (USD)' },
  maxDailyPriorityFeeSol: { section: 'finance',            type: 'number',  desc: 'Batas fee prioritas/hari' },

  // ── Strategy / DLMM Shape ───────────────────────────────────────
  dlmmLiquidityShape:     { section: 'strategy',           type: 'string',  desc: 'Shape DLMM: spot atau bidask' },

  // ── Discovery Quality ────────────────────────────────────────────
  minTvl:                 { section: 'discovery',          type: 'number',  desc: 'TVL minimum pool (USD)' },
  maxTvl:                 { section: 'discovery',          type: 'number',  desc: 'TVL maksimum pool (USD)' },
  minVolume:              { section: 'discovery',          type: 'number',  desc: 'Volume minimum (USD)' },
  maxVolume:              { section: 'discovery',          type: 'number',  desc: 'Volume maksimum (USD, 0 = unlimited)' },
  minHolders:             { section: 'discovery',          type: 'number',  desc: 'Holder minimum token' },
  minOrganic:             { section: 'discovery',          type: 'number',  desc: 'Organic score minimum (0–100)' },
  minMcap:                { section: 'discovery',          type: 'number',  desc: 'Market Cap minimum token (USD, 0 = tidak filter)' },
  maxMcap:                { section: 'discovery',          type: 'number',  desc: 'Market Cap maksimum token (USD, 0 = tidak filter)' },

  // ── Entry Final Sanity ─────────────────────────────────────────
  entryDecisionMode:      { section: 'entry',              type: 'string',  desc: 'Mode keputusan entry: strict/lp_simple_m15' },
  entryCandleSanityEnabled:{ section: 'entry',              type: 'boolean', desc: 'Aktifkan final candle sanity gate' },
  entryMinVolumeRatio:    { section: 'entry',              type: 'number',  desc: 'Rasio volume candle entry vs rata-rata' },
  entryCandleMaxAgeSec:   { section: 'entry',              type: 'number',  desc: 'Batas usia candle entry (detik)' },
  entryRequireVolumeConfirm:{ section: 'entry',            type: 'boolean', desc: 'Wajib konfirmasi volume candle entry' },
  entryM15MinVolumeRatio: { section: 'entry',              type: 'number',  desc: 'Rasio minimum volume candle M15' },
  entryM15MaxAgeSec:      { section: 'entry',              type: 'number',  desc: 'Batas usia candle M15 (detik)' },
  entryM5HardGateEnabled: { section: 'entry',              type: 'boolean', desc: 'Aktifkan hard gate M5 untuk mode entry' },
  entryDeferOnM15PreviousUnknown: { section: 'entry',      type: 'boolean', desc: 'Defer saat M15 previous unknown' },

  // ── Watch / Queue ────────────────────────────────────────────────
  watchIntervalSec:       { section: 'watch',              type: 'number',  desc: 'Interval cek WATCH aktif (detik, 15–3600)' },
  deployQueueExpiryMin:   { section: 'watch',              type: 'number',  desc: 'Batas umur antrean deploy (menit)' },
  deployQueueHoldNotifyCooldownSec: { section: 'watch',    type: 'number',  desc: 'Cooldown notif HOLD queue yang sama (detik)' },
  monitorFastLaneEnabled: { section: 'watch',              type: 'boolean', desc: 'Aktifkan fast-lane monitor via websocket account change' },
  monitorFastLaneThrottleMs: { section: 'watch',           type: 'number',  desc: 'Throttle trigger fast-lane monitor (ms)' },
  monitorFastLaneFallbackPollMs: { section: 'watch',       type: 'number',  desc: 'Fallback poll saat websocket idle (ms)' },
  monitorFastLaneUsePoolAccount: { section: 'watch',       type: 'boolean', desc: 'Subscribe websocket untuk akun pool aktif' },
  monitorFastLaneUsePositionAccount: { section: 'watch',   type: 'boolean', desc: 'Subscribe websocket untuk akun position aktif' },
  taWatchEnabled:         { section: 'watch',              type: 'boolean', desc: 'Aktifkan sticky TA watch layer' },
  taWatchMaxPools:        { section: 'watch',              type: 'number',  desc: 'Maks kandidat yang bisa tinggal di WATCH (1–50)' },
  taWatchExpiryMin:       { section: 'watch',              type: 'number',  desc: 'Batas umur kandidat di WATCH (menit)' },

  // ── OOR Monitoring ───────────────────────────────────────────────
  outOfRangeWaitMinutes:  { section: 'oor',                type: 'number',  desc: 'Waktu tunggu OOR sebelum close (menit)' },
  oorDisplayWaitMinutes:  { section: 'oor',                type: 'number',  desc: 'Tampilan OOR di log/notify (menit)' },

  // ── Pool Impact Guard ────────────────────────────────────────────
  poolImpactGuardEnabled:         { section: 'poolImpactGuard',     type: 'boolean', desc: 'Aktifkan Pool Impact Exit Guard' },
  poolImpactPriceDropWarnPct:     { section: 'poolImpactGuard',     type: 'number',  desc: 'Drop harga pool untuk warning (%)' },
  poolImpactPriceDropPreExitPct:  { section: 'poolImpactGuard',     type: 'number',  desc: 'Drop harga pool untuk pre-exit (%)' },
  poolImpactPriceDropForceExitPct:{ section: 'poolImpactGuard',     type: 'number',  desc: 'Drop harga pool untuk emergency exit (%)' },
  poolImpactConsecutiveDropTicks: { section: 'poolImpactGuard',     type: 'number',  desc: 'Jumlah tick active-bin turun untuk konfirmasi impact' },
  poolImpactLowerRangeBufferPct:  { section: 'poolImpactGuard',     type: 'number',  desc: 'Buffer risiko dekat lower range (%)' },

  // ── Pool Pattern Learning ────────────────────────────────────────
  poolPatternLearningEnabled:     { section: 'poolPatternLearning', type: 'boolean', desc: 'Aktifkan Pool Pattern Learning' },
  poolPatternLearningShadowMode:  { section: 'poolPatternLearning', type: 'boolean', desc: 'Mode bayangan (hitung delta tanpa apply ke score)' },
  poolPatternLearningMinSamples:  { section: 'poolPatternLearning', type: 'number',  desc: 'Minimum sample pattern sebelum delta dipakai' },
  poolPatternLearningMaxScoreDelta:{ section: 'poolPatternLearning',type: 'number',  desc: 'Batas bonus/penalty score pattern learning' },
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
    if (section === 'discovery' && subKey === 'maxMcapUsd') {
      return null;
    }
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
    if (key === 'signalWeights') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { rejected.push(`${key}: must be an object`); continue; }
      const current = getConfig().signalWeights || DEFAULTS.signalWeights;
      validated[key] = { ...current, ...value };
      continue;
    }
    if (key === 'strategyOverrides') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { rejected.push(`${key}: must be an object`); continue; }
      const current = getConfig().strategyOverrides || {};
      const next = { ...current };
      for (const [name, override] of Object.entries(value)) {
        const existing = current[name] && typeof current[name] === 'object' ? current[name] : {};
        next[name] = {
          ...existing,
          ...(override || {}),
          deploy: { ...(existing.deploy || {}), ...((override || {}).deploy || {}) },
          exit: { ...(existing.exit || {}), ...((override || {}).exit || {}) },
        };
      }
      validated[key] = next;
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
    if (key === 'entryDecisionMode') {
      const mode = String(value || '').toLowerCase();
      const allowed = ['strict', 'lp_simple_m15'];
      if (!allowed.includes(mode)) { rejected.push(`${key}: must be one of ${allowed.join(', ')}`); continue; }
      validated[key] = mode;
      continue;
    }
    if (key === 'dlmmLiquidityShape') {
      const rawShape = String(value || '');
      const normalized = normalizeDlmmLiquidityShape(rawShape);
      if (!isValidDlmmLiquidityShape(rawShape)) {
        rejected.push(`${key}: must be one of spot, bidask`);
        continue;
      }
      validated[key] = normalized;
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
    const serialized = persistConfigSnapshot(CONFIG_PATH, merged, 'primary');
    persistConfigSnapshot(CONFIG_BACKUP_PATH, serialized, 'backup');
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
