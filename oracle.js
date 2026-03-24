/**
 * Market Oracle
 * Mengumpulkan data market dari berbagai sumber gratis:
 * - OHLCV & price action: Birdeye public API
 * - Volume & liquidity: Meteora API
 * - On-chain signals: Helius (free tier)
 * - Sentiment: DexScreener
 */

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const HELIUS_BASE = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
const DEXSCREENER_BASE = 'https://api.dexscreener.com';

// ─── OHLCV & Price Action ────────────────────────────────────────

export async function getOHLCV(tokenMint, timeframe = '15m', limit = 50) {
  try {
    // Birdeye public endpoint (no key needed for basic data)
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&type=${timeframe}&limit=${limit}`,
      { headers: { 'x-chain': 'solana' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.data?.items || [];

    if (items.length === 0) return null;

    // Calculate basic indicators
    const closes = items.map(i => i.c);
    const volumes = items.map(i => i.v);
    const latest = items[items.length - 1];
    const prev = items[items.length - 2];

    return {
      tokenMint,
      timeframe,
      currentPrice: latest.c,
      priceChange: prev ? ((latest.c - prev.c) / prev.c * 100).toFixed(2) : 0,
      high24h: Math.max(...items.slice(-96).map(i => i.h)), // 96 x 15min = 24h
      low24h: Math.min(...items.slice(-96).map(i => i.l)),
      avgVolume: (volumes.reduce((a, b) => a + b, 0) / volumes.length).toFixed(2),
      latestVolume: latest.v,
      volumeVsAvg: (latest.v / (volumes.reduce((a, b) => a + b, 0) / volumes.length)).toFixed(2),
      trend: detectTrend(closes),
      support: Math.min(...closes.slice(-20)),
      resistance: Math.max(...closes.slice(-20)),
      candles: items.slice(-10), // last 10 candles
    };
  } catch (e) {
    return null;
  }
}

function detectTrend(closes) {
  if (closes.length < 5) return 'UNKNOWN';
  const recent = closes.slice(-5);
  const older = closes.slice(-10, -5);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  if (recentAvg > olderAvg * 1.02) return 'UPTREND';
  if (recentAvg < olderAvg * 0.98) return 'DOWNTREND';
  return 'SIDEWAYS';
}

// ─── Volume & Liquidity Flow ─────────────────────────────────────

export async function getLiquidityFlow(poolAddress) {
  try {
    // Meteora pool stats
    const res = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pool = await res.json();

    // Fetch 24h volume history if available
    const histRes = await fetch(
      `https://dlmm-api.meteora.ag/pair/${poolAddress}/analytics?period=24h`
    ).catch(() => null);
    const hist = histRes?.ok ? await histRes.json() : null;

    return {
      poolAddress,
      tvl: pool.liquidity || 0,
      volume24h: pool.trade_volume_24h || 0,
      fees24h: pool.fees_24h || 0,
      feeApr: pool.fee_apr || 0,
      binStep: pool.bin_step,
      // Liquidity flow: positive = inflow, negative = outflow
      liquidityChange24h: hist?.liquidity_change_24h || null,
      tradeCount24h: hist?.trade_count_24h || null,
      uniqueTraders24h: hist?.unique_traders_24h || null,
    };
  } catch (e) {
    return null;
  }
}

// ─── On-Chain Signals (Helius) ───────────────────────────────────

export async function getOnChainSignals(tokenMint) {
  if (!process.env.HELIUS_API_KEY) {
    return { available: false, reason: 'HELIUS_API_KEY not set' };
  }

  try {
    // Fetch recent large transactions
    const res = await fetch(HELIUS_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [tokenMint, { limit: 20 }],
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const sigs = data.result || [];

    // Fetch holder count from Birdeye (free)
    const holderRes = await fetch(
      `${BIRDEYE_BASE}/defi/token_overview?address=${tokenMint}`,
      { headers: { 'x-chain': 'solana' } }
    ).catch(() => null);
    const holderData = holderRes?.ok ? await holderRes.json() : null;

    // Fetch top holders concentration
    const topHolderRes = await fetch(
      `${BIRDEYE_BASE}/defi/token_holder?address=${tokenMint}&offset=0&limit=10`,
      { headers: { 'x-chain': 'solana' } }
    ).catch(() => null);
    const topHolders = topHolderRes?.ok ? await topHolderRes.json() : null;

    const holders = holderData?.data;
    const top10 = topHolders?.data?.items || [];
    const top10Pct = top10.reduce((sum, h) => sum + (h.percentage || 0), 0);

    return {
      available: true,
      recentTxCount: sigs.length,
      holders: holders?.holder || null,
      marketCap: holders?.mc || null,
      top10HolderPct: top10Pct.toFixed(2),
      // High concentration = whale risk
      whaleRisk: top10Pct > 50 ? 'HIGH' : top10Pct > 30 ? 'MEDIUM' : 'LOW',
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── Sentiment (DexScreener) ─────────────────────────────────────

export async function getSentiment(tokenMint) {
  try {
    const res = await fetch(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const pairs = data.pairs || [];

    if (pairs.length === 0) return null;

    // Pick the pair with highest liquidity
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    const txns = best.txns?.h24 || {};
    const buys = txns.buys || 0;
    const sells = txns.sells || 0;
    const total = buys + sells;
    const buyPressure = total > 0 ? (buys / total * 100).toFixed(1) : 50;

    return {
      tokenSymbol: best.baseToken?.symbol,
      priceUsd: best.priceUsd,
      priceChange1h: best.priceChange?.h1,
      priceChange6h: best.priceChange?.h6,
      priceChange24h: best.priceChange?.h24,
      liquidityUsd: best.liquidity?.usd,
      fdv: best.fdv,
      buys24h: buys,
      sells24h: sells,
      buyPressurePct: parseFloat(buyPressure),
      // Simple sentiment scoring
      sentiment: parseFloat(buyPressure) > 60 ? 'BULLISH'
        : parseFloat(buyPressure) < 40 ? 'BEARISH'
        : 'NEUTRAL',
      pairUrl: best.url,
    };
  } catch (e) {
    return null;
  }
}

// ─── Full Market Snapshot ────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [ohlcv, liquidity, onChain, sentiment] = await Promise.allSettled([
    getOHLCV(tokenMint, '15m', 50),
    poolAddress ? getLiquidityFlow(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
  ]);

  return {
    tokenMint,
    poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv: ohlcv.status === 'fulfilled' ? ohlcv.value : null,
    liquidity: liquidity.status === 'fulfilled' ? liquidity.value : null,
    onChain: onChain.status === 'fulfilled' ? onChain.value : null,
    sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
  };
}
