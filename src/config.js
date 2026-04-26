import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from './utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOT_CONFIG_PATH || join(__dirname, '../user-config.json');

const DEFAULTS = {
  // Position sizing
  deployAmountSol: 1.0,
  maxPositions: 3,
  minSolToOpen: 0.10,
  gasReserve: 0.03, // SOL yang disisakan untuk tx fees + account rent
  dailyLossLimitUsd: 25, // Batas kerugian harian ($) sebelum Hunter istirahat (default lebih realistis untuk live deployment)

  // Agent intervals (minutes)
  managementIntervalMin: 15,
  screeningIntervalMin: 15,
  positionUpdateIntervalMin: 5,  // Interval notif status posisi (PnL, fees, range)

  // Auto-screening
  autoScreeningEnabled: false,  // Aktifkan auto-screening Hunter via cron
  autonomyMode: 'active',       // active | paused (pause semua loop otonom, manual command tetap bisa)

  // Dry run — tidak eksekusi TX apapun, semua else normal
  dryRun: false,
  deploymentStage: 'full',      // shadow | canary | full
  canaryMaxPositions: 1,        // Max posisi saat stage=canary
  autoPauseOnManualReview: true,
  manualReviewPauseThreshold: 1,

  // ── LLM Models ─────────────────────────────────────────────────────
  // Penggantian model dilakukan via variabel lingkungan di .env:
  //   SCREENING_MODEL   — model untuk screening token (ringan, cepat)
  //   MANAGEMENT_MODEL  — model untuk manajemen posisi & analisis
  //   AGENT_MODEL       — model utama agen (paling powerful)
  // Jika variabel tidak di-set, fallback ke model gratis yang terverifikasi.
  // Override global session bisa dilakukan via command /model di Telegram.
  screeningModel:  process.env.SCREENING_MODEL  || 'nvidia/nemotron-3-super-120b-a12b:free',
  managementModel: process.env.MANAGEMENT_MODEL || 'minimax/minimax-m2.5:free',
  agentModel:      process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  generalModel:    process.env.AGENT_MODEL      || 'deepseek/deepseek-v3.2',
  activeModel: null, // Diset via /model command — prioritas tertinggi, override semua

  // Screening thresholds — Evil Panda: hunt fresh hyper-active pools
  maxPoolAgeDays: 3,          // Reject pools older than 3 days (72h freshness rule)
  minOrganic: 55,
  minBinStep: 100,            // Minimal 100 bin step (Hukum 3)
  allowedBinSteps: [100, 125, 200], // Daftar Bin Step spesifik yang diijinkan
  binStepPriority: [200, 125, 100], // Urutan prioritas bin step (tertinggi = fee terbesar)
  minBinStep: 100,                  // Minimal bin step
  maxBinStep: 200,                  // Maksimal bin step
  bannedNarratives: ['kanye', 'taylor', 'trump', 'biden', 'kamala', 'justice', 'bags', 'moo deng', 'pesto'], // Kata kunci narasi yang langsung di-reject
  maxTvlMcapRatio: 0.20,        // CE Gate: max rasio TVL/Mcap yang diterima (0.20 = 20%)
  meteoraDiscoveryLimit: 180,  // Cakupan scan discovery pool Meteora per siklus (lebih besar = lebih kecil false NO_POOL)
  noPoolPendingTtlMinutes: 120, // Simpan token lolos gate tapi belum ada exec pool selama N menit untuk recheck
  noPoolReplayLimit: 12,       // Jumlah token pending NO_POOL yang direplay per siklus
  deployChunkMaxBins: 69,      // Maks bins per TX deploy (jaga ukuran paket Solana, depth tetap bisa multi-TX)
  gmgnMinAgeHours: 0,          // Min usia token sejak launch (jam) — diambil dari GMGN created_timestamp
  gmgnMaxAgeHours: 168,        // Max usia token (jam) = 7 hari — diambil dari GMGN created_timestamp
  gmgnRequireKnownAge: false,  // true: token tanpa data usia GMGN langsung ditolak
  // maxPoolAgeHours: Batas usia pool DLMM (jam) — fallback keras 2160 = 90 hari
  // Mencegah "Rules: age=0-0h" di Telegram saat JSON corrupt atau kunci hilang
  maxPoolAgeHours: 2160,       // Default 90 hari (2160 jam) — override via radar.maxPoolAgeHours di user-config.json
  minDailyFeeYieldPct: 1.0,   // Minimum fee/TVL harian (%) agar entry Evil Panda tetap worth it
  minFeeActiveTvlRatio: 0.002, // Minimum fee/active_tvl ratio (dari Meteora Discovery API)

  // Meridian API integration
  publicApiKey: '',              // API key Agent Meridian (set di user-config.json)
  agentMeridianApiUrl: 'https://api.agentmeridian.xyz/api', // Base URL Meridian API
  maxAthDistancePct: 15,         // VETO jika jarak harga ke ATH < 15% (harga > 85% ATH)
  heritageModeEnabled: true, // Aktifkan saringan riwayat sultan
  maxOhlcvStaleMinutes15m: 90, // Maks umur candle 15m sebelum dianggap stale
  maxOhlcvStaleMinutes1h: 180, // Maks umur candle 1h (cadangan HTF)
  minAtrPctForEntry: 2.0,      // Minimal ATR% untuk entry supaya tidak masuk market terlalu flat
  entryGateMode: 'lper_retest',  // lper_retest: close > ST + proximity guard (LPer mode)
  entrySupertrendMaxDistancePct: 5, // Tahan entry jika harga terlalu jauh di atas ST (wait pullback)
  entryRequireVolumeConfirm: true, // Volume candle entry harus >= rata-rata rolling volume
  entryMinVolumeRatio: 1.1,      // Rasio min volume candle vs average volume
  entryVolumeLookbackCandles: 20, // Lookback candle untuk baseline volume
  entryRequireHtfAlignment: true, // Wajib konfirmasi HTF (1h) sebelum entry
  entryHtfAllowNeutral: true,     // HTF boleh NEUTRAL (tetap tolak BEARISH)
  entrySupertrendBreakMinPct: 0,  // Buffer break di atas garis Supertrend 15m (0 = strict close > ST)

  // Position management
  takeProfitFeePct: 5,
  trailingTriggerPct: 3.0,   // Aktifkan trailing TP saat PnL >= X%
  trailingDropPct: 1.5,      // Close kalau PnL turun X% dari peak
  trailingStopPct: 5.0,      // Trailing SL: exit jika PnL turun X% dari High Water Mark
  slippageBps: 150,          // Slippage dalam basis points untuk semua DLMM TX (150 = 1.5%)
  outOfRangeWaitMinutes: 30,
  outOfRangeBinsToClose: 10, // Tutup posisi jika OOR lebih dari N bins
  maxHoldHours: 6,           // Force close position after 6h — dead capital cleanup
  slCircuitBreakerCount: 3,
  slCircuitBreakerWindowMin: 60,
  slCircuitBreakerPauseMin: 60,
  minFeeClaimUsd: 1.0,
  maxILvsHodlPct: 5,         // Batas maksimal underperform LP vs HODL sebelum proactive exit
  slCooldownMinutes: 360,    // Cooldown pasca-loss (menit)
  oorAlertIntervalMin: 30,   // Jeda alert OOR agar tidak spam

  // OOR-specific pool cooldown
  oorCooldownTriggerCount: 3, // Setelah N kali OOR close, aktifkan cooldown
  oorCooldownHours: 12,       // Durasi cooldown OOR (jam)

  // Safety
  stopLossPct: 8,
  normalStopLossPct: 10,    // SL % for narrow-range strategies (non-Evil Panda)
  maxNetLossPct: -15,       // Hard floor: max tolerated Net PnL % across all strategies
  panicExitSlippageBps: 750, // Slippage paksa (7.5%) untuk aksi darurat (panic/tvl drain)
  maxDailyDrawdownPct: 6,
  requireConfirmation: true,
  maxDailyPriorityFeeSol: 0.2, // Budget cap harian priority fee + tip (SOL)
  maxTxFailStreak: 8,          // Cooldown trigger jika TX gagal beruntun
  txFailCooldownMinutes: 20,   // Durasi cooldown setelah fail streak tercapai

  // Proactive exit
  proactiveExitEnabled: true,
  proactiveExitMinProfitPct: 1.0,
  proactiveExitBearishConfidence: 0.7,
  evilPandaDisableTrendKillSwitch: true, // Khusus Evil Panda: nonaktifkan kill-switch berbasis trend/supertrend di watchdog
  evilPandaBypassToxicIlGuard: true,      // Khusus Evil Panda: jangan pakai Toxic IL vs HODL sebagai auto-close
  panicOorLossPct: 10,                   // Panic exit OOR jika loss <= -X% (strategi umum)
  evilPandaPanicOorLossPct: 35,          // Panic exit OOR khusus Evil Panda (lebih longgar untuk deep range)
  evilPandaIgnoreZombieFeeWhenOorUpper: true, // Jangan zombie-close Evil Panda saat OOR atas (safe park in SOL)
  oorUpperDistanceMaxPct: 30,            // Jika OOR atas dan jarak ke upper boundary > X%, tutup untuk bebaskan modal
  evilPandaRetracementCapZone1Pct: 4.0,  // Retracement cap watchdog untuk Panda saat pnl<10
  evilPandaRetracementCapZone2Pct: 8.0,  // Retracement cap watchdog untuk Panda saat pnl 10-30
  evilPandaRetracementCapZone3Pct: 12.0, // Retracement cap watchdog untuk Panda saat pnl>=30
  evilPandaBottomToleranceBins: 5,       // Bins below range floor before Evil Panda bin-SL fires
  evilPandaAllowAutoCompound: false,     // Default OFF agar shape deep-range Panda tidak terdistorsi saat harvest
  maxPriceImpactPct: 1.5,     // Maksimal price impact (%) yang diijinkan saat simulasi swap
  maxExitPriceImpactPct: 5.0, // Hard gate close: abort exit jika estimasi swap impact > X%
  maxLpDominancePct: 20,      // Max % dari pool TVL yang boleh dimiliki bot — cegah jadi LP dominan
  maxBinsPerPosition: 125,   // Kapasitas bin maksimal sesuai skema (80-125)
  activePreset: 'supertrend_only', // Mode keputusan: supertrend_only
  activeStrategy: 'Evil Panda', // Active BASELINE strategy
  targetRangePct: 90.0,      // Goal: Deep Jaring 90% Range (Hukum 2)

  // Darwinian Signal Weighting — dari 263 closed positions
  // Higher weight = stronger predictor of profitable positions
  darwinWindowDays: 60,    // Sliding window hari untuk recalibration
  darwinRecalcEvery: 5,    // Recalibrate setiap N posisi ditutup
  signalWeights: {
    mcap: 2.5,              // Maxed out — strong predictor
    feeActiveTvlRatio: 2.3, // Strong predictor
    volume: 0.36,           // Near floor — useless predictor
    holderCount: 0.3,       // Floor — useless predictor
  },

  // Coin selection thresholds (USD, via GeckoTerminal + DexScreener)
  minMcap: 250000,           // Min market cap ($) — null data → skip
  maxMcap: 0,                // Max market cap ($, 0 = disabled)
  minVolume24h: 1000000,     // Min 24h volume ($) — hard floor strategi GMGN pre-filter

  // Strategy-specific tuning. Base identity is 'Evil Panda Master'.
  strategyOverrides: {
    'Evil Panda': {
      exit: {
        maxHoldHours: 72,     // Deep net (-94%) needs 3 days to catch price — never close prematurely
        takeProfitPct: 15,    // Wide net needs room to breathe before locking profit
      },
    },
  },

  // Meridian Integration & Evolution
  autonomousEvolutionEnabled: true,
  lastEvolutionTradeCount: 0,
  evolveIntervalTrades: 5,        // Recalibrate after every N closed trades
  useSocialSignals: true,          // Enable Meridian Discord/KOL signals
  socialSignalWeight: 1.5,        // Multiplier for Darwinian Score if social signal exists
  minSmartMoneyOverlap: 1,        // Minimum overlapping "SmartWallets" to boost confidence
  useSmartWalletRanges: true,     // Mirror Top LPer ranges in Healer

  // Adaptive Post-Mortem
  autoPostMortemEnabled: true,     // Enable LLM-based analysis of closed trades

  // Meridian Relay (Experimental)
  lpAgentRelayEnabled: true,
  publicApiKey: null,
  agentMeridianApiUrl: 'https://api.agentmeridian.xyz/api',
  okxApiKey: process.env.OKX_API_KEY || '',
  gmgnMinTotalFeesSol: 30,     // Minimum total fees token (SOL) berdasarkan GMGN
  gmgnTop10HolderMaxPct: 30,   // Reject jika Top 10 holder > X%
  gmgnDevHoldMaxPct: 5,        // Reject jika dev/creator hold > X%
  gmgnInsiderMaxPct: 0,        // Reject jika insider/rat trader > X%
  gmgnBundlerMaxPct: 60,       // Reject jika bundler > X%
  gmgnPhishingMaxPct: 30,      // Reject jika entrapment/phishing proxy > X%
  gmgnRugRatioMax: 0.30,       // Reject jika rug ratio > X (0-1)
  gmgnRugHistoryMissingFailClosed: false, // Jika true, data rug history kosong => reject (strict)
  gmgnWashTradeMaxPct: 35,     // Reject jika wash trading > X%
  gmgnRequireBurnedLp: true,   // Wajib LP burned
  gmgnRequireZeroTax: true,    // Wajib pajak 0/0
  gmgnBlockCto: true,          // Reject CTO coin
  gmgnBlockVamped: true,       // Reject vamped coin/proxy
  gmgnFailClosedCritical: true, // Data critical GMGN missing => reject
  executionRejectNonRefundableFees: true, // Reject pool dengan non-refundable fees
  slippageBps: 100,            // Slippage tolerance dalam basis points (100 = 1%)
  tvlDropPanicThreshold: 0.35, // Panic exit jika TVL turun > 35% dari TVL saat entry

  // Professional Yield & IQ Suite
  autoHarvestEnabled: true,      // Aktifkan penarikan profit otomatis tanpa tutup posisi
  autoHarvestThresholdSol: 0.1, // Threshold fee (SOL) untuk memicu harvest otomatis
  harvestEstimatedGasSol: 0.005, // Estimasi biaya gas harvest (SOL) untuk profit-vs-gas guard
  enableSimulationShield: true,  // Aktifkan pengecekan simulasi ketat sebelum eksekusi
  hourlyPulseEnabled: true,      // Kirim laporan ringkas setiap jam ke Telegram
  minTaConfidenceForAutoExit: 0.55, // Minimal confidence TA untuk trigger auto-exit berbasis trend
  oracleMaxPriceDivergencePct: 3.0, // Maks divergence Dex vs Jupiter sebelum data ditandai risky
  minPriceSourcesForEntry: 2, // Minimum sumber harga yang valid untuk entry otomatis
  failSafeModeOnDataUnreliable: true, // Blok entry baru jika quality oracle tidak reliable
  minTaeSamplesForFullStage: 10, // Minimum sample exit sebelum stage full dianggap matang
  minTaeWinRateForFullStage: 45, // Minimum win rate (%) exit tracker untuk lolos gate stage full
  requireSignalReportForLive: true, // Wajib ada rapor akurasi sinyal sebelum live deploy
  signalReportMaxAgeHours: 24,      // Maks umur report akurasi sinyal
  signalReportPath: 'data/signal-accuracy-report.json',
  signalAutoRefreshEnabled: true,   // Auto-refresh rapor sinyal dari dalam bot (tanpa cron eksternal)
  signalAutoRefreshIntervalMin: 180, // Jeda minimum antar auto-refresh rapor sinyal
  signalAutoRefreshFailureLimit: 3, // Jika gagal beruntun >= limit, entry baru diblokir
  signalAutoRefreshInputs: '/tmp/candles/batch1.json,/tmp/candles/batch2.json', // Input default untuk generator rapor
  signalConservativeMaxPositions: 1, // Batas posisi saat mode konservatif karena rapor sinyal bermasalah
};

const KNOWN_CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

// Bounds for AI-driven config updates — prevent AI from setting dangerous values
const CONFIG_BOUNDS = {
  deployAmountSol: { min: 0.01, max: 50 },
  maxPositions: { min: 1, max: 20 },
  minSolToOpen: { min: 0.01, max: 1 },
  gasReserve: { min: 0.01, max: 0.5 },
  managementIntervalMin: { min: 1, max: 1440 },
  screeningIntervalMin: { min: 5, max: 1440 },
  positionUpdateIntervalMin: { min: 1, max: 1440 },
  maxPoolAgeDays: { min: 0.1, max: 365 },
  minOrganic: { min: 0, max: 100 },
  minBinStep: { min: 1, max: 400 },
  gmgnMinTotalFeesSol: { min: 0, max: 1000000 },
  gmgnTop10HolderMaxPct: { min: 0, max: 100 },
  gmgnDevHoldMaxPct: { min: 0, max: 100 },
  gmgnInsiderMaxPct: { min: 0, max: 100 },
  gmgnBundlerMaxPct: { min: 0, max: 100 },
  gmgnPhishingMaxPct: { min: 0, max: 100 },
  gmgnRugRatioMax: { min: 0, max: 1 },
  gmgnRugHistoryMissingFailClosed: { type: 'boolean' },
  gmgnWashTradeMaxPct: { min: 0, max: 100 },
  gmgnRequireBurnedLp: { type: 'boolean' },
  gmgnRequireZeroTax: { type: 'boolean' },
  gmgnBlockCto: { type: 'boolean' },
  gmgnBlockVamped: { type: 'boolean' },
  gmgnFailClosedCritical: { type: 'boolean' },
  executionRejectNonRefundableFees: { type: 'boolean' },
  minDailyFeeYieldPct: { min: 0, max: 20 },
  heritageModeEnabled: { type: 'boolean' },
  dryRun: { type: 'boolean' },
  autonomyMode: { type: 'string' },
  deploymentStage: { type: 'string' },
  canaryMaxPositions: { min: 1, max: 20 },
  autoPauseOnManualReview: { type: 'boolean' },
  manualReviewPauseThreshold: { min: 1, max: 50 },
  takeProfitFeePct: { min: 0.1, max: 100 },
  trailingTriggerPct: { min: 0.5, max: 50 },
  trailingDropPct: { min: 0.1, max: 20 },
  outOfRangeWaitMinutes: { min: 1, max: 1440 },
  outOfRangeBinsToClose: { min: 1, max: 200 },
  maxHoldHours: { min: 1, max: 168 },
  slCircuitBreakerCount: { min: 2, max: 20 },
  slCircuitBreakerWindowMin: { min: 5, max: 1440 },
  slCircuitBreakerPauseMin: { min: 5, max: 1440 },
  oorCooldownTriggerCount: { min: 1, max: 20 },
  oorCooldownHours: { min: 1, max: 168 },
  minFeeClaimUsd: { min: 0.01, max: 1000 },
  maxILvsHodlPct: { min: 0.5, max: 80 },
  slCooldownMinutes: { min: 0, max: 10080 },
  oorAlertIntervalMin: { min: 1, max: 1440 },
  stopLossPct: { min: 0.1, max: 50 },
  normalStopLossPct: { min: 1, max: 50 },
  maxNetLossPct: { min: -100, max: -1 },
  maxDailyDrawdownPct: { min: 0.5, max: 50 },
  maxDailyPriorityFeeSol: { min: 0.01, max: 10 },
  maxTxFailStreak: { min: 1, max: 50 },
  txFailCooldownMinutes: { min: 1, max: 720 },
  maxLpDominancePct: { min: 1, max: 100 },
  proactiveExitMinProfitPct: { min: 0.1, max: 100 },
  proactiveExitBearishConfidence: { min: 0.5, max: 1.0 },
  evilPandaDisableTrendKillSwitch: { type: 'boolean' },
  evilPandaBypassToxicIlGuard: { type: 'boolean' },
  panicOorLossPct: { min: 1, max: 100 },
  evilPandaPanicOorLossPct: { min: 1, max: 100 },
  evilPandaIgnoreZombieFeeWhenOorUpper: { type: 'boolean' },
  oorUpperDistanceMaxPct: { min: 0, max: 500 },
  evilPandaRetracementCapZone1Pct: { min: 0.5, max: 30 },
  evilPandaRetracementCapZone2Pct: { min: 0.5, max: 30 },
  evilPandaRetracementCapZone3Pct: { min: 0.5, max: 30 },
  evilPandaBottomToleranceBins: { min: 0, max: 50 },
  evilPandaAllowAutoCompound: { type: 'boolean' },
  darwinWindowDays: { min: 7, max: 365 },
  darwinRecalcEvery: { min: 1, max: 50 },
  minMcap: { min: 0, max: 100000000 },
  maxMcap: { min: 0, max: 10000000000 },
  minVolume24h: { min: 0, max: 1000000000 },
  evolveIntervalTrades: { min: 1, max: 100 },
  socialSignalWeight: { min: 1.0, max: 5.0 },
  minSmartMoneyOverlap: { min: 0, max: 10 },
  maxPriceImpactPct: { min: 0.1, max: 5 },
  maxExitPriceImpactPct: { min: 0.1, max: 20 },
  maxBinsPerPosition: { min: 20, max: 150 },
  maxOhlcvStaleMinutes15m: { min: 5, max: 720 },
  maxOhlcvStaleMinutes1h: { min: 15, max: 1440 },
  minAtrPctForEntry: { min: 0, max: 20 },
  entryGateMode: { type: 'string' },
  entrySupertrendMaxDistancePct: { min: 0.1, max: 20 },
  entryRequireVolumeConfirm: { type: 'boolean' },
  entryMinVolumeRatio: { min: 0.5, max: 5 },
  entryVolumeLookbackCandles: { min: 5, max: 200 },
  entryRequireHtfAlignment: { type: 'boolean' },
  entryHtfAllowNeutral: { type: 'boolean' },
  entrySupertrendBreakMinPct: { min: 0, max: 5 },
  dailyLossLimitUsd: { min: 0, max: 1000 },
  allowedBinSteps: { type: 'array' }, // Custom handling logic in updateConfig
  bannedNarratives: { type: 'array' }, // Custom handling logic in updateConfig
  maxTvlMcapRatio: { min: 0.01, max: 1.0 },
  meteoraDiscoveryLimit: { min: 50, max: 500 },
  noPoolPendingTtlMinutes: { min: 5, max: 720 },
  noPoolReplayLimit: { min: 0, max: 100 },
  deployChunkMaxBins: { min: 20, max: 69 },
  gmgnMinAgeHours: { min: 0, max: 720 },
  gmgnMaxAgeHours: { min: 1, max: 720 },
  gmgnRequireKnownAge: { type: 'boolean' },
  // maxPoolAgeHours: wajib > 0, fallback keras 2160 ditegakkan di getConfig()
  maxPoolAgeHours: { min: 1, max: 87600 }, // 1 jam s/d 10 tahun

  // Professional Suite Bounds
  autoHarvestThresholdSol: { min: 0.005, max: 1.0 },
  harvestEstimatedGasSol: { min: 0.0005, max: 0.05 },
  autoHarvestEnabled: { type: 'boolean' },
  enableSimulationShield: { type: 'boolean' },
  hourlyPulseEnabled: { type: 'boolean' },
  minTaConfidenceForAutoExit: { min: 0.1, max: 0.95 },
  oracleMaxPriceDivergencePct: { min: 0.5, max: 25.0 },
  minPriceSourcesForEntry: { min: 1, max: 3 },
  failSafeModeOnDataUnreliable: { type: 'boolean' },
  minTaeSamplesForFullStage: { min: 0, max: 1000 },
  minTaeWinRateForFullStage: { min: 0, max: 100 },
  requireSignalReportForLive: { type: 'boolean' },
  signalReportMaxAgeHours: { min: 1, max: 168 },
  signalReportPath: { type: 'string' },
  signalAutoRefreshEnabled: { type: 'boolean' },
  signalAutoRefreshIntervalMin: { min: 5, max: 1440 },
  signalAutoRefreshFailureLimit: { min: 1, max: 20 },
  signalAutoRefreshInputs: { type: 'string' },
  signalConservativeMaxPositions: { min: 1, max: 20 },
  
  lastEvolutionTradeCount: { min: 0, max: 1000000 },
  okxApiKey: { type: 'string' },
  slippageBps: { min: 10, max: 1000 },
  tvlDropPanicThreshold: { min: 0.1, max: 0.9 },
  panicExitSlippageBps: { min: 100, max: 2000 },
  managementModel: { type: 'string' },
  hunterModel: { type: 'string' },
  activePreset: { type: 'string' },
};

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('⚠️ [config] GAGAL MEMBACA user-config.json (Syntax Error):', e.message);
    console.error('Bot akan menggunakan nilai DEFAULT sementara. Periksa tanda koma/kutip di file Bos!');
    return {};
  }
}

function loadUserConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return safeParseJSON(readFileSync(CONFIG_PATH, 'utf-8'));
}

export function getConfig() {
  const user = loadUserConfig();
  const merged = {
    ...DEFAULTS,
    ...user,
    signalWeights: {
      ...DEFAULTS.signalWeights,
      ...(user.signalWeights || {}),
    },
  };

  // Lenient numeric parsing — strips trailing units ("1.5 SOL" → 1.5)
  // Rejects ambiguous multi-dot strings ("1.5.0") to prevent silent errors.
  for (const key of Object.keys(merged)) {
    if (typeof DEFAULTS[key] === 'number' && typeof merged[key] === 'string') {
      const trimmed = merged[key].trim();
      const clean = trimmed.replace(/[^-0-9.]/g, '');
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

  // Pure flat failsafe — maxPoolAgeHours tidak boleh 0 atau NaN
  merged.maxPoolAgeHours = (Number(merged.maxPoolAgeHours) > 0) ? Number(merged.maxPoolAgeHours) : 2160;

  return merged;
}

export function isConfigKeySupported(key) {
  return KNOWN_CONFIG_KEYS.has(key);
}

export function updateConfig(updates) {
  // Validate each field against bounds before saving
  const validated = {};
  const rejected = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!isConfigKeySupported(key)) {
      rejected.push(`${key}: unsupported key`);
      continue;
    }

    const bounds = CONFIG_BOUNDS[key];
    if (key === 'signalWeights') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejected.push(`${key}: must be an object`);
        continue;
      }
      validated[key] = {
        ...getConfig().signalWeights,
        ...value,
      };
      continue;
    }

    if (key === 'allowedBinSteps') {
      if (!Array.isArray(value)) {
        rejected.push(`${key}: must be an array`);
        continue;
      }
      validated[key] = value.map(v => parseInt(v)).filter(v => !isNaN(v));
      continue;
    }

    if (key === 'bannedNarratives') {
      if (!Array.isArray(value)) {
        rejected.push(`${key}: must be an array`);
        continue;
      }
      validated[key] = value.map(v => String(v).toLowerCase().trim()).filter(Boolean);
      continue;
    }

    if (key === 'strategyOverrides') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rejected.push(`${key}: must be an object`);
        continue;
      }
      validated[key] = {
        ...getConfig().strategyOverrides,
        ...value,
      };
      continue;
    }

    if (key === 'deploymentStage') {
      const stage = String(value || '').toLowerCase();
      const allowed = ['shadow', 'canary', 'full'];
      if (!allowed.includes(stage)) {
        rejected.push(`${key}: must be one of ${allowed.join(', ')}`);
        continue;
      }
      validated[key] = stage;
      continue;
    }

    if (key === 'autonomyMode') {
      const mode = String(value || '').toLowerCase();
      const allowed = ['active', 'paused'];
      if (!allowed.includes(mode)) {
        rejected.push(`${key}: must be one of ${allowed.join(', ')}`);
        continue;
      }
      validated[key] = mode;
      continue;
    }

    if (bounds?.type === 'object') {
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        rejected.push(`${key}: must be an object or null`);
        continue;
      }
      validated[key] = value;
      continue;
    }

    if (bounds && typeof value === 'number') {
      if (value < bounds.min || value > bounds.max) {
        rejected.push(`${key}: ${value} (allowed: ${bounds.min}-${bounds.max})`);
        continue;
      }
    }
    validated[key] = value;
  }

  if (rejected.length > 0) {
    console.warn('⚠️ Config updates rejected (out of bounds):', rejected.join(', '));
  }

  if (Object.keys(validated).length === 0) return getConfig();

  const current = loadUserConfig();
  const merged = { ...current, ...validated };
  if (validated.signalWeights) {
    merged.signalWeights = {
      ...DEFAULTS.signalWeights,
      ...(current.signalWeights || {}),
      ...validated.signalWeights,
    };
  }
  if (validated.strategyOverrides) {
    merged.strategyOverrides = {
      ...DEFAULTS.strategyOverrides,
      ...(current.strategyOverrides || {}),
      ...validated.strategyOverrides,
    };
  }
  writeFileSync(CONFIG_PATH, stringify(merged, 2));
  console.log('✅ Config updated:', Object.keys(validated).join(', '));
  return getConfig();
}

export function getThresholds() {
  const cfg = getConfig();
  return {
    minVolume24h: cfg.minVolume24h,
    minOrganic: cfg.minOrganic,
    takeProfitFeePct: cfg.takeProfitFeePct,
    outOfRangeWaitMinutes: cfg.outOfRangeWaitMinutes,
    minFeeClaimUsd: cfg.minFeeClaimUsd,
  };
}

export function isDryRun() {
  return getConfig().dryRun === true;
}

/**
 * Resolve entry capacity based on deployment stage.
 * Returns a deterministic capacity decision used by runtime guards.
 */
export function getEntryCapacity(cfg = getConfig(), maxPositionsOverride = null) {
  const stage = String(cfg?.deploymentStage || 'full').toLowerCase();
  if (stage === 'shadow') {
    return {
      blocked: true,
      reason: 'Entry diblokir karena deploymentStage=shadow.',
      stage,
      stageMaxPositions: 0,
      maxPositions: 0,
    };
  }

  const stageMaxPositions = stage === 'canary'
    ? Math.min(cfg.maxPositions, Math.max(1, Number(cfg.canaryMaxPositions || 1)))
    : cfg.maxPositions;
  const requestedMax = Number.isFinite(maxPositionsOverride)
    ? Math.max(1, Math.floor(maxPositionsOverride))
    : stageMaxPositions;

  return {
    blocked: false,
    reason: null,
    stage,
    stageMaxPositions,
    maxPositions: Math.min(requestedMax, stageMaxPositions),
  };
}
