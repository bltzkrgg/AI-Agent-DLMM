/**
 * Candle Provider Abstraction
 * Implements failover chain: GeckoTerminal → CoinGecko → Birdeye
 */

import { fetchWithTimeout } from '../utils/safeJson.js';

const logger = console;

// ──── Candle Provider Base Class ─────────────────────────────────

class CandleProvider {
  constructor(name) {
    this.name = name;
    this.healthy = true;
    this.lastError = null;
    this.errorCount = 0;
    this.successCount = 0;
  }

  async fetchCandles(poolAddress, timeframe, limit) {
    throw new Error('fetchCandles() must be implemented by subclass');
  }

  recordSuccess() {
    this.successCount++;
    if (this.successCount >= 2) {
      this.errorCount = 0;
      if (!this.healthy) {
        this.healthy = true;
        logger.log(`✅ ${this.name} candle provider recovered`);
      }
    }
  }

  recordError(err) {
    this.errorCount++;
    this.lastError = err.message;
    this.successCount = 0;
    if (this.errorCount >= 2 && this.healthy) {
      this.healthy = false;
      logger.warn(`⚠️ ${this.name} candle provider marked unhealthy: ${err.message}`);
    }
  }

  async healthCheck() {
    // Default: just mark as healthy, can be overridden
    return true;
  }
}

// ──── GeckoTerminal Provider ─────────────────────────────────────

class GeckoTerminalProvider extends CandleProvider {
  constructor() {
    super('GeckoTerminal');
    this.baseUrl = 'https://api.geckoterminal.com/api/v2';
  }

  // Map timeframe to GeckoTerminal period + aggregate
  mapTimeframe(timeframe) {
    const mapping = {
      '1m': { period: 'minute', aggregate: 1 },
      '5m': { period: 'minute', aggregate: 5 },
      '15m': { period: 'minute', aggregate: 15 },
      '30m': { period: 'minute', aggregate: 30 },
      '1h': { period: 'hour', aggregate: 1 },
      '4h': { period: 'hour', aggregate: 4 },
      '1d': { period: 'day', aggregate: 1 },
    };
    return mapping[timeframe] || { period: 'minute', aggregate: 15 };
  }

  async fetchCandles(poolAddress, timeframe = '15m', limit = 200) {
    try {
      const { period, aggregate } = this.mapTimeframe(timeframe);
      const before_timestamp = Math.floor(Date.now() / 1000);

      const url = `${this.baseUrl}/networks/solana/pools/${poolAddress}/ohlcv/${period}?aggregate=${aggregate}&before_timestamp=${before_timestamp}&limit=${limit}`;

      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.data?.ohlcv) return null;

      const candles = data.data.ohlcv.map(c => ({
        t: parseInt(c[0]) / 1000, // Convert ms to s
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseFloat(c[5]),
      }));

      this.recordSuccess();
      return candles;
    } catch (e) {
      this.recordError(e);
      throw e;
    }
  }
}

// ──── CoinGecko Provider ─────────────────────────────────────────

class CoinGeckoProvider extends CandleProvider {
  constructor() {
    super('CoinGecko');
    this.baseUrl = 'https://api.coingecko.com/api/v3';
  }

  mapTimeframe(timeframe) {
    // CoinGecko API doesn't support all timeframes — return best match
    const mapping = {
      '1m': 'daily',
      '5m': 'daily',
      '15m': 'daily',
      '30m': 'daily',
      '1h': 'daily',
      '4h': 'daily',
      '1d': 'daily',
    };
    return mapping[timeframe] || 'daily';
  }

  async fetchCandles(poolAddress, timeframe = '1d', limit = 90) {
    try {
      // Note: CoinGecko doesn't have pool-level OHLCV, only token prices
      // This is a fallback that returns approximate daily candles
      const days = Math.min(limit, 365);

      const url = `${this.baseUrl}/coins/solana/ohlc?vs_currency=usd&days=${days}`;

      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data)) return null;

      const candles = data.map(c => ({
        t: c[0] / 1000, // CoinGecko returns ms timestamp
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: 0, // CoinGecko doesn't provide volume in this endpoint
      })).slice(-limit);

      this.recordSuccess();
      return candles;
    } catch (e) {
      this.recordError(e);
      throw e;
    }
  }
}

// ──── Birdeye Provider ───────────────────────────────────────────

class BirdeyeProvider extends CandleProvider {
  constructor(apiKey) {
    super('Birdeye');
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.birdeye.so/v1';
  }

  async fetchCandles(poolAddress, timeframe = '15m', limit = 200) {
    try {
      if (!this.apiKey) {
        throw new Error('Birdeye API key not configured');
      }

      const url = `${this.baseUrl}/defi/ohlcv?address=${poolAddress}&type=${this.mapTimeframe(timeframe)}&limit=${limit}`;

      const res = await fetchWithTimeout(url, {
        headers: { 'X-API-KEY': this.apiKey },
      }, 10000);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data.data?.items) return null;

      const candles = data.data.items.map(c => ({
        t: c.unixTime,
        o: parseFloat(c.o),
        h: parseFloat(c.h),
        l: parseFloat(c.l),
        c: parseFloat(c.c),
        v: parseFloat(c.v),
      }));

      this.recordSuccess();
      return candles;
    } catch (e) {
      this.recordError(e);
      throw e;
    }
  }

  mapTimeframe(timeframe) {
    const mapping = {
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
      '4h': '4h',
      '1d': '1d',
    };
    return mapping[timeframe] || '15m';
  }
}

// ──── Candle Manager (Fallback Chain) ────────────────────────────

export class CandleManager {
  constructor(config = {}) {
    this.providers = [];

    // Initialize providers in order
    if (config.gecko !== false) {
      // GeckoTerminal is free, always include as primary
      this.providers.push(new GeckoTerminalProvider());
    }

    if (config.coingecko !== false) {
      // CoinGecko is free but limited to token OHLCV (not pool-specific)
      this.providers.push(new CoinGeckoProvider());
    }

    if (config.birdeye) {
      // Birdeye requires API key
      this.providers.push(new BirdeyeProvider(config.birdeye));
    }

    if (this.providers.length === 0) {
      throw new Error('At least one candle provider must be configured');
    }

    logger.log(`📊 Candle Manager initialized with ${this.providers.length} provider(s): ${this.providers.map(p => p.name).join(', ')}`);
  }

  /**
   * Fetch candles with automatic failover
   */
  async fetchCandles(poolAddress, timeframe = '15m', limit = 200) {
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];

      try {
        const candles = await provider.fetchCandles(poolAddress, timeframe, limit);
        if (candles && candles.length > 0) {
          return candles;
        }
      } catch (e) {
        logger.warn(`❌ ${provider.name} failed to fetch candles: ${e.message}`);

        if (i < this.providers.length - 1) {
          logger.log(`↻ Trying next candle provider...`);
          continue;
        }

        throw new Error(`All candle providers exhausted. Last error: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * Get provider metrics
   */
  getMetrics() {
    return {
      providers: this.providers.map(p => ({
        name: p.name,
        healthy: p.healthy,
        errors: p.errorCount,
        lastError: p.lastError,
      })),
    };
  }
}

export default CandleManager;
