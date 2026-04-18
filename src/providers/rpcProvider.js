/**
 * RPC Provider Abstraction
 * Implements failover chain: Helius → Alchemy → QuickNode
 */

import { Connection } from '@solana/web3.js';
import { fetchWithTimeout, stringify } from '../utils/safeJson.js';

const logger = console; // Use console for logging

// ──── RPC Provider Base Class ────────────────────────────────────

class RpcProvider {
  constructor(name, url, circuitBreaker = null) {
    this.name = name;
    this.url = url;
    this.healthy = true;
    this.lastError = null;
    this.errorCount = 0;
    this.successCount = 0;
    this.circuitBreaker = circuitBreaker;
    this._connection = null;
  }

  getConnection(commitment = 'confirmed') {
    if (!this._connection) {
      this._connection = new Connection(this.url, {
        commitment,
        confirmTransactionInitialTimeout: 90000,
        wsEndpoint: this.url.startsWith('https://') 
          ? this.url.replace('https://', 'wss://') 
          : undefined,
      });
    }
    return this._connection;
  }

  async call(method, params = [], timeoutMs = 10000) {
    const startTime = Date.now();
    try {
      const res = await fetchWithTimeout(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      }, timeoutMs);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(`RPC error: ${stringify(data.error)}`);
      }

      const latencyMs = Date.now() - startTime;
      this.recordSuccess();

      // Report latency to circuit breaker if available
      if (this.circuitBreaker) {
        this.circuitBreaker.recordLatency(this.name, latencyMs);
        // Advance HALF_OPEN → CLOSED recovery on successful RPC calls
        if (this.circuitBreaker.isHalfOpen()) {
          this.circuitBreaker.recordHealthCheckSuccess();
        }
      }

      return data.result;
    } catch (e) {
      this.recordError(e);

      // Report error to circuit breaker if available
      if (this.circuitBreaker) {
        this.circuitBreaker.recordError(this.name, e);
      }

      throw e;
    }
  }

  recordSuccess() {
    this.successCount++;
    if (this.successCount >= 3) {
      this.errorCount = 0;
      if (!this.healthy) {
        this.healthy = true;
        logger.log(`✅ ${this.name} recovered`);
      }
    }
  }

  recordError(err) {
    this.errorCount++;
    this.lastError = err.message;
    this.successCount = 0;
    if (this.errorCount >= 3 && this.healthy) {
      this.healthy = false;
      logger.warn(`⚠️ ${this.name} marked unhealthy: ${err.message}`);
    }
  }

  async healthCheck() {
    try {
      await this.call('getSlot', [], 5000);
      this.recordSuccess();
      return true;
    } catch {
      this.recordError(new Error('Health check failed'));
      return false;
    }
  }
}

// ──── RPC Providers ──────────────────────────────────────────────

class HeliusProvider extends RpcProvider {
  constructor(apiKey, circuitBreaker = null) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    super('Helius', url, circuitBreaker);
    this.apiKey = apiKey;
  }
}

class AlchemyProvider extends RpcProvider {
  constructor(apiKey, circuitBreaker = null) {
    const url = `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`;
    super('Alchemy', url, circuitBreaker);
    this.apiKey = apiKey;
  }
}

class QuickNodeProvider extends RpcProvider {
  constructor(apiKey, circuitBreaker = null) {
    const url = `https://solana-mainnet.quiknode.pro/${apiKey}/`;
    super('QuickNode', url, circuitBreaker);
    this.apiKey = apiKey;
  }
}

class SolamiProvider extends RpcProvider {
  constructor(urlOrKey, circuitBreaker = null) {
    // Solami can be a full URL (Jito-dedicated) or just an API key
    const url = urlOrKey.startsWith('http') 
      ? urlOrKey 
      : `https://api.solami.io/?api-key=${urlOrKey}`;
    super('Solami', url, circuitBreaker);
  }
}

// ──── RPC Manager (Fallback Chain) ──────────────────────────────

export class RpcManager {
  constructor(config = {}) {
    this.providers = [];
    this.cache = new Map(); // Simple cache: {method:params} → result
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    this.lastProviderIndex = 0;
    this.circuitBreaker = config.circuitBreaker || null;
    this.providerFailStreakToCooldown = config.providerFailStreakToCooldown || 2;
    this.providerCooldownMs = config.providerCooldownMs || 45_000;
    this.providerHealth = new Map(); // providerName -> { failStreak, cooldownUntil, lastFailureAt, lastSuccessAt }

    // Initialize providers in order: try primary first, then fallbacks
    if (config.helius) {
      this.providers.push(new HeliusProvider(config.helius, this.circuitBreaker));
    }
    if (config.solami) {
      this.providers.push(new SolamiProvider(config.solami, this.circuitBreaker));
    }
    if (config.alchemy) {
      this.providers.push(new AlchemyProvider(config.alchemy, this.circuitBreaker));
    }
    if (config.quicknode) {
      this.providers.push(new QuickNodeProvider(config.quicknode, this.circuitBreaker));
    }

    if (this.providers.length === 0) {
      throw new Error('At least one RPC provider (Helius, Alchemy, or QuickNode) must be configured');
    }

    logger.log(`📡 RPC Manager initialized with ${this.providers.length} provider(s): ${this.providers.map(p => p.name).join(', ')}`);
  }

  getProviderHealth(providerName) {
    if (!this.providerHealth.has(providerName)) {
      this.providerHealth.set(providerName, {
        failStreak: 0,
        cooldownUntil: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
      });
    }
    return this.providerHealth.get(providerName);
  }

  isProviderCoolingDown(provider, now = Date.now()) {
    const h = this.getProviderHealth(provider.name);
    return h.cooldownUntil > now;
  }

  markProviderFailure(provider, error) {
    const h = this.getProviderHealth(provider.name);
    h.failStreak += 1;
    h.lastFailureAt = Date.now();

    const msg = String(error?.message || '').toLowerCase();
    const isHardFailure =
      msg.includes('http 429') ||
      msg.includes('http 5') ||
      msg.includes('timeout') ||
      msg.includes('fetch failed') ||
      msg.includes('rpc error');

    if (h.failStreak >= this.providerFailStreakToCooldown || isHardFailure) {
      h.cooldownUntil = Date.now() + this.providerCooldownMs;
      logger.warn(`⏸ ${provider.name} cooling down for ${Math.round(this.providerCooldownMs / 1000)}s (streak=${h.failStreak}).`);
    }
  }

  markProviderSuccess(provider) {
    const h = this.getProviderHealth(provider.name);
    h.failStreak = 0;
    h.cooldownUntil = 0;
    h.lastSuccessAt = Date.now();
  }

  /**
   * Get a healthy connection object
   */
  getConnection(commitment = 'confirmed') {
    const provider = this.getPrimaryProvider();
    return provider.getConnection(commitment);
  }

  /**
   * Call method with automatic failover
   */
  async call(method, params = [], timeoutMs = 10000) {
    // Skip cache for real-time methods
    const bypassCache = ['getSlot', 'getRecentPrioritizationFees', 'getLatestBlockhash', 'getSignatureStatuses'];
    const cacheKey = bypassCache.includes(method) ? null : `${method}:${stringify(params)}`;
    let cached = null;
    
    if (cacheKey) {
      cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.time < this.cacheExpiry) {
        return cached.result;
      }
    }

    const now = Date.now();
    const activeProviders = this.providers.filter(p => !this.isProviderCoolingDown(p, now));
    const providersToTry = activeProviders.length > 0 ? activeProviders : this.providers;
    if (activeProviders.length === 0 && this.providers.length > 0) {
      logger.warn(`⚠️ All providers cooling down. Forcing probe on primary provider for ${method}.`);
    }

    // Try each provider in order
    for (let i = 0; i < providersToTry.length; i++) {
      const provider = providersToTry[i];

      try {
        const result = await provider.call(method, params, timeoutMs);
        this.markProviderSuccess(provider);

        // Cache successful result
        if (cacheKey) this.cache.set(cacheKey, { result, time: Date.now() });
        return result;
      } catch (e) {
        this.markProviderFailure(provider, e);
        logger.warn(`❌ ${provider.name} failed for ${method}: ${e.message}`);

        // Try next provider
        if (i < providersToTry.length - 1) {
          const next = providersToTry[i + 1];
          logger.log(`↻ Failover: Switching from ${provider.name} to ${next.name} for ${method}`);
          continue;
        }

        // All providers exhausted — try cache even if expired
        if (cached) {
          logger.warn(`⚠️ All providers failed, using stale cache`);
          return cached.result;
        }

        throw new Error(`All RPC providers exhausted for ${method}. Last error: ${e.message}`);
      }
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks(interval = 30000) {
    setInterval(async () => {
      for (const provider of this.providers) {
        try {
          await provider.healthCheck();
        } catch (e) {
          logger.warn(`Health check failed for ${provider.name}`);
        }
      }
    }, interval);
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
        successes: p.successCount,
        lastError: p.lastError,
        failStreak: this.getProviderHealth(p.name).failStreak,
        cooldownRemainingMs: Math.max(0, this.getProviderHealth(p.name).cooldownUntil - Date.now()),
      })),
      cacheSize: this.cache.size,
    };
  }

  /**
   * Get best available provider
   */
  getPrimaryProvider() {
    return this.providers.find(p => p.healthy) || this.providers[0];
  }
}

export default RpcManager;
