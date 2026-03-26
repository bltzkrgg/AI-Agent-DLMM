import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';

const PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

function buildClient() {
  switch (PROVIDER) {
    case 'openrouter':
      if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY tidak di-set di .env');
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

export function resolveModel(modelFromConfig) {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (modelFromConfig) return modelFromConfig;
  const defaults = {
    openrouter: 'anthropic/claude-sonnet-4',
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    custom: 'gpt-4o',
  };
  return defaults[PROVIDER] || 'anthropic/claude-sonnet-4';
}

// Model fallback — dipakai otomatis saat provider error 502/503/529
const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL || 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free';

/**
 * createMessage with retry + model fallback — dari Meridian resilience patterns.
 * - Retry 3x dengan exponential backoff untuk error transient
 * - Auto switch ke fallback model di attempt ke-2 jika error 502/503/529
 * - Rate limit (429) tunggu 30s sebelum retry
 */
export async function createMessage({ model, maxTokens = 4096, system, tools, messages }) {
  const client = getClient();
  let resolvedModel = resolveModel(model);

  const params = {
    model: resolvedModel,
    max_tokens: maxTokens,
    messages,
  };

  if (system) params.system = system;
  if (tools && tools.length > 0) {
    if (PROVIDER === 'anthropic' || PROVIDER === 'openrouter') {
      params.tools = tools;
    } else {
      const toolDesc = tools.map(t =>
        `Tool: ${t.name}\nDescription: ${t.description}\nInput schema: ${JSON.stringify(t.input_schema)}`
      ).join('\n\n');
      params.system = (params.system || '') +
        `\n\nAvailable tools:\n${toolDesc}\n\nTo call a tool, respond with JSON: {"tool": "name", "input": {...}}`;
    }
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.messages.create(params);
      // Cek respons kosong (bug beberapa model free)
      if (!response?.content?.length) {
        lastError = new Error('API returned empty content');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      return response;
    } catch (e) {
      lastError = e;

      // Rate limit — tunggu 30 detik
      if (e.status === 429) {
        console.warn(`⚠️ Rate limited, waiting 30s... (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }

      // Provider error — switch ke fallback model di attempt ke-2
      const isProviderError = e.status === 502 || e.status === 503 || e.status === 529 || e.status === 500;
      if (isProviderError) {
        if (attempt === 1 && resolvedModel !== FALLBACK_MODEL) {
          console.warn(`⚠️ Provider error (${e.status}), switching to fallback model: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          params.model = FALLBACK_MODEL;
          // Hapus tools jika model fallback mungkin tidak support
          if (params.tools) delete params.tools;
          continue;
        }
        const delay = (attempt + 1) * 5000;
        console.warn(`⚠️ Provider error (${e.status}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Error tidak bisa di-retry
      break;
    }
  }
  throw lastError;
}

const cfg = getConfig();
console.log(`🤖 AI Provider: ${PROVIDER} | Model: ${resolveModel(cfg?.managementModel)}`);
