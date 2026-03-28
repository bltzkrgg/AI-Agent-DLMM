/**
 * DLMM Oracle — multi-lens data gathering untuk LP decisions
 *
 * Semua signal dikumpulkan dan diinterpretasi dalam konteks DLMM LP,
 * bukan futures trading. Setiap signal punya arti berbeda untuk LP:
 *
 * OHLCV       → arah harga & volatilitas → pilih range width & strategi
 * On-Chain    → whale/holder risk → apakah SOL kamu aman di pool ini?
 * OKX         → smart money flow → orang beli token pakai SOL (bagus untuk single-side SOL)
 * Pool DLMM   → fee APR, velocity, health → apakah pool masih menghasilkan?
 * DexScreener → buy/sell pressure → range bias: atas atau bawah harga saat ini?
 */

import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';

const BIRDEYE_BASE     = 'https://public-api.birdeye.so';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const OKX_BASE         = 'https://www.okx.com/api/v5';
const METEORA_DATAPI   = 'https://dlmm.datapi.meteora.ag';

// ─── 1. OHLCV — untuk range positioning & volatilitas ───────────
// DLMM context:
//   - Trend UPTREND   → harga naik → single-side SOL range bawah akan ter-convert ke token
//   - Trend SIDEWAYS  → harga konsolidasi → spot balanced / single-side SOL ideal
//   - Trend DOWNTREND → harga turun → single-side SOL bisa kena IL berat
//   - Volatilitas tinggi → perlu range lebih lebar (bin step lebih besar)
//   - Support/Resistance → bisa dijadikan batas range atas/bawah

export async function getOHLCV(tokenMint, timeframe = '15m', limit = 50) {
  if (!process.env.BIRDEYE_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&type=${timeframe}&limit=${limit}`,
      { headers: { 'x-chain': 'solana', 'X-API-KEY': process.env.BIRDEYE_API_KEY } },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.data?.items || [];
    if (items.length < 3) return null;

    const closes  = items.map(i => safeNum(i.c));
    const volumes = items.map(i => safeNum(i.v));
    const latest  = items[items.length - 1];
    const prev    = items[items.length - 2];
    const avgVol  = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    const high24h = safeNum(Math.max(...items.slice(-96).map(i => safeNum(i.h))));
    const low24h  = safeNum(Math.min(...items.slice(-96).map(i => safeNum(i.l, Infinity)).filter(v => v !== Infinity)));
    const range24hPct = low24h > 0 ? ((high24h - low24h) / low24h * 100) : 0;

    return {
      tokenMint,
      timeframe,
      currentPrice:   safeNum(latest.c),
      priceChange:    prev?.c ? safeNum(((latest.c - prev.c) / prev.c * 100).toFixed(2)) : 0,
      high24h,
      low24h,
      range24hPct:    parseFloat(range24hPct.toFixed(2)),
      avgVolume:      safeNum(avgVol.toFixed(2)),
      latestVolume:   safeNum(latest.v),
      volumeVsAvg:    avgVol > 0 ? safeNum((safeNum(latest.v) / avgVol).toFixed(2)) : 1,
      trend:          detectTrend(closes),
      support:        safeNum(Math.min(...closes.slice(-20))),
      resistance:     safeNum(Math.max(...closes.slice(-20))),
      // DLMM interpretation
      suggestedBinStepMin: range24hPct > 20 ? 20 : range24hPct > 7 ? 10 : 5,
      volatilityCategory:  range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      dlmmNote: range24hPct > 30
        ? 'Volatilitas ekstrem — gunakan Bid-Ask Wide, hindari Curve Concentrated'
        : range24hPct > 15
        ? 'Volatilitas tinggi — single-side SOL cocok, range perlu lebih lebar'
        : 'Volatilitas normal — single-side SOL atau spot balanced ideal',
    };
  } catch {
    return null;
  }
}

function detectTrend(closes) {
  if (closes.length < 10) return 'SIDEWAYS';
  const recent5  = closes.slice(-5);
  const older5   = closes.slice(-10, -5);
  const recent20 = closes.slice(-20);
  const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const olderAvg  = older5.reduce((a, b) => a + b, 0) / older5.length;
  if (olderAvg === 0) return 'SIDEWAYS';
  const changePct = (recentAvg - olderAvg) / olderAvg * 100;
  const avg20 = recent20.reduce((a, b) => a + b, 0) / recent20.length;
  const aboveAvg = recent5.filter(c => c > avg20).length;
  if (changePct > 2 && aboveAvg >= 4) return 'UPTREND';
  if (changePct < -2 && aboveAvg <= 1) return 'DOWNTREND';
  return 'SIDEWAYS';
}

// ─── 2. On-Chain Signals (Helius) — untuk risk assessment ────────
// DLMM context:
//   - Whale selling massif → SOL kamu akan ter-absorb cepat ke posisi rugi
//   - Top 10 holder tinggi → dump risk → hindari pool dengan token ini
//   - Banyak transaksi recent → token masih aktif diperdagangkan → bagus untuk fee

export async function getOnChainSignals(tokenMint) {
  if (!process.env.HELIUS_API_KEY) {
    return { available: false, reason: 'HELIUS_API_KEY not set' };
  }
  const HELIUS_BASE = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  const birdeyeHeaders = process.env.BIRDEYE_API_KEY
    ? { 'x-chain': 'solana', 'X-API-KEY': process.env.BIRDEYE_API_KEY }
    : { 'x-chain': 'solana' };
  try {
    const [sigRes, holderRes, topHolderRes] = await Promise.allSettled([
      fetchWithTimeout(HELIUS_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [tokenMint, { limit: 20 }],
        }),
      }, 8000),
      fetchWithTimeout(
        `${BIRDEYE_BASE}/defi/token_overview?address=${tokenMint}`,
        { headers: birdeyeHeaders },
        8000
      ),
      fetchWithTimeout(
        `${BIRDEYE_BASE}/defi/token_holder?address=${tokenMint}&offset=0&limit=10`,
        { headers: birdeyeHeaders },
        8000
      ),
    ]);

    const sigs = sigRes.status === 'fulfilled' && sigRes.value.ok
      ? (await sigRes.value.json()).result || [] : [];
    const holderData = holderRes.status === 'fulfilled' && holderRes.value.ok
      ? (await holderRes.value.json()).data : null;
    const topHolders = topHolderRes.status === 'fulfilled' && topHolderRes.value.ok
      ? (await topHolderRes.value.json()).data?.items || [] : [];

    const top10Pct = topHolders.reduce((sum, h) => sum + safeNum(h.percentage), 0);

    return {
      available:     true,
      recentTxCount: sigs.length,
      holders:       holderData?.holder || null,
      marketCap:     holderData?.mc || null,
      top10HolderPct: safeNum(top10Pct.toFixed(2)),
      whaleRisk:     top10Pct > 50 ? 'HIGH' : top10Pct > 30 ? 'MEDIUM' : 'LOW',
      // DLMM context
      dlmmNote: top10Pct > 50
        ? 'Konsentrasi whale TINGGI — dump risk besar, SOL kamu bisa ter-absorb semua kalau whale jual'
        : top10Pct > 30
        ? 'Ada whale — monitor ketat, perlu exit cepat kalau ada dump'
        : 'Distribusi sehat — dump risk rendah, aman untuk LP',
      tokenActive: sigs.length >= 5,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── 3. OKX Smart Money — untuk arah entry & strategi ────────────
// DLMM context:
//   - SM buying token (pakai SOL) → demand tinggi → single-side SOL akan ter-convert
//     ke token cepat (fee terkumpul, tapi SOL habis duluan)
//   - SM selling token → supply tinggi → single-side SOL range bawah akan aktif
//     (orang jual token dapat SOL dari range kamu) → fee terkumpul lama
//   - SM neutral → spot balanced atau single-side SOL ideal

export async function getOKXData(tokenMint) {
  if (!process.env.OKX_API_KEY) {
    return { available: false, reason: 'OKX_API_KEY not set' };
  }
  const chainId = '501'; // Solana
  const headers = { 'OK-ACCESS-KEY': process.env.OKX_API_KEY, 'Content-Type': 'application/json' };
  try {
    const [secRes, smartRes] = await Promise.allSettled([
      fetchWithTimeout(
        `${OKX_BASE}/dex/security/token?chainId=${chainId}&tokenContractAddress=${tokenMint}`,
        { headers }, 8000
      ),
      fetchWithTimeout(
        `${OKX_BASE}/dex/ai-market/token-signal?chainId=${chainId}&tokenAddress=${tokenMint}`,
        { headers }, 8000
      ),
    ]);

    const sec   = (secRes.status   === 'fulfilled' && secRes.value.ok)
      ? (await secRes.value.json().catch(() => ({}))).data?.[0]   || {} : {};
    const smart = (smartRes.status === 'fulfilled' && smartRes.value.ok)
      ? (await smartRes.value.json().catch(() => ({}))).data?.[0] || {} : {};

    const smSignal = smart.signal ?? null;
    const smBuying = smart.smartMoneyBuying ?? null;

    return {
      available: true,
      riskLevel:          sec.riskLevel          ?? null,
      isHoneypot:         sec.isHoneypot          ?? false,
      isMintable:         sec.isMintable          ?? false,
      ownershipRenounced: sec.ownershipRenounced  ?? null,
      smartMoneyBuying:   smBuying,
      smartMoneySelling:  smart.smartMoneySelling ?? null,
      smartMoneySignal:   smSignal,
      signalStrength:     smart.signalStrength    ?? null,
      // DLMM context
      dlmmNote: smBuying === true
        ? 'Smart money BELI token — SOL range kamu akan cepat ter-convert ke token, fee terkumpul tapi SOL habis'
        : smBuying === false
        ? 'Smart money JUAL token — SOL range kamu akan jadi tempat orang jual, fee terkumpul stabil'
        : 'Smart money neutral — single-side SOL atau spot balanced cocok',
      solRangeOutlook: smBuying === true ? 'FAST_CONSUME' : smBuying === false ? 'STABLE_EARNING' : 'NEUTRAL',
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── 4. DLMM Pool Data (Meteora datapi) ─────────────────────────

export async function getDLMMPoolData(poolAddress) {
  try {
    const res = await fetchWithTimeout(
      `${METEORA_DATAPI}/pools/${poolAddress}`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!res.ok) return null;
    const pool = await res.json();

    const fees24h     = safeNum(pool.fees?.['24h']  ?? pool.fees_24h ?? 0);
    const fees7d      = safeNum(pool.fees?.['7d']   ?? pool.fees_7d  ?? 0);
    const volume24h   = safeNum(pool.volume?.['24h'] ?? pool.trade_volume_24h ?? 0);
    const tvl         = safeNum(pool.tvl ?? pool.liquidity ?? 0);
    const feeApr      = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep     = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    const feeAprCategory = feeApr >= 100 ? 'HIGH' : feeApr >= 30 ? 'MEDIUM' : 'LOW';
    const avgDaily7d     = fees7d > 0 ? fees7d / 7 : 0;
    const feeVelocity    =
      avgDaily7d > 0 && fees24h > avgDaily7d * 1.2 ? 'INCREASING' :
      avgDaily7d > 0 && fees24h < avgDaily7d * 0.8 ? 'DECREASING' : 'STABLE';

    return {
      address: poolAddress, name: pool.name || '',
      tvl, volume24h, fees24h,
      feeApr: parseFloat(feeApr.toFixed(2)), feeAprCategory,
      feeTvlRatio: parseFloat(feeTvlRatio.toFixed(4)), feeVelocity,
      binStep,
      tokenXMint: pool.token_x?.address || null,
      tokenYMint: pool.token_y?.address || null,
    };
  } catch { return null; }
}

// ─── 5. DexScreener — buy/sell pressure & range bias ────────────

export async function getSentiment(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];
    const txns = best.txns?.h24 || {};
    const buys = safeNum(txns.buys), sells = safeNum(txns.sells);
    const total = buys + sells;
    const buyPressurePct = total > 0 ? safeNum((buys / total * 100).toFixed(1)) : 50;
    return {
      tokenSymbol:    best.baseToken?.symbol || '',
      priceUsd:       safeNum(best.priceUsd),
      priceChange1h:  safeNum(best.priceChange?.h1),
      priceChange6h:  safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      liquidityUsd:   safeNum(best.liquidity?.usd),
      buys24h: buys, sells24h: sells, buyPressurePct,
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
      // DLMM context
      dlmmNote: buyPressurePct > 65
        ? 'Banyak yang BELI token — range SOL di bawah harga akan cepat habis ter-convert, fee cepat tapi posisi singkat'
        : buyPressurePct < 35
        ? 'Banyak yang JUAL token — single-side SOL ideal, SOL range aktif lama mengumpulkan fee'
        : 'Seimbang — single-side SOL atau spot balanced sama-sama viable',
    };
  } catch { return null; }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [ohlcvR, poolR, onChainR, sentimentR, okxR] = await Promise.allSettled([
    getOHLCV(tokenMint, '15m', 50),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    getOKXData(tokenMint),
  ]);

  const ohlcv     = ohlcvR.status     === 'fulfilled' ? ohlcvR.value     : null;
  const pool      = poolR.status      === 'fulfilled' ? poolR.value      : null;
  const onChain   = onChainR.status   === 'fulfilled' ? onChainR.value   : null;
  const sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const okx       = okxR.status       === 'fulfilled' ? okxR.value       : null;

  // DLMM health score
  let healthScore = 50;
  if (pool) {
    healthScore += pool.feeAprCategory === 'HIGH' ? 20 : pool.feeAprCategory === 'LOW' ? -20 : 0;
    healthScore += pool.feeVelocity === 'INCREASING' ? 15 : pool.feeVelocity === 'DECREASING' ? -15 : 0;
    healthScore += pool.feeTvlRatio > 0.05 ? 10 : pool.feeTvlRatio < 0.01 ? -10 : 0;
  }
  if (onChain?.available) {
    healthScore += onChain.whaleRisk === 'HIGH' ? -15 : onChain.whaleRisk === 'LOW' ? 5 : 0;
  }
  if (okx?.available) {
    healthScore += okx.isHoneypot ? -30 : 0;
    healthScore += okx.riskLevel === 'high' ? -15 : okx.riskLevel === 'low' ? 5 : 0;
  }
  healthScore = Math.max(0, Math.min(100, healthScore));

  // Backward-compat fields untuk matchStrategyToMarket
  const trend = ohlcv?.trend || sentiment?.sentiment === 'BULLISH' ? 'UPTREND'
    : sentiment?.sentiment === 'BEARISH' ? 'DOWNTREND' : 'SIDEWAYS';

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool, onChain, sentiment, okx,
    healthScore,
    // Backward-compat
    liquidity: pool ? { tvl: pool.tvl, volume24h: pool.volume24h, feeApr: pool.feeApr } : null,
    price: sentiment ? {
      currentPrice: sentiment.priceUsd,
      trend: ohlcv?.trend || 'SIDEWAYS',
      volatility24h: ohlcv?.range24hPct || 0,
      volatilityCategory: ohlcv?.volatilityCategory || 'MEDIUM',
      buyPressurePct: sentiment.buyPressurePct,
      sentiment: sentiment.sentiment,
      suggestedBinStepMin: ohlcv?.suggestedBinStepMin || 10,
    } : null,
  };
}
