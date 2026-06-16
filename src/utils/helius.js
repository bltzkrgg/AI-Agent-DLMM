/**
 * Helius Client — centralized Helius RPC + API with fallback support
 *
 * Helius dipakai untuk:
 *   1. RPC endpoint utama (lebih reliable, rate limit lebih tinggi)
 *   2. getTokenLargestAccounts + getTokenSupply → top-10 holder concentration
 *   3. getSignaturesForAddress → token activity check
 *   4. Priority fee API → pastikan TX landing cepat
 *   5. Token metadata batch → simbol, desimal, nama
 *
 * Fallback chain (optional):
 *   Helius → Alchemy → QuickNode (if API keys configured)
 *
 * Env vars:
 *   HELIUS_API_KEY   — dari https://helius.dev (wajib)
 *   HELIUS_RPC_URL   — opsional override (default: mainnet.helius-rpc.com)
 *   ALCHEMY_API_KEY  — opsional fallback
 *   QUICKNODE_API_KEY — opsional fallback
 */

import { fetchWithTimeout, stringify } from './safeJson.js';
import { RpcManager } from '../providers/rpcProvider.js';

const RPC_HEALTH_CHECK_INTERVAL_MS = 90_000;
const PRIORITY_FEE_CACHE_TTL_MS = 4_000;
const ONCHAIN_SIGNAL_CACHE_TTL_MS = 20_000;
const ONCHAIN_SIGNAL_FAILURE_TTL_MS = 5_000;

const _priorityFeeCache = new Map(); // key -> { at, value }
const _priorityFeeInflight = new Map(); // key -> Promise<number>
const _onChainSignalCache = new Map(); // mint -> { at, value, ok }
const _onChainSignalInflight = new Map(); // mint -> Promise<object>

// ─── URL helpers ──────────────────────────────────────────────────

export function getHeliusRpcUrl() {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY is not set');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export function getHeliusApiBase() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY is not set');
  return `https://api.helius.xyz/v0`;
}

// ─── RPC Manager (Fallback Chain) ─────────────────────────────────

let _rpcManager = null;

function normalizeAccountKeySet(accountKeys = []) {
  if (!Array.isArray(accountKeys) || accountKeys.length === 0) return '';
  return Array.from(new Set(
    accountKeys
      .map((key) => String(key || '').trim())
      .filter(Boolean)
  )).sort().join('|');
}

function getCachedValue(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.at) > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function initializeRpcManager(circuitBreaker = null) {
  if (_rpcManager) return _rpcManager;

  const config = {
    helius: process.env.HELIUS_API_KEY,
    solami: process.env.SOLAMI_RPC_URL || process.env.SOLAMI_API_KEY,
    alchemy: process.env.ALCHEMY_API_KEY,
    quicknode: process.env.QUICKNODE_API_KEY,
    circuitBreaker: circuitBreaker,
  };

  // Filter out undefined keys (but keep circuitBreaker even if null)
  const activeConfig = Object.fromEntries(
    Object.entries(config).filter(([k, v]) => k === 'circuitBreaker' || v !== undefined)
  );

  if (!activeConfig.helius && !activeConfig.alchemy && !activeConfig.quicknode && !activeConfig.solami) {
    console.warn('⚠️ No RPC providers configured (Helius, Alchemy, QuickNode, or Solami). Fallback to direct Helius calls.');
    return null;
  }

  try {
    _rpcManager = new RpcManager(activeConfig);
    _rpcManager.startHealthChecks(RPC_HEALTH_CHECK_INTERVAL_MS);
    return _rpcManager;
  } catch (e) {
    console.warn('⚠️ Failed to initialize RPC manager:', e.message);
    return null;
  }
}

// ─── JSON-RPC helper ──────────────────────────────────────────────

let _rpcCallId = 0;

export async function heliusRpc(method, params = [], timeoutMs = 10000) {
  // Try RPC manager first (if initialized)
  const manager = _rpcManager || initializeRpcManager();
  if (manager) {
    try {
      return await manager.call(method, params, timeoutMs);
    } catch (e) {
      console.warn('RPC manager call failed, falling back to direct Helius call:', e.message);
    }
  }

  // Fallback: Direct Helius RPC call
  const url = getHeliusRpcUrl();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stringify({
      jsonrpc: '2.0',
      id: ++_rpcCallId,
      method,
      params,
    }),
  }, timeoutMs);

  if (!res.ok) throw new Error(`Helius RPC ${method} HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Helius RPC error: ${stringify(data.error)}`);
  return data.result;
}

// ─── Token holder data ────────────────────────────────────────────
// Top-10 concentration + approximate holder count

export async function getTokenHolderData(tokenMint) {
  try {
    const [largestResult, supplyResult] = await Promise.allSettled([
      heliusRpc('getTokenLargestAccounts', [tokenMint]),
      heliusRpc('getTokenSupply',          [tokenMint]),
    ]);

    const largestArr = largestResult.status === 'fulfilled' ? (largestResult.value?.value || []) : [];
    const supply     = supplyResult.status  === 'fulfilled' ? supplyResult.value?.value : null;

    if (!supply) return null;

    const totalSupply = parseFloat(supply.uiAmount || 0);
    // If supply is missing but token is known to exist, try to recover or fail safely
    if (totalSupply === 0) return null;

    if (largestArr.length === 0) {
      // If we have supply but no top accounts list, it might be a very new token not yet indexed.
      // We return a "CAUTION" state rather than null failure.
      return {
        available:      true,
        top10HolderPct: 100, // assume worst case (concentrated)
        whaleRisk:      'UNCERTAIN',
        note:           'Holder list not yet indexed by Helius (very new token)'
      };
    }

    const top10Amount = largestArr.slice(0, 10)
      .reduce((s, h) => s + parseFloat(h.uiAmount || 0), 0);
    const top10Pct = parseFloat(((top10Amount / totalSupply) * 100).toFixed(2));

    return {
      available:      true,
      top10HolderPct: top10Pct,
      whaleRisk:      top10Pct > 50 ? 'HIGH' : top10Pct > 30 ? 'MEDIUM' : 'LOW',
    };
  } catch (e) {
    console.warn(`[helius] getTokenHolderData error for ${tokenMint}: ${e.message}`);
    return null;
  }
}

// ─── Token activity (recent tx count) ────────────────────────────

export async function getTokenActivity(tokenMint, limit = 20) {
  try {
    const sigs = await heliusRpc('getSignaturesForAddress', [tokenMint, { limit }]);
    return { recentTxCount: Array.isArray(sigs) ? sigs.length : 0 };
  } catch {
    return { recentTxCount: 0 };
  }
}

// ─── Priority fee ────────────────────────────────────────────────
// Helius returns per-slot priority fee percentiles from recent blocks.
// Kita pakai P75 untuk balance antara kecepatan dan cost.

export async function getRecommendedPriorityFee(accountKeys = []) {
  const cacheKey = normalizeAccountKeySet(accountKeys);
  const cached = getCachedValue(_priorityFeeCache, cacheKey, PRIORITY_FEE_CACHE_TTL_MS);
  if (cached != null) return cached;

  if (_priorityFeeInflight.has(cacheKey)) {
    return _priorityFeeInflight.get(cacheKey);
  }

  const task = (async () => {
  try {
    // Helius enhanced getRecentPrioritizationFees — returns [{slot, prioritizationFee}]
    const fees = await heliusRpc('getRecentPrioritizationFees', [accountKeys]);
    if (!Array.isArray(fees) || fees.length === 0) {
      _priorityFeeCache.set(cacheKey, { at: Date.now(), value: 50000 });
      return 50000;
    }

    const sorted = fees
      .map(f => f.prioritizationFee || 0)
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    if (sorted.length === 0) {
      _priorityFeeCache.set(cacheKey, { at: Date.now(), value: 50000 });
      return 50000;
    }

    // P75 — lebih tinggi dari median untuk prioritas landing (Sultan Gas Mode)
    const p75idx = Math.floor(sorted.length * 0.75);
    const p75 = sorted[Math.min(p75idx, sorted.length - 1)];

    // Clamp: min 10000 (0.00001 SOL), max 1_000_000 (0.001 SOL - Sultan Safety)
    const value = Math.max(10000, Math.min(1000000, p75));
    _priorityFeeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`⚠️ [helius] Helius fee API failed, trying native fallback...`);
    try {
      // Native Solana Fallback: Tanya langsung ke jaringan
      const { getConnection } = await import('../solana/wallet.js');
      const { PublicKey } = await import('@solana/web3.js');
      const connection = getConnection();
      const nativeFees = await connection.getRecentPrioritizationFees(
        accountKeys.map(k => new PublicKey(k))
      );
      
      if (Array.isArray(nativeFees) && nativeFees.length > 0) {
        const sorted = nativeFees
          .map(f => f.prioritizationFee || 0)
          .filter(f => f > 0)
          .sort((a, b) => a - b);
        
        if (sorted.length > 0) {
          const p75idx = Math.floor(sorted.length * 0.75);
          const p75 = sorted[Math.min(p75idx, sorted.length - 1)];
          console.log(`✅ [helius] Native fallback success: ${p75} micro-lamports`);
          const value = Math.max(5000, Math.min(500000, p75));
          _priorityFeeCache.set(cacheKey, { at: Date.now(), value });
          return value;
        }
      }
    } catch (fallbackErr) {
      console.warn(`❌ [helius] Native fallback also failed: ${fallbackErr.message}`);
    }
    
    _priorityFeeCache.set(cacheKey, { at: Date.now(), value: 50000 });
    return 50000; // fallback final
  }
  })();

  _priorityFeeInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    _priorityFeeInflight.delete(cacheKey);
  }
}

// ─── Token metadata batch (Helius Enhanced API) ──────────────────
// Returns array of { account, onChainMetadata, offChainMetadata }

export async function getTokenMetadataBatch(mintAddresses) {
  if (!mintAddresses || mintAddresses.length === 0) return [];
  const key = process.env.HELIUS_API_KEY;
  if (!key) return [];

  try {
    const res = await fetchWithTimeout(
      `${getHeliusApiBase()}/token-metadata?api-key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringify({ mintAccounts: mintAddresses }),
      },
      12000
    );
    if (!res.ok) return [];
    return await res.json().catch(() => []);
  } catch {
    return [];
  }
}

// ─── Full on-chain signals (replaces getOnChainSignals in oracle) ─

export async function getHeliusOnChainSignals(tokenMint) {
  if (!process.env.HELIUS_API_KEY) {
    return { available: false, reason: 'HELIUS_API_KEY not set' };
  }

  const cacheKey = String(tokenMint || '').trim();
  const cachedEntry = _onChainSignalCache.get(cacheKey);
  if (cachedEntry) {
    const ttlMs = cachedEntry.ok ? ONCHAIN_SIGNAL_CACHE_TTL_MS : ONCHAIN_SIGNAL_FAILURE_TTL_MS;
    if ((Date.now() - cachedEntry.at) <= ttlMs) {
      return cachedEntry.value;
    }
    _onChainSignalCache.delete(cacheKey);
  }

  if (_onChainSignalInflight.has(cacheKey)) {
    return _onChainSignalInflight.get(cacheKey);
  }

  const task = (async () => {
    try {
    const [holderData, activity] = await Promise.allSettled([
      getTokenHolderData(tokenMint),
      getTokenActivity(tokenMint, 20),
    ]);

    const hd   = holderData.status === 'fulfilled' ? holderData.value : null;
    const act  = activity.status  === 'fulfilled' ? activity.value  : { recentTxCount: 0 };

    if (!hd) {
      const value = { available: false, reason: 'Gagal fetch holder data' };
      _onChainSignalCache.set(cacheKey, { at: Date.now(), value, ok: false });
      return value;
    }

    const value = {
      available:      true,
      recentTxCount:  act.recentTxCount,
      top10HolderPct: hd.top10HolderPct,
      whaleRisk:      hd.whaleRisk,
      tokenActive:    act.recentTxCount >= 5,
      dlmmNote: hd.whaleRisk === 'HIGH'
        ? 'Konsentrasi whale TINGGI — dump risk besar, SOL bisa ter-absorb kalau whale jual'
        : hd.whaleRisk === 'MEDIUM'
        ? 'Ada whale — monitor ketat, perlu exit cepat kalau ada dump'
        : 'Distribusi sehat — dump risk rendah, aman untuk LP',
    };
    _onChainSignalCache.set(cacheKey, { at: Date.now(), value, ok: true });
    return value;
  } catch (e) {
    const value = { available: false, reason: e.message };
    _onChainSignalCache.set(cacheKey, { at: Date.now(), value, ok: false });
    return value;
  }
  })();

  _onChainSignalInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    _onChainSignalInflight.delete(cacheKey);
  }
}

// ─── Export RPC manager utilities ────────────────────────────────

export function getRpcManager() {
  return _rpcManager || initializeRpcManager();
}

export function getRpcMetrics() {
  const manager = getRpcManager();
  return manager?.getMetrics() || { error: 'RPC manager not initialized' };
}

export function __resetHeliusCachesForTests() {
  _priorityFeeCache.clear();
  _priorityFeeInflight.clear();
  _onChainSignalCache.clear();
  _onChainSignalInflight.clear();
  _rpcManager = null;
}
