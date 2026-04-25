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
    // GMGN — token security oracle (2 RPS serialized in gmgn.js, listed here for reference)
    'openapi.gmgn.ai': 120,

    // Jupiter
    'tokens.jup.ag': 60,
    'api.jup.ag': 60,

    // Meteora datapi
    'dlmm-api.meteora.ag': 60,
    'dlmm.datapi.meteora.ag': 60,

    // LP Agent
    'api.lpagent.io': 60,

    // AI Providers — protected to prevent 429 burst errors
    'openrouter.ai': 40,
    'api.anthropic.com': 40,
    'api.openai.com': 40,
    'api.groq.com': 40,

    // Helius — RPC
    'mainnet.helius-rpc.com': 60,
    'solana-mainnet.g.alchemy.com': 60,
    'solana-mainnet.quiknode.pro': 60,
  },
  defaultRpm: 60,
});

export default RateLimiter;
