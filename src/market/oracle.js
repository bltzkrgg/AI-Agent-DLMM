import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const OKX_BASE = 'https://www.okx.com/api/v5';

// ─── OHLCV & Price Action ────────────────────────────────────────

export async function getOHLCV(tokenMint, timeframe = '15m', limit = 50) {
  try {
    const res = await fetchWithTimeout(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&type=${timeframe}&limit=${limit}`,
      { headers: { 'x-chain': 'solana' } },
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.data?.items || [];
    if (items.length < 3) return null;

    const closes = items.map(i => safeNum(i.c));
    const volumes = items.map(i => safeNum(i.v));
    const latest = items[items.length - 1];
    const prev = items[items.length - 2];
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    return {
      tokenMint,
      timeframe,
      currentPrice: safeNum(latest.c),
      priceChange: prev && prev.c ? safeNum(((latest.c - prev.c) / prev.c * 100).toFixed(2)) : 0,
      high24h: safeNum(Math.max(...items.slice(-96).map(i => safeNum(i.h)))),
      low24h: safeNum(Math.min(...items.slice(-96).map(i => safeNum(i.l, Infinity)).filter(v => v !== Infinity))),
      avgVolume: safeNum(avgVol.toFixed(2)),
      latestVolume: safeNum(latest.v),
      // Return as number, not string
      volumeVsAvg: avgVol > 0 ? safeNum((safeNum(latest.v) / avgVol).toFixed(2)) : 1,
      trend: detectTrend(closes),
      support: safeNum(Math.min(...closes.slice(-20))),
      resistance: safeNum(Math.max(...closes.slice(-20))),
    };
  } catch {
    return null;
  }
}

function detectTrend(closes) {
  if (closes.length < 10) return 'SIDEWAYS';

  // Use more candles for reliability
  const recent5 = closes.slice(-5);
  const older5 = closes.slice(-10, -5);
  const recent20 = closes.slice(-20);

  const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const olderAvg = older5.reduce((a, b) => a + b, 0) / older5.length;

  if (olderAvg === 0) return 'SIDEWAYS';

  const changePct = (recentAvg - olderAvg) / olderAvg * 100;

  // Check consistency — count how many of last 5 are above 20-period avg
  const avg20 = recent20.reduce((a, b) => a + b, 0) / recent20.length;
  const aboveAvg = recent5.filter(c => c > avg20).length;

  if (changePct > 2 && aboveAvg >= 4) return 'UPTREND';
  if (changePct < -2 && aboveAvg <= 1) return 'DOWNTREND';
  return 'SIDEWAYS';
}

// ─── Volume & Liquidity Flow ─────────────────────────────────────

export async function getLiquidityFlow(poolAddress) {
  try {
    const res = await fetchWithTimeout(
      `https://dlmm-api.meteora.ag/pair/${poolAddress}`,
      {},
      8000
    );
    if (!res.ok) return null;
    const pool = await res.json();

    return {
      poolAddress,
      tvl: safeNum(pool.liquidity),
      volume24h: safeNum(pool.trade_volume_24h),
      fees24h: safeNum(pool.fees_24h),
      feeApr: safeNum(pool.fee_apr),
      binStep: pool.bin_step,
    };
  } catch {
    return null;
  }
}

// ─── On-Chain Signals (Helius) ───────────────────────────────────

export async function getOnChainSignals(tokenMint) {
  if (!process.env.HELIUS_API_KEY) {
    return { available: false, reason: 'HELIUS_API_KEY not set' };
  }

  const HELIUS_BASE = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

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
        { headers: { 'x-chain': 'solana' } },
        8000
      ),
      fetchWithTimeout(
        `${BIRDEYE_BASE}/defi/token_holder?address=${tokenMint}&offset=0&limit=10`,
        { headers: { 'x-chain': 'solana' } },
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
      available: true,
      recentTxCount: sigs.length,
      holders: holderData?.holder || null,
      marketCap: holderData?.mc || null,
      top10HolderPct: safeNum(top10Pct.toFixed(2)),
      whaleRisk: top10Pct > 50 ? 'HIGH' : top10Pct > 30 ? 'MEDIUM' : 'LOW',
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── Sentiment (DexScreener) ─────────────────────────────────────

export async function getSentiment(tokenMint) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`,
      {},
      8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;

    const best = pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];
    const txns = best.txns?.h24 || {};
    const buys = safeNum(txns.buys);
    const sells = safeNum(txns.sells);
    const total = buys + sells;
    const buyPressurePct = total > 0 ? safeNum((buys / total * 100).toFixed(1)) : 50;

    return {
      tokenSymbol: best.baseToken?.symbol || '',
      priceUsd: safeNum(best.priceUsd),
      priceChange1h: safeNum(best.priceChange?.h1),
      priceChange6h: safeNum(best.priceChange?.h6),
      priceChange24h: safeNum(best.priceChange?.h24),
      liquidityUsd: safeNum(best.liquidity?.usd),
      fdv: safeNum(best.fdv),
      buys24h: buys,
      sells24h: sells,
      buyPressurePct,
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
    };
  } catch {
    return null;
  }
}

// ─── OKX OnchainOS — Smart Money Signals & Token Risk Scoring ────

export async function getOKXData(tokenMint) {
  if (!process.env.OKX_API_KEY) {
    return { available: false, reason: 'OKX_API_KEY not set' };
  }

  // Solana chainId di OKX = 501
  const chainId = '501';
  const headers = {
    'OK-ACCESS-KEY': process.env.OKX_API_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const [secRes, smartRes] = await Promise.allSettled([
      // Token risk/security check
      fetchWithTimeout(
        `${OKX_BASE}/dex/security/token?chainId=${chainId}&tokenContractAddress=${tokenMint}`,
        { headers },
        8000
      ),
      // Smart money signal untuk token
      fetchWithTimeout(
        `${OKX_BASE}/dex/ai-market/token-signal?chainId=${chainId}&tokenAddress=${tokenMint}`,
        { headers },
        8000
      ),
    ]);

    const secData   = secRes.status === 'fulfilled' && secRes.value.ok
      ? await secRes.value.json().catch(() => null) : null;
    const smartData = smartRes.status === 'fulfilled' && smartRes.value.ok
      ? await smartRes.value.json().catch(() => null) : null;

    const sec   = secData?.data?.[0]   || {};
    const smart = smartData?.data?.[0] || {};

    return {
      available: true,
      // Token risk scoring
      riskLevel:          sec.riskLevel          ?? null,  // 'low' | 'medium' | 'high'
      isHoneypot:         sec.isHoneypot          ?? false,
      isProxy:            sec.isProxy             ?? false,
      isMintable:         sec.isMintable          ?? false,
      ownershipRenounced: sec.ownershipRenounced  ?? null,
      // Smart money signals
      smartMoneyBuying:   smart.smartMoneyBuying  ?? null,
      smartMoneySelling:  smart.smartMoneySelling ?? null,
      smartMoneySignal:   smart.signal            ?? null, // 'bullish'|'bearish'|'neutral'
      signalStrength:     smart.signalStrength    ?? null,
      smartMoneyNetFlow:  smart.netFlow           ?? null,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ─── Full Market Snapshot ────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress) {
  const [ohlcv, liquidity, onChain, sentiment, okx] = await Promise.allSettled([
    getOHLCV(tokenMint, '15m', 50),
    poolAddress ? getLiquidityFlow(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    getOKXData(tokenMint),
  ]);

  return {
    tokenMint,
    poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv:     ohlcv.status     === 'fulfilled' ? ohlcv.value     : null,
    liquidity: liquidity.status === 'fulfilled' ? liquidity.value : null,
    onChain:   onChain.status   === 'fulfilled' ? onChain.value   : null,
    sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
    okx:       okx.status       === 'fulfilled' ? okx.value       : null,
  };
}
