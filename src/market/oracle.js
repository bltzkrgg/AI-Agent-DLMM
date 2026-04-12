import { fetchWithTimeout, safeNum } from '../utils/safeJson.js';
import { getHeliusOnChainSignals } from '../utils/helius.js';
import * as ta from '../utils/ta.js';
import { getPoolSmartMoney } from '../market/lpAgent.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const METEORA_DATAPI   = 'https://dlmm.datapi.meteora.ag';

// ─── 1. OHLCV — Price Snapshot (DexScreener) ────────────────────
// Rerouted to DexScreener as the primary source for price/volatility logic.
// Advanced TA (MACD/RSI) is removed as it required historical candles from GeckoTerminal.

export async function getOHLCV(tokenMint, poolAddress = null) {
  return buildOHLCVFromDexScreener(tokenMint);
}

// ─── 2. On-Chain Signals (Helius) ────────────────────────────────
// Kept for инфраструкura (metadata, priority fees), but market signals (whale risk) 
// are now simplified or derived from allowed sources.

export async function getOnChainSignals(tokenMint) {
  return getHeliusOnChainSignals(tokenMint);
}

// ─── 3. DLMM Pool Data (Meteora datapi) ─────────────────────────

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
    const volume24h   = safeNum(pool.volume?.['24h'] ?? pool.trade_volume_24h ?? 0);
    const tvl         = safeNum(pool.tvl ?? pool.liquidity ?? 0);
    const feeApr      = safeNum((pool.fee_tvl_ratio?.['24h'] ?? 0) * 100 * 365);
    const binStep     = safeNum(pool.pool_config?.bin_step ?? pool.bin_step ?? 0);
    const feeTvlRatio = tvl > 0 ? fees24h / tvl : 0;

    const feeAprCategory = feeApr >= 100 ? 'HIGH' : feeApr >= 30 ? 'MEDIUM' : 'LOW';

    return {
      address: poolAddress, name: pool.name || '',
      tvl, volume24h, fees24h,
      feeApr: parseFloat(feeApr.toFixed(2)), feeAprCategory,
      feeTvlRatio: parseFloat(feeTvlRatio.toFixed(4)),
      binStep,
      tokenXMint: pool.token_x?.address || null,
      tokenYMint: pool.token_y?.address || null,
    };
  } catch { return null; }
}

// ─── 4. DexScreener — Sentiment & Momentum ──────────────────────

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
      fdv: safeNum(best.fdv),
      sentiment: buyPressurePct > 60 ? 'BULLISH' : buyPressurePct < 40 ? 'BEARISH' : 'NEUTRAL',
    };
  } catch { return null; }
}

// ─── OHLCV Build helper ──────────────────────────────────────────

async function buildOHLCVFromDexScreener(tokenMint, poolAddress = null) {
  try {
    const res = await fetchWithTimeout(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`, {}, 8000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    
    // Use matching pool if provided, else best liquidity
    const best = poolAddress 
      ? (pairs.find(p => p.pairAddress === poolAddress) || pairs.sort((a,b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0])
      : pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd))[0];

    const currentPrice   = safeNum(best.priceUsd);
    const priceChangeM5  = safeNum(best.priceChange?.m5);
    const priceChange1h  = safeNum(best.priceChange?.h1);
    const priceChange24h = safeNum(best.priceChange?.h24);
    const volume24h      = safeNum(best.volume?.h24);
    const range24hPct    = Math.abs(priceChange24h);

    const high24h = currentPrice / (1 - Math.max(0, priceChange24h) / 100) || currentPrice;
    const low24h  = currentPrice / (1 + Math.max(0, -priceChange24h) / 100) || currentPrice;

    // Volume Delta components (m5 preferred for sniper logic)
    const txns   = best.txns?.m5 || best.txns?.h1 || {};
    const buys   = safeNum(txns.buys);
    const sells  = safeNum(txns.sells);

    const trend = (priceChangeM5 > 1.5 && priceChange1h > 0) ? 'UPTREND'
      : (priceChangeM5 < -1.5 && priceChange1h < 0) ? 'DOWNTREND'
      : (priceChangeM5 > 3) ? 'PUMPING'
      : 'SIDEWAYS';

    // ─── Fetch History & Calculate TA (Now using DexScreener V1) ───
    let taData = null;
    let historySuccess = false;
    const actualPool = poolAddress || best.pairAddress;

    if (actualPool) {
      const history = await getHistoryOHLCV(actualPool);
      if (history && history.length >= 26) {
        // SNIPER REBIRTH: Ignore the last (live/partial) candle to prevent flickering signals.
        // We only calculate TA based on COMPLETED 15m candles.
        const closedHistory = history.slice(0, -1);
        const closes = closedHistory.map(c => c.close);
        
        const rsi2   = ta.calculateRSI(closes, 2);
        const rsi14  = ta.calculateRSI(closes, 14);
        const bb     = ta.calculateBB(closes, 20, 2);
        const macd   = ta.calculateMACD(closes);
        const st     = ta.calculateSupertrend(closedHistory, 10, 3);
        
        taData = {
          rsi2: parseFloat(rsi2.toFixed(2)),
          rsi14: parseFloat(rsi14.toFixed(2)),
          bb,
          macd,
          supertrend: st,
          atr: st.atr, // Expose raw ATR for adaptive range logic
          // Strategy-specific triggers (Normalized keys)
          "Evil Panda": {
            entry: {
              triggered: st.trend === 'BULLISH' && rsi2 < 20,
              reason: (st.trend === 'BULLISH' && rsi2 < 20) ? `Dip Buy: RSI(2) ${rsi2.toFixed(1)} < 20 in Uptrend` : null
            },
            exit: {
              triggered: rsi2 > 90 || (st.trend === 'BEARISH' && st.changed),
              reason: rsi2 > 90 ? `Profit Take: RSI(2) ${rsi2.toFixed(1)} > 90` : (st.trend === 'BEARISH' ? 'Trend Flip: Supertrend Bearish' : null)
            }
          }
        };
        historySuccess = true;
      }
    }

    return {
      tokenMint,
      timeframe:      '15m',
      source:         'dexscreener-v1',
      currentPrice,
      priceChangeM5,
      priceChangeH1:  priceChange1h,
      high24h, low24h,
      range24hPct:    parseFloat(range24hPct.toFixed(2)),
      buyVolume:      buys,
      sellVolume:     sells,
      trend,
      volatilityCategory:  range24hPct > 20 ? 'HIGH' : range24hPct > 7 ? 'MEDIUM' : 'LOW',
      ta: taData,
      historySuccess,
    };
  } catch (e) { 
    console.error('[oracle] buildOHLCV failed:', e.message);
    return null; 
  }
}

async function getHistoryOHLCV(poolAddress) {
  try {
    // DexScreener V1 OHLCV API (Solana) 
    // Format: https://api.dexscreener.com/ohlcv/latest/v1/solana/{poolAddress}
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/ohlcv/latest/v1/solana/${poolAddress}`,
      {},
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    const candles = json.candles || [];
    
    // DexScreener format: { t: timestamp, o: open, h: high, l: low, c: close, v: volume }
    return candles.map(c => ({
      time:  c.t,
      open:  safeNum(c.o),
      high:  safeNum(c.h),
      low:   safeNum(c.l),
      close: safeNum(c.c),
      volume: safeNum(c.v)
    })).sort((a, b) => a.time - b.time); // Ensure ascending for TA libs
  } catch { return null; }
}

// ─── Full DLMM Snapshot ──────────────────────────────────────────

export async function getMarketSnapshot(tokenMint, poolAddress = null) {
  const [ohlcvR, poolR, onChainR, sentimentR, smartMoneyR] = await Promise.allSettled([
    getOHLCV(tokenMint, poolAddress),
    poolAddress ? getDLMMPoolData(poolAddress) : Promise.resolve(null),
    getOnChainSignals(tokenMint),
    getSentiment(tokenMint),
    poolAddress ? getPoolSmartMoney(poolAddress) : Promise.resolve(null),
  ]);

  const ohlcv      = ohlcvR.status     === 'fulfilled' ? ohlcvR.value     : null;
  const pool       = poolR.status      === 'fulfilled' ? poolR.value      : null;
  const onChain    = onChainR.status   === 'fulfilled' ? onChainR.value   : null;
  const sentiment  = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const smartMoney = smartMoneyR.status === 'fulfilled' ? smartMoneyR.value : null;

  // Simplified Health Score (using only allowed sources)
  let healthScore = 50;
  if (pool) {
    healthScore += pool.feeAprCategory === 'HIGH' ? 20 : pool.feeAprCategory === 'LOW' ? -20 : 0;
    healthScore += pool.feeTvlRatio > 0.05 ? 15 : pool.feeTvlRatio < 0.01 ? -10 : 0;
  }
  if (onChain?.available) {
    healthScore += onChain.whaleRisk === 'HIGH' ? -15 : onChain.whaleRisk === 'LOW' ? 5 : 0;
  }
  if (sentiment) {
    healthScore += sentiment.buyPressurePct > 60 ? 10 : sentiment.buyPressurePct < 40 ? -5 : 0;
  }

  if (smartMoney && pool?.tvl > 0) {
    const skew = (smartMoney.topLpUsd / pool.tvl) * 100;
    smartMoney.skewPct = parseFloat(skew.toFixed(2));
    if (skew > 25) healthScore -= 10;
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    tokenMint, poolAddress,
    timestamp: new Date().toISOString(),
    ohlcv, pool: pool ? { ...pool, mcap: sentiment?.fdv || 0 } : null, onChain, sentiment,
    smartMoney,
    healthScore,
    ta:   ohlcv?.ta || null,
    dataSource: ohlcv?.source || 'unknown',
    price: sentiment ? {
      currentPrice: sentiment.priceUsd,
      trend: ohlcv?.trend || 'SIDEWAYS',
      volatility24h: ohlcv?.range24hPct || 0,
      volatilityCategory: ohlcv?.volatilityCategory || 'MEDIUM',
      buyPressurePct: sentiment.buyPressurePct,
      sentiment: sentiment.sentiment,
    } : null,
  };
}

// ─── Helper functions (Legacy/Dummy) ─────────────────────────────
// Kept for backward compat but return empty data as candles are gone.

export async function fetchCandles() { return null; }
export async function getMultiTFScore() { return { score: 0.5, validCount: 0 }; }
export async function fetchMultiTFOHLCV() { return {}; }
export async function getOKXData() { return { available: false, reason: 'Source removed per consolidation' }; }
