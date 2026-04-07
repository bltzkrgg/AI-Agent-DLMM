/**
 * Rate Limiter — Token bucket per domain
 * Mencegah API rate limit dengan spacing request per hostname
 */

export class RateLimiter {
  constructor(config = {}) {
    this.buckets = new Map(); // hostname → { lastCallMs }
    this.defaultRpm = config.defaultRpm || 60; // default 60 request/minute
    this.domainLimits = config.domainLimits || {}; // hostname → RPM override
  }

  /**
   * Get RPM limit untuk hostname
   */
  getRpm(hostname) {
    return this.domainLimits[hostname] || this.defaultRpm;
  }

  /**
   * Acquire slot untuk hostname — tunggu jika terlalu cepat
   */
  async acquire(hostname) {
    const rpm = this.getRpm(hostname);
    const intervalMs = 60000 / rpm; // milliseconds antara calls

    // Inisialisasi bucket jika belum ada
    if (!this.buckets.has(hostname)) {
      this.buckets.set(hostname, { lastCallMs: 0 });
    }

    const bucket = this.buckets.get(hostname);
    const now = Date.now();
    const waitMs = Math.max(0, bucket.lastCallMs + intervalMs - now);

    // Tunggu jika perlu
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Update last call time
    bucket.lastCallMs = Date.now();
  }

  /**
   * Get bucket state (untuk debugging)
   */
  getState(hostname) {
    return this.buckets.get(hostname) || null;
  }

  /**
   * Reset specific bucket (untuk testing)
   */
  reset(hostname) {
    if (hostname) {
      this.buckets.delete(hostname);
    } else {
      this.buckets.clear();
    }
  }
}

/**
 * Global singleton — dipakai oleh fetchWithTimeout
 * Limits dikalibrasi berdasarkan API free tier specs (2024)
 */
export const globalRateLimiter = new RateLimiter({
  domainLimits: {
    // GeckoTerminal — paling critical (150+ calls per screening cycle)
    'api.geckoterminal.com': 30,

    // DexScreener — ~20-30 calls per screening
    'api.dexscreener.com': 30,

    // CoinGecko — free tier paling ketat
    'api.coingecko.com': 10,

    // RugCheck — ~10 calls per screening
    'api.rugcheck.xyz': 30,

    // Birdeye — paid tier lebih longgar
    'api.birdeye.so': 60,

    // OKX — ~5 calls per screening
    'www.okx.com': 20,

    // Jupiter — dua domain
    'tokens.jup.ag': 60,
    'api.jup.ag': 60,

    // Meteora datapi
    'dlmm-api.meteora.ag': 60,
    'dlmm.datapi.meteora.ag': 60,

    // LP Agent
    'api.lpagent.io': 60, // sudah punya rate limiter sendiri (13s), ini backup saja

    // Helius — RPC dengan failover, cache 5 menit
    'mainnet.helius-rpc.com': 60,
    'solana-mainnet.g.alchemy.com': 60,
    'solana-mainnet.quiknode.pro': 60,
  },
  defaultRpm: 60,
});

export default RateLimiter;
