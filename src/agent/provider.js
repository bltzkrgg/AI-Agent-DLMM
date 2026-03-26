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
    openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    custom: 'gpt-4o',
  };
  return defaults[PROVIDER] || 'anthropic/claude-sonnet-4';
}

// Model fallback — dipakai otomatis saat provider error 502/503/529
const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// Bersihkan error message — buang HTML, batasi panjang
function cleanError(e) {
  let msg = e?.message || String(e);
  // Kalau isinya HTML (model tidak ditemukan / 404 OpenRouter), beri pesan yang jelas
  if (msg.includes('<!DOCTYPE') || msg.includes('<html')) {
    const status = e?.status || e?.statusCode || '?';
    return `Model tidak ditemukan di provider (HTTP ${status}). Ganti model di .env atau user-config.json.`;
  }
  // Batasi panjang supaya tidak spam
  return msg.slice(0, 200);
}

/**
 * createMessage with retry + model fallback — dari Meridian resilience patterns.
 * - Retry 3x dengan exponential backoff untuk error transient
 * - Auto switch ke fallback model di attempt ke-2 jika error 502/503/529
 * - Rate limit (429) tunggu 30s sebelum retry
 * - 404 = model tidak ada → langsung switch ke fallback
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

      // Model tidak ditemukan (404) — langsung switch ke fallback tanpa retry
      if (e.status === 404) {
        if (resolvedModel !== FALLBACK_MODEL) {
          console.warn(`⚠️ Model "${resolvedModel}" tidak ditemukan (404). Switch ke fallback: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          params.model = FALLBACK_MODEL;
          if (params.tools) delete params.tools;
          continue;
        }
        // Fallback juga 404 — lempar error yang bersih
        throw new Error(`Model tidak tersedia: ${resolvedModel}. Cek model di .env atau user-config.json`);
      }

      // Provider error — switch ke fallback model di attempt ke-2
      const isProviderError = e.status === 502 || e.status === 503 || e.status === 529 || e.status === 500;
      if (isProviderError) {
        if (attempt === 1 && resolvedModel !== FALLBACK_MODEL) {
          console.warn(`⚠️ Provider error (${e.status}), switching to fallback: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          params.model = FALLBACK_MODEL;
          if (params.tools) delete params.tools;
          continue;
        }
        const delay = (attempt + 1) * 5000;
        console.warn(`⚠️ Provider error (${e.status}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      break;
    }
  }

  // Bersihkan pesan error sebelum di-throw (buang HTML)
  const cleaned = cleanError(lastError);
  const err = new Error(cleaned);
  err.status = lastError?.status;
  throw err;
}

const cfg = getConfig();
console.log(`🤖 AI Provider: ${PROVIDER} | Model: ${resolveModel(cfg?.managementModel)}`);
