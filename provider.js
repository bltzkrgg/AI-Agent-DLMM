/**
 * AI Provider Abstraction Layer
 * 
 * Support: Anthropic (default), OpenRouter, atau provider lain
 * yang compatible dengan OpenAI API format.
 * 
 * Config di .env:
 *   AI_PROVIDER=anthropic     → pakai Anthropic SDK (default)
 *   AI_PROVIDER=openrouter    → pakai OpenRouter
 *   AI_PROVIDER=openai        → pakai OpenAI
 *   AI_PROVIDER=custom        → pakai custom base URL
 * 
 * Model di user-config.json atau .env:
 *   AI_MODEL=claude-sonnet-4-20250514         (Anthropic)
 *   AI_MODEL=anthropic/claude-sonnet-4         (OpenRouter)
 *   AI_MODEL=openai/gpt-4o                    (OpenRouter)
 *   AI_MODEL=google/gemini-2.0-flash           (OpenRouter)
 *   AI_MODEL=deepseek/deepseek-r1             (OpenRouter)
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

// ─── Build client based on provider ─────────────────────────────

function buildClient() {
  switch (PROVIDER) {
    case 'openrouter':
      if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY tidak di-set di .env');
      // OpenRouter compatible dengan Anthropic SDK via base URL
      return new Anthropic({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/meteora-dlmm-bot',
          'X-Title': 'Meteora DLMM Bot',
        },
      });

    case 'openai':
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY tidak di-set di .env');
      return new Anthropic({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: 'https://api.openai.com/v1',
      });

    case 'custom':
      if (!process.env.CUSTOM_AI_BASE_URL) throw new Error('CUSTOM_AI_BASE_URL tidak di-set di .env');
      return new Anthropic({
        apiKey: process.env.CUSTOM_AI_API_KEY || 'dummy',
        baseURL: process.env.CUSTOM_AI_BASE_URL,
      });

    case 'anthropic':
    default:
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY tidak di-set di .env');
      return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
}

let _client = null;
export function getClient() {
  if (!_client) _client = buildClient();
  return _client;
}

// ─── Resolve model name ──────────────────────────────────────────

export function resolveModel(modelFromConfig) {
  // Priority: .env AI_MODEL > user-config model > default per provider
  const envModel = process.env.AI_MODEL;
  if (envModel) return envModel;
  if (modelFromConfig) return modelFromConfig;

  // Default models per provider
  const defaults = {
    anthropic: 'claude-sonnet-4-20250514',
    openrouter: 'anthropic/claude-sonnet-4',
    openai: 'gpt-4o',
    custom: 'gpt-4o',
  };
  return defaults[PROVIDER] || 'claude-sonnet-4-20250514';
}

// ─── Unified messages call ───────────────────────────────────────

export async function createMessage({ model, maxTokens = 4096, system, tools, messages }) {
  const client = getClient();
  const resolvedModel = resolveModel(model);

  const params = {
    model: resolvedModel,
    max_tokens: maxTokens,
    messages,
  };

  if (system) params.system = system;

  // Tools hanya support di Anthropic & OpenRouter (model tertentu)
  // Untuk provider lain, tools di-inject ke system prompt sebagai teks
  if (tools && tools.length > 0) {
    if (PROVIDER === 'anthropic' || PROVIDER === 'openrouter') {
      params.tools = tools;
    } else {
      // Fallback: inject tool descriptions ke system prompt
      const toolDesc = tools.map(t =>
        `Tool: ${t.name}\nDescription: ${t.description}\nInput: ${JSON.stringify(t.input_schema)}`
      ).join('\n\n');
      params.system = (params.system || '') + `\n\nAvailable tools:\n${toolDesc}\n\nTo use a tool, respond with JSON: {"tool": "name", "input": {...}}`;
    }
  }

  return client.messages.create(params);
}

// ─── Provider info ───────────────────────────────────────────────

export function getProviderInfo() {
  const cfg = getConfig();
  return {
    provider: PROVIDER,
    model: resolveModel(cfg.managementModel),
    apiKeySet: !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.CUSTOM_AI_API_KEY
    ),
  };
}

console.log(`🤖 AI Provider: ${PROVIDER} | Model: ${resolveModel(getConfig()?.managementModel)}`);
