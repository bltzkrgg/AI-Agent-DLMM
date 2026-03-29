import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig, getThresholds } from '../config.js';
import { getTopPools, getPoolInfo, openPosition } from '../solana/meteora.js';
import { getWalletBalance } from '../solana/wallet.js';
import { getOpenPositions, getPoolStats } from '../db/database.js';
import { getLessonsContext } from '../learn/lessons.js';
import { getAllStrategies, parseStrategyParameters } from '../strategies/strategyManager.js';
import { checkMaxDrawdown, validateStrategyForMarket, requestConfirmation } from '../safety/safetyManager.js';
import { matchStrategyToMarket, getLibraryStats } from '../market/strategyLibrary.js';
import { getMarketSnapshot, getOKXData, getOHLCV } from '../market/oracle.js';
import { getInstinctsContext } from '../market/memory.js';
import { getStrategyIntelligenceContext } from '../market/strategyPerformance.js';
import { screenToken, formatScreenResult } from '../market/coinfilter.js';
import { parseTvl } from '../utils/safeJson.js';
import { kv, hr, codeBlock, shortAddr } from '../utils/table.js';
import { calcDynamicRangePct } from '../market/taIndicators.js';

// ─── State ───────────────────────────────────────────────────────

let lastCandidates = [];
let lastReport = null;
let hunterNotifyFn = null;
let hunterBotRef = null;
let hunterAllowedId = null;

export function getCandidates() { return lastCandidates; }
export function getLastHunterReport() { return lastReport; }

// ─── Darwinian Scoring ───────────────────────────────────────────
// Weights dari 263 closed positions:
//   mcap: 2.5x (strong predictor)  |  fee/TVL: 2.3x (strong)
//   volume: 0.36x (near floor)     |  holderCount: 0.3x (floor/useless)

function calculateDarwinScore(pool, weights) {
  const w = weights || { mcap: 2.5, feeActiveTvlRatio: 2.3, volume: 0.36, holderCount: 0.3 };
  let score = 0;

  // fee/TVL ratio (2.3x) — strong predictor
  const tvl  = pool.liquidityRaw || pool.tvl || 0;
  const fees = pool.fees24hRaw   || 0;
  if (tvl > 0 && fees > 0) {
    const ratio      = fees / tvl;
    const ratioScore = Math.min(ratio / 0.05, 2.0) / 2.0; // 5% ratio = max 1.0
    score += ratioScore * w.feeActiveTvlRatio;
  }

  // volume (0.36x) — near floor, de-emphasize
  const vol = pool.volume24hRaw || 0;
  if (vol > 0) {
    score += Math.min(vol / 500000, 1.0) * w.volume;
  }

  // mcap proxy via TVL (2.5x) — strong predictor
  if (tvl > 0) {
    const mcapScore = tvl < 10000 ? 0.2 : tvl < 50000 ? 0.5 : tvl < 100000 ? 0.8 : 1.0;
    score += mcapScore * w.mcap;
  }

  // holderCount (0.3x) — useless, static contribution
  score += 0.3 * w.holderCount;

  return parseFloat(score.toFixed(4));
}

// ─── Tools ───────────────────────────────────────────────────────

const HUNTER_TOOLS = [
  {
    name: 'screen_pools',
    description: 'Screen pool Meteora DLMM terbaik berdasarkan threshold yang dikonfigurasi',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Jumlah kandidat (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_pool_detail',
    description: 'Ambil detail pool + rekomendasi strategi berdasarkan kondisi market saat ini',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'screen_token',
    description: 'WAJIB sebelum deploy. Filter token via 7-step Coin Filter: narrative, price health, holder check, token safety (DexScreener, BirdEye, OKX).',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string' },
        token_name: { type: 'string' },
        token_symbol: { type: 'string' },
      },
      required: ['token_mint'],
    },
  },
  {
    name: 'get_wallet_status',
    description: 'Cek balance wallet dan jumlah posisi terbuka saat ini',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_okx_signal',
    description: 'Cek OKX smart money signal untuk token tertentu. Gunakan untuk cross-reference kandidat — SM masih holding = conviction tinggi, SM sudah jual = skip.',
    input_schema: {
      type: 'object',
      properties: {
        token_mint: { type: 'string' },
      },
      required: ['token_mint'],
    },
  },
  {
    name: 'get_pool_memory',
    description: 'Cek histori deploy sebelumnya di pool ini — win rate, avg PnL, range efficiency, close reason dominan. Gunakan sebelum deploy untuk hindari pool dengan histori buruk.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address: { type: 'string' },
      },
      required: ['pool_address'],
    },
  },
  {
    name: 'deploy_position',
    description: 'Deploy likuiditas ke pool. Jumlah token dihitung otomatis dari strategi dan config. Hanya boleh dipanggil setelah screen_token verdict PASS atau CAUTION.',
    input_schema: {
      type: 'object',
      properties: {
        pool_address:  { type: 'string' },
        strategy_name: { type: 'string', description: 'Nama strategi dari Strategy Library' },
        reasoning:     { type: 'string', description: 'Alasan memilih pool dan strategi ini (DLMM-specific: fee APR, range fit, volatilitas)' },
      },
      required: ['pool_address', 'reasoning'],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────

async function executeTool(name, input) {
  const cfg = getConfig();

  switch (name) {

    case 'screen_pools': {
      const limit = input.limit || 10;
      const pools = await getTopPools(limit * 3); // fetch lebih banyak, filter setelahnya
      const thresholds = getThresholds();
      const weights = cfg.signalWeights || { mcap: 2.5, feeActiveTvlRatio: 2.3, volume: 0.36, holderCount: 0.3 };

      const filtered = pools
        .filter(p => {
          const tvl = parseTvl(p.tvlStr || p.tvl || 0);
          const fees = p.fees24hRaw || 0;
          const feeRatio = tvl > 0 ? fees / tvl : 0;
          const binStep = p.binStep || 0;

          return (
            binStep > 0 &&
            binStep <= 250 &&                                    // Batas bin step
            tvl >= thresholds.minTvl &&
            tvl <= thresholds.maxTvl &&
            feeRatio >= thresholds.minFeeActiveTvlRatio
          );
        })
        .map(p => ({
          ...p,
          darwinScore:     calculateDarwinScore(p, weights),
          feeToTvlRatio:   (() => {
            const tvl = parseTvl(p.tvlStr || p.tvl || 0);
            return tvl > 0 ? ((p.fees24hRaw || 0) / tvl).toFixed(4) : '0';
          })(),
        }))
        .sort((a, b) => b.darwinScore - a.darwinScore)
        .slice(0, limit);

      lastCandidates = filtered;
      return JSON.stringify({
        thresholds,
        filterCriteria: { maxBinStep: 250, minFeeActiveTvlRatio: thresholds.minFeeActiveTvlRatio },
        darwinWeights: weights,
        note: 'Sorted by darwinScore. Prioritaskan mcap proxy (TVL) dan fee/TVL — volume & holders adalah weak signals.',
        candidates: filtered,
      }, null, 2);
    }

    case 'get_pool_detail': {
      const info = await getPoolInfo(input.pool_address);
      let strategyMatch = null;
      let dlmmSnapshot = null;
      try {
        dlmmSnapshot = await getMarketSnapshot(info.tokenX, input.pool_address);
        strategyMatch = matchStrategyToMarket(dlmmSnapshot);
      } catch { /* optional */ }

      const pool = dlmmSnapshot?.pool;
      const price = dlmmSnapshot?.price;

      return JSON.stringify({
        poolInfo: info,
        dlmmEconomics: pool ? {
          feeApr:         `${pool.feeApr}% (${pool.feeAprCategory})`,
          feeVelocity:    pool.feeVelocity,
          feeTvlRatioPct: `${(pool.feeTvlRatio * 100).toFixed(3)}%/hari`,
          tvl:            pool.tvl,
          volume24h:      pool.volume24h,
          healthScore:    dlmmSnapshot?.healthScore,
          eligible:       pool.feeAprCategory !== 'LOW' && pool.feeTvlRatio > 0.01,
        } : null,
        priceContext: price ? {
          trend:              price.trend,
          volatility:         `${price.volatility24h}% (${price.volatilityCategory})`,
          binStepFit:         info.binStep >= price.suggestedBinStepMin ? 'OK' : `⚠️ Butuh bin step ≥${price.suggestedBinStepMin}`,
          buyPressure:        `${price.buyPressurePct}% (${price.sentiment})`,
        } : null,
        taSignals: dlmmSnapshot?.ta ? {
          rsi14:          dlmmSnapshot.ta.rsi14,
          rsi2:           dlmmSnapshot.ta.rsi2,
          supertrend:     dlmmSnapshot.ta.supertrend,
          evilPandaEntry: dlmmSnapshot.ta.evilPanda?.entry ?? null,
          evilPandaExit:  dlmmSnapshot.ta.evilPanda?.exit  ?? null,
          bb:             dlmmSnapshot.ta.bb,
          macd:           dlmmSnapshot.ta.macd
            ? { histogram: dlmmSnapshot.ta.macd.histogram, firstGreenAfterRed: dlmmSnapshot.ta.macd.firstGreenAfterRed }
            : null,
          dataSource:     dlmmSnapshot.dataSource,
        } : null,
        strategyRecommendation: strategyMatch ? {
          recommended:     strategyMatch.recommended?.name,
          confidence:      strategyMatch.recommended?.matchScore,
          entryConditions: strategyMatch.recommended?.entryConditions,
          exitConditions:  strategyMatch.recommended?.exitConditions,
          alternatives:    strategyMatch.alternatives?.map(s => s.name),
        } : null,
        deployToken: {
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          isSOL: true,
          note: 'Bot hanya menyimpan SOL — semua deploy adalah Single-Side SOL (tokenX=0, tokenY=SOL)',
        },
        validStrategyNames: ['Single-Side SOL', 'Evil Panda', 'Spot Balanced', 'Bid-Ask Wide', 'Single-Side Token X', 'Curve Concentrated'],
      }, null, 2);
    }

    case 'screen_token': {
      const result = await screenToken(
        input.token_mint,
        input.token_name || '',
        input.token_symbol || ''
      );
      if (result.verdict === 'AVOID' && hunterNotifyFn) {
        await hunterNotifyFn(`🚫 *Token Ditolak Coin Filter*\n\n${formatScreenResult(result)}`);
      }
      return JSON.stringify({
        verdict:         result.verdict,
        eligible:        result.eligible,
        highFlags:       result.highFlags.map(f => f.msg),
        mediumFlags:     result.mediumFlags.map(f => f.msg),
        gmgnAvailable:   result.gmgnAvailable,
        gmgn:            result.gmgnAvailable ? result.gmgnData : null,
        jupiterStrict:   result.jupiterData?.isStrict   || false,
        jupiterVerified: result.jupiterData?.isVerified || false,
        jupiterPrice:    result.jupiterData?.priceUsd   || null,
        // Instruksi tegas untuk agent
        action: result.verdict === 'AVOID'
          ? 'SKIP — cari kandidat lain'
          : 'LANJUT DEPLOY — jumlah token dihitung otomatis',
      }, null, 2);
    }

    case 'get_wallet_status': {
      const balance = await getWalletBalance();
      const openPos = getOpenPositions();
      return JSON.stringify({
        solBalance: balance,
        openPositions: openPos.length,
        maxPositions: cfg.maxPositions,
        canOpen: parseFloat(balance) >= (cfg.deployAmountSol + (cfg.gasReserve ?? 0.02)) && openPos.length < cfg.maxPositions,
        requiredSol: parseFloat((cfg.deployAmountSol + (cfg.gasReserve ?? 0.02)).toFixed(4)),
      }, null, 2);
    }

    case 'get_okx_signal': {
      if (!process.env.OKX_API_KEY) {
        return JSON.stringify({ available: false, reason: 'OKX_API_KEY not set — skip signal check' }, null, 2);
      }
      const okx = await getOKXData(input.token_mint);
      if (!okx?.available) {
        return JSON.stringify({ available: false, reason: 'OKX data tidak tersedia untuk token ini' }, null, 2);
      }
      const verdict = okx.smartMoneySelling === true
        ? 'SKIP — smart money sudah jual, potensi dump'
        : okx.smartMoneyBuying === true
        ? 'STRONG — smart money masih akumulasi, conviction tinggi'
        : 'NEUTRAL — tidak ada sinyal smart money yang kuat';
      return JSON.stringify({
        available:          true,
        smartMoneyBuying:   okx.smartMoneyBuying,
        smartMoneySelling:  okx.smartMoneySelling,
        smartMoneySignal:   okx.smartMoneySignal,
        signalStrength:     okx.signalStrength,
        isHoneypot:         okx.isHoneypot,
        riskLevel:          okx.riskLevel,
        dlmmNote:           okx.dlmmNote,
        verdict,
      }, null, 2);
    }

    case 'get_pool_memory': {
      const stats = getPoolStats(input.pool_address);
      if (!stats) {
        return JSON.stringify({ firstTime: true, message: 'Belum pernah deploy ke pool ini.' }, null, 2);
      }
      const verdict = stats.winRate < 40
        ? 'HINDARI — win rate rendah, histori buruk di pool ini'
        : stats.winRate < 60
        ? 'HATI-HATI — win rate di bawah rata-rata'
        : 'OK — histori positif di pool ini';
      return JSON.stringify({ ...stats, verdict }, null, 2);
    }

    case 'deploy_position': {
      // Safety: max drawdown check
      const drawdown = checkMaxDrawdown();
      if (drawdown.triggered) {
        return JSON.stringify({ blocked: true, reason: drawdown.reason }, null, 2);
      }

      // ── Auto-calculate position sizing ───────────────────────
      // Bot hanya punya SOL — selalu Single-Side SOL (tokenX=0, tokenY=full)
      const deployAmountSol = cfg.deployAmountSol || 0.1;
      const tokenXAmount    = 0;
      const tokenYAmount    = deployAmountSol;

      // Ambil pool info untuk harga dan validasi
      const poolInfo = await getPoolInfo(input.pool_address);

      // ── Guard: hanya deploy ke pool TOKEN/SOL ────────────────
      const WSOL_MINT = 'So11111111111111111111111111111111111111112';
      if (poolInfo.tokenY !== WSOL_MINT) {
        return JSON.stringify({
          blocked: true,
          reason: `Pool tokenY bukan WSOL (${poolInfo.tokenYSymbol || poolInfo.tokenY?.slice(0,8)}) — bot hanya deploy ke pool TOKEN/SOL. Skip pool ini.`,
        }, null, 2);
      }

      // ── Strategy resolution — name dari LLM bisa salah, resolve by type ──
      const allStrategies = getAllStrategies();
      // 1. Cari exact match dulu
      // 2. Fallback: jika LLM kirim nama invalid (mis. "Single-Side USDC"), cari by type single_side_y
      // 3. Last resort: strategy pertama yang single_side_y
      const strategy =
        allStrategies.find(s => s.name === input.strategy_name) ||
        allStrategies.find(s => s.name === 'Single-Side SOL') ||
        allStrategies.find(s => s.type === 'single_side_y') ||
        allStrategies[0];
      const stratParams = strategy ? parseStrategyParameters(strategy) : { priceRangePercent: 5 };
      const strategyType = strategy?.strategy_type || 'spot';

      // ── Dynamic range — ATR + volatility + trend + BB ────────────
      // Replaces static priceRangePercent from strategy config
      let priceRangePct = stratParams.priceRangePercent || 10;
      try {
        const ohlcv = await getOHLCV(poolInfo.tokenX, input.pool_address);
        if (ohlcv) {
          const epType = (strategy?.type === 'evil_panda' || strategy?.name === 'Evil Panda')
            ? 'evil_panda' : 'single_side_y';
          priceRangePct = calcDynamicRangePct({
            atr14Pct:    ohlcv.atr14?.atrPct     ?? 0,
            range24hPct: ohlcv.range24hPct        ?? 0,
            trend:       ohlcv.trend              ?? 'SIDEWAYS',
            bbBandwidth: ohlcv.ta?.bb?.bandwidth  ?? 0,
            strategyType: epType,
          });
        }
      } catch { /* fallback to static */ }

      // Validate strategy vs pool conditions (volatilitas vs bin step)
      let validation = { valid: true, warning: null };
      try {
        validation = validateStrategyForMarket(strategyType, poolInfo);
        if (!validation.valid && hunterNotifyFn) {
          await hunterNotifyFn(`⚠️ *Strategy Warning*\n\n${validation.warning}`);
        }
      } catch { /* skip */ }

      // Konfirmasi Telegram
      if (cfg.requireConfirmation && hunterNotifyFn && hunterBotRef && hunterAllowedId) {
        const confirmed = await requestConfirmation(
          hunterNotifyFn,
          hunterBotRef,
          hunterAllowedId,
          `🚀 *Hunter Alpha ingin deploy:*\n\n` +
          `📍 Pool: \`${input.pool_address.slice(0,8)}...\`\n` +
          `📊 Strategi: ${strategy?.name || 'default'}\n` +
          `💰 Deploy: ${deployAmountSol} SOL (Single-Side SOL)\n` +
          `  tokenX: 0 | tokenY: ${tokenYAmount.toFixed(4)} SOL\n\n` +
          `💭 ${input.reasoning}`
        );
        if (!confirmed) {
          return JSON.stringify({ blocked: true, reason: 'Ditolak oleh user.' }, null, 2);
        }
      }

      // Execute with dynamic range
      const result = await openPosition(
        input.pool_address,
        tokenXAmount,
        tokenYAmount,
        priceRangePct,
        strategy?.name || null
      );

      // Notifikasi posisi terbuka dengan detail PnL awal
      if (hunterNotifyFn && result.success) {
        const cfg2 = getConfig();
        const tpTarget = cfg2.takeProfitFeePct ?? 5;
        const slTarget = cfg2.stopLossPct      ?? 5;
        const trailAct = 3.0;

        const details = [
          kv('Posisi',   shortAddr(result.positionAddress, 4, 4), 9),
          kv('Pool',     shortAddr(input.pool_address, 4, 4), 9),
          kv('Strategi', strategy?.name || 'default', 9),
          kv('Deploy',   `${deployAmountSol} SOL (Single-Side)`, 9),
          hr(40),
          kv('Entry',    result.entryPrice?.toFixed(8)  ?? '-', 9),
          kv('Bawah',    `${result.lowerPrice?.toFixed(8) ?? '-'}  (-${priceRangePct}%)`, 9),
          kv('Atas',     `${result.upperPrice?.toFixed(8) ?? '-'}  (entry)`, 9),
          kv('Fee/bin',  `${result.feeRatePct}%`, 9),
          kv('Range',    `${priceRangePct}% (ATR-dynamic)`, 9),
          hr(40),
          kv('TP',       `+${tpTarget}%  Trail: +${trailAct}%  SL: -${slTarget}%`, 9),
        ];

        const openMsg =
          `🚀 *Posisi Dibuka*\n\n` +
          codeBlock(details) + '\n' +
          `💭 _${input.reasoning}_\n\n` +
          `🔗 [Tx](https://solscan.io/tx/${result.txHash})`;

        await hunterNotifyFn(openMsg);
      }

      return JSON.stringify({ ...result, strategyUsed: strategy?.name, reasoning: input.reasoning }, null, 2);
    }

    default:
      return `Tool tidak dikenali: ${name}`;
  }
}

// ─── Main agent loop ─────────────────────────────────────────────

export async function runHunterAlpha(notifyFn, bot = null, allowedId = null) {
  hunterNotifyFn = notifyFn;
  hunterBotRef = bot;
  hunterAllowedId = allowedId;

  const cfg = getConfig();

  // ── Skip silently jika slot posisi penuh ─────────────────────
  const openPos = getOpenPositions();
  if (openPos.length >= cfg.maxPositions) return null;

  // ── Skip silently jika balance tidak cukup ───────────────────
  try {
    const balance = await getWalletBalance();
    if (parseFloat(balance) < (cfg.deployAmountSol + (cfg.gasReserve ?? 0.02))) return null;
  } catch { /* lanjut jika gagal cek balance */ }
  const lessonsCtx = getLessonsContext();
  const instincts = getInstinctsContext();
  const strategyIntel = getStrategyIntelligenceContext();
  const libraryStats = getLibraryStats();

  const systemPrompt = `Kamu adalah Hunter Alpha — autonomous DLMM LP agent untuk Meteora di Solana.

╔══════════════════════════════════════════════════════════════╗
║  MODE AUTONOMOUS — TIDAK ADA INTERAKSI DENGAN USER          ║
║  Kamu HARUS memutuskan dan mengeksekusi SENDIRI.             ║
║  JANGAN tanya jumlah token. JANGAN minta konfirmasi.         ║
║  JANGAN tunggu input siapapun. LANGSUNG pakai tool.          ║
║  Jumlah token sudah dihitung OTOMATIS oleh sistem.           ║
╚══════════════════════════════════════════════════════════════╝

MINDSET: Kamu LP specialist. Profit = FEE, bukan price appreciation.

ALUR KERJA — JALANKAN SAMPAI SELESAI TANPA HENTI:
1. screen_pools → ambil kandidat darwinScore tertinggi
2. get_wallet_status → cek balance & slot (jika penuh/kurang → STOP total)
3. Untuk SETIAP kandidat (urutkan dari score tertinggi):
   a. get_pool_memory → cek histori pool ini
      • verdict = 'HINDARI' (win rate <40%) → SKIP langsung, jangan buang waktu
      • verdict = 'HATI-HATI' → lanjut tapi naikkan threshold keputusan
      • firstTime atau OK → lanjut normal
   b. get_okx_signal → cek smart money untuk token di pool ini
      • verdict = 'SKIP' (SM sudah jual) → SKIP kandidat ini
      • verdict = 'STRONG' (SM masih beli) → prioritaskan kandidat ini
      • verdict = 'NEUTRAL' atau tidak tersedia → lanjut normal
   c. get_pool_detail → baca feeApr, feeVelocity, healthScore, binStep fit
   d. Keputusan DLMM:
      • eligible = false atau feeApr < 30% → SKIP, kandidat berikutnya
      • healthScore < 40 → SKIP
      • binStep tidak sesuai volatilitas → pilih strategi range lebih lebar
   e. screen_token → jalankan Coin Filter
   f. action = 'SKIP' → lanjut kandidat berikutnya
   g. action = 'LANJUT DEPLOY' → LANGSUNG jalankan deploy_position SEKARANG
4. Selesai — laporkan hasil ke user

STRATEGI — BACA LIBRARY, JANGAN HARDCODE:
  get_pool_detail memberikan rekomendasi strategi dari Strategy Library berdasarkan kondisi market saat ini.
  IKUTI rekomendasinya. Jangan otomatis pakai "Single-Side SOL" kalau library rekomendasikan yang lain.

  Panduan matching strategi berdasarkan kondisi pool:
  • Sideways + volatilitas rendah → "Spot Balanced" atau "Curve Concentrated"
  • Volatile + volume tinggi → "Bid-Ask Wide"
  • Uptrend kuat + SM buying + buy pressure >65% → "Single-Side Token X"
  • DEFAULT (market apapun, bot hanya punya SOL) → "Single-Side SOL"

  🐼 EVIL PANDA STRATEGY — aktifkan jika SEMUA syarat terpenuhi (hard gates):
  • Pool bin step 80, 100, atau 125
  • MC/FDV >$250k, Volume24h >$1M
  • taSignals.supertrend.justCrossedAbove === true ← WAJIB, ini trigger utama
  • taSignals.evilPandaEntry.justCrossedAbove === true (konfirmasi)
  • Trend UPTREND berdasarkan price action
  • RugCheck/screen_token PASS (phishing <30%, bundling <60%, insiders <10%, top10 <30%)
  • OKX Smart Money masih buying (jika available — bonus, bukan blocker)
  Jika taSignals.supertrend.justCrossedAbove !== true → JANGAN gunakan Evil Panda, pilih strategi lain.
  Saat Evil Panda aktif: priceRangePercent=15, Single-Side SOL.
  EXIT: Confluence ≥2 sinyal → RSI(2)>90 + BB upper ATAU RSI(2)>90 + MACD first green.

DARWINIAN WEIGHTS:
  TVL (2.5x) + fee/TVL (2.3x) = sinyal kuat. Volume (0.36x) + holders (0.3x) = abaikan.

FILTER TOKEN (dari Coin Filter — DexScreener, RugCheck, Helius, OKX):
  AVOID → SKIP pool. CAUTION/PASS → DEPLOY LANGSUNG.
  RugCheck score & risks tersedia di screen_token — GMGN sudah digantikan RugCheck.

NAMA STRATEGI — WAJIB PERSIS SALAH SATU DARI LIST INI:
  "Single-Side SOL" | "Evil Panda" | "Spot Balanced" | "Bid-Ask Wide" | "Single-Side Token X" | "Curve Concentrated"
  ⚠️ JANGAN pernah tulis "Single-Side USDC", "Single-Side USDT", atau nama lain yang tidak ada di list.
  DEFAULT untuk bot ini (hanya punya SOL) → "Single-Side SOL".
  Nama yang salah akan di-fallback otomatis ke "Single-Side SOL" oleh sistem.

STRATEGY LIBRARY (${libraryStats.totalStrategies} strategi):
${libraryStats.topStrategies.map(s => `  ${s.name} (${s.type}, ${(s.confidence * 100).toFixed(0)}% conf)`).join('\n')}

Mode: 🔴 LIVE | Deploy: ${cfg.deployAmountSol} SOL/posisi
${lessonsCtx}
${instincts}
${strategyIntel}

Gunakan Bahasa Indonesia untuk laporan akhir. Reasoning singkat, action langsung.`;

  const messages = [
    {
      role: 'user',
      content: `Jalankan siklus screening & deployment sekarang. ` +
               `Temukan pool terbaik, filter token, dan deploy LANGSUNG tanpa menunggu input apapun. ` +
               `Mode: LIVE — eksekusi nyata. ` +
               `Deploy ${cfg.deployAmountSol} SOL per posisi, strategi dihitung otomatis.`,
    }
  ];

  let response = await createMessage({
    model: resolveModel(cfg.screeningModel),
    maxTokens: 4096,
    system: systemPrompt,
    tools: HUNTER_TOOLS,
    messages,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await createMessage({
      model: resolveModel(cfg.screeningModel),
      maxTokens: 4096,
      system: systemPrompt,
      tools: HUNTER_TOOLS,
      messages,
    });
  }

  const report = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  lastReport = { report, timestamp: new Date().toISOString() };

  if (notifyFn) await notifyFn(`🦅 *Hunter Alpha Report*\n\n${report}`);
  return report;
}
