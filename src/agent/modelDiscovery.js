/**
 * Universal Model Discovery & Management System
 *
 * Features:
 * - Discover ALL available models from configured providers
 * - Smart model selection based on performance tier and features
 * - Intelligent adaptive fallback that learns which models work
 * - Model quality scoring and ranking
 * - Dynamic model switching without restart
 * - Works across all providers (OpenRouter, Groq, OpenAI, Anthropic, HuggingFace)
 */

import fetch from 'node-fetch';

const PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

// Cache of discovered models and their status
let _modelCache = {
  available: [],       // All available models
  tested: {},          // { modelId: { ok: boolean, lastTested: timestamp, error?: string } }
  preferred: [],       // Ranked by quality and reliability
};

// Model quality tiers (lower number = better)
const QUALITY_TIERS = {
  'gpt-4': 1,
  'gpt-4o': 1,
  'claude-opus': 1,
  'claude-3-opus': 1,

  'gpt-3.5': 2,
  'claude-3-sonnet': 2,
  'claude-sonnet': 2,
  'llama-3.3': 2,
  'llama-3.1': 2,
  'gemini-pro': 2,

  'mixtral': 3,
  'llama-3': 3,
  'qwen': 3,
  'mistral': 3,

  'gemma': 4,
  'neural-chat': 4,

  'default': 999,
};

function getQualityTier(modelId) {
  for (const [tier, priority] of Object.entries(QUALITY_TIERS)) {
    if (modelId.toLowerCase().includes(tier)) {
      return priority;
    }
  }
  return QUALITY_TIERS['default'];
}

// ─── OpenRouter Discovery ───────────────────────────────────────────

async function discoverOpenRouterModels() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('⚠️ OPENROUTER_API_KEY not set, skipping OpenRouter model discovery');
    return [];
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });

    if (!res.ok) {
      console.warn(`⚠️ Failed to fetch OpenRouter models: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const models = (data.data || [])
      .filter(m => m.id && m.pricing)
      .map(m => ({
        id: m.id,
        provider: 'openrouter',
        name: m.name || m.id,
        pricing: m.pricing,
        contextLength: m.context_length,
        supportsTools: m.supports_function_calling !== false,  // Assume true by default
        isFree: m.pricing.prompt === '0' || m.pricing.prompt === 0,
      }));

    return models;
  } catch (e) {
    console.warn('❌ Error discovering OpenRouter models:', e.message);
    return [];
  }
}

// ─── Groq Discovery ─────────────────────────────────────────────────

async function discoverGroqModels() {
  if (!process.env.GROQ_API_KEY) {
    return [];
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });

    if (!res.ok) {
      console.warn(`⚠️ Failed to fetch Groq models: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const models = (data.data || [])
      .filter(m => m.id)
      .map(m => ({
        id: m.id,
        provider: 'groq',
        name: m.id,
        pricing: null,  // Groq is all free
        contextLength: m.context_length,
        supportsTools: true,
        isFree: true,
      }));

    return models;
  } catch (e) {
    console.warn('⚠️ Error discovering Groq models:', e.message);
    return [];
  }
}

// ─── HuggingFace Discovery ──────────────────────────────────────────

async function discoverHuggingFaceModels() {
  if (!process.env.HUGGINGFACE_API_KEY) {
    return [];
  }

  // HuggingFace has too many models, return common ones
  const commonModels = [
    'mistral-7b-instruct-v0.1',
    'mistral-7b-instruct-v0.2',
    'llama-2-70b-chat',
    'zephyr-7b-beta',
  ];

  return commonModels.map(id => ({
    id,
    provider: 'huggingface',
    name: id,
    pricing: null,
    contextLength: 4096,
    supportsTools: false,
    isFree: true,
  }));
}

// ─── Anthropic Available Models ──────────────────────────────────────

function getAnthropicModels() {
  if (!process.env.ANTHROPIC_API_KEY) return [];

  return [
    {
      id: 'claude-opus-4-6',
      provider: 'anthropic',
      name: 'Claude Opus 4.6',
      pricing: null,
      contextLength: 200000,
      supportsTools: true,
      isFree: false,
    },
    {
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Claude Sonnet 4.6',
      pricing: null,
      contextLength: 200000,
      supportsTools: true,
      isFree: false,
    },
    {
      id: 'claude-haiku-4-5',
      provider: 'anthropic',
      name: 'Claude Haiku 4.5',
      pricing: null,
      contextLength: 200000,
      supportsTools: true,
      isFree: false,
    },
  ];
}

// ─── OpenAI Available Models ─────────────────────────────────────────

function getOpenAIModels() {
  if (!process.env.OPENAI_API_KEY) return [];

  return [
    {
      id: 'gpt-4-turbo',
      provider: 'openai',
      name: 'GPT-4 Turbo',
      pricing: null,
      contextLength: 128000,
      supportsTools: true,
      isFree: false,
    },
    {
      id: 'gpt-4o',
      provider: 'openai',
      name: 'GPT-4o',
      pricing: null,
      contextLength: 128000,
      supportsTools: true,
      isFree: false,
    },
    {
      id: 'gpt-4o-mini',
      provider: 'openai',
      name: 'GPT-4o Mini',
      pricing: null,
      contextLength: 128000,
      supportsTools: true,
      isFree: false,
    },
  ];
}

// ─── Main Discovery ─────────────────────────────────────────────────

export async function discoverAllModels(force = false) {
  // Return cached if available and not forced
  if (_modelCache.available.length > 0 && !force) {
    return _modelCache.available;
  }

  console.log('🔍 Discovering available models...');

  const allModels = [];

  // Discover from all providers based on configured keys
  if (PROVIDER === 'openrouter' || process.env.OPENROUTER_API_KEY) {
    const orModels = await discoverOpenRouterModels();
    console.log(`  ✅ OpenRouter: ${orModels.length} models`);
    allModels.push(...orModels);
  }

  if (PROVIDER === 'groq' || process.env.GROQ_API_KEY) {
    const groqModels = await discoverGroqModels();
    console.log(`  ✅ Groq: ${groqModels.length} models`);
    allModels.push(...groqModels);
  }

  if (PROVIDER === 'huggingface' || process.env.HUGGINGFACE_API_KEY) {
    const hfModels = await discoverHuggingFaceModels();
    console.log(`  ✅ HuggingFace: ${hfModels.length} models`);
    allModels.push(...hfModels);
  }

  allModels.push(...getAnthropicModels());
  allModels.push(...getOpenAIModels());

  // Cache and rank
  _modelCache.available = allModels;
  rankModels();

  console.log(`✅ Total available models: ${allModels.length}`);
  return allModels;
}

function rankModels() {
  const available = _modelCache.available;
  const tested = _modelCache.tested;

  // Sort by: tested status, quality tier, then alphabetically
  const ranked = available.sort((a, b) => {
    // 1. Prefer tested and working models
    const aWorking = tested[a.id]?.ok === true;
    const bWorking = tested[b.id]?.ok === true;
    if (aWorking !== bWorking) return aWorking ? -1 : 1;

    // 2. Prefer by quality tier
    const aTier = getQualityTier(a.id);
    const bTier = getQualityTier(b.id);
    if (aTier !== bTier) return aTier - bTier;

    // 3. Prefer free models
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;

    // 4. Alphabetically
    return a.id.localeCompare(b.id);
  });

  _modelCache.preferred = ranked;
}

// ─── Model Testing & Status Tracking ────────────────────────────────

export function getModelStatus(modelId) {
  return _modelCache.tested[modelId] || { ok: null };
}

export function setModelStatus(modelId, ok, error = null) {
  _modelCache.tested[modelId] = {
    ok,
    lastTested: Date.now(),
    error,
  };
  rankModels();  // Re-rank after status update
}

// ─── Smart Model Selection ──────────────────────────────────────────

export function getBestModel(options = {}) {
  const {
    free = false,           // Prefer free models
    supportsTools = false,  // Require tool support
    quality = 'high',       // 'high', 'medium', 'low'
    excludeProviders = [],  // Exclude specific providers
    exclude = [],           // Exclude specific model IDs
  } = options;

  let candidates = _modelCache.preferred || _modelCache.available;

  // Filter by requirements
  candidates = candidates.filter(m => {
    if (excludeProviders.includes(m.provider)) return false;
    if (exclude.includes(m.id)) return false;
    if (free && !m.isFree) return false;
    if (supportsTools && !m.supportsTools) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.warn('⚠️ No models match criteria, returning first available');
    return _modelCache.available[0]?.id || null;
  }

  return candidates[0].id;
}

// ─── Intelligent Adaptive Fallback ──────────────────────────────────

let _fallbackChain = null;

export function buildAdaptiveFallbackChain(primaryModel, options = {}) {
  const {
    maxChainLength = 5,
    quality = 'high',
    free = false,
  } = options;

  const chain = [];
  const exclude = [primaryModel];

  for (let i = 0; i < maxChainLength; i++) {
    const model = getBestModel({
      free,
      quality,
      exclude,
    });

    if (!model) break;
    chain.push(model);
    exclude.push(model);
  }

  _fallbackChain = chain;
  console.log(`📋 Adaptive fallback chain: ${chain.length} models`);
  if (chain.length > 0) {
    console.log(`   Primary: ${primaryModel}`);
    chain.forEach((m, i) => console.log(`   Fallback ${i + 1}: ${m}`));
  }

  return chain;
}

export function getNextFallback() {
  if (!_fallbackChain || _fallbackChain.length === 0) {
    return null;
  }
  return _fallbackChain.shift();  // FIFO - use first, remove from chain
}

export function resetFallbackChain() {
  _fallbackChain = null;
}

// ─── Model Information & Formatting ─────────────────────────────────

export function getModelInfo(modelId) {
  const model = _modelCache.available.find(m => m.id === modelId);
  if (!model) return null;

  const status = getModelStatus(modelId);
  return {
    ...model,
    status,
  };
}

export function listAvailableModels(options = {}) {
  const { provider = null, free = null, sortBy = 'quality' } = options;

  let models = _modelCache.available;

  if (provider) models = models.filter(m => m.provider === provider);
  if (free !== null) models = models.filter(m => m.isFree === free);

  if (sortBy === 'quality') {
    models = [...models].sort((a, b) => {
      const aTier = getQualityTier(a.id);
      const bTier = getQualityTier(b.id);
      return aTier - bTier;
    });
  } else if (sortBy === 'name') {
    models = [...models].sort((a, b) => a.id.localeCompare(b.id));
  }

  return models;
}

export function formatModelList(models = null) {
  const list = models || _modelCache.available;
  if (list.length === 0) return '❌ No models available';

  const byProvider = {};
  for (const model of list) {
    if (!byProvider[model.provider]) byProvider[model.provider] = [];
    byProvider[model.provider].push(model);
  }

  let text = `📊 <b>Available Models</b> (${list.length} total)\n\n`;

  for (const [provider, models] of Object.entries(byProvider)) {
    text += `<b>${provider.toUpperCase()}</b> (${models.length})\n`;
    models.slice(0, 5).forEach(m => {
      const status = getModelStatus(m.id);
      const statusIcon = status.ok === true ? '✅' : status.ok === false ? '❌' : '❓';
      const freeIcon = m.isFree ? '🆓' : '💰';
      text += `${statusIcon} ${freeIcon} <code>${m.id}</code>\n`;
    });
    if (models.length > 5) {
      text += `   ... and ${models.length - 5} more\n`;
    }
    text += '\n';
  }

  return text;
}

// ─── Initialization ──────────────────────────────────────────────────

export async function initializeModelDiscovery() {
  try {
    await discoverAllModels(true);  // Force refresh on init
    return true;
  } catch (e) {
    console.error('❌ Model discovery initialization failed:', e.message);
    return false;
  }
}

// ─── Cache Utilities ────────────────────────────────────────────────

export function getModelCache() {
  return _modelCache;
}

export function clearModelCache() {
  _modelCache = {
    available: [],
    tested: {},
    preferred: [],
  };
}

export function exportModelCache() {
  return JSON.stringify(_modelCache, null, 2);
}

export function importModelCache(json) {
  try {
    _modelCache = JSON.parse(json);
    rankModels();
    return true;
  } catch (e) {
    console.error('❌ Failed to import model cache:', e.message);
    return false;
  }
}
