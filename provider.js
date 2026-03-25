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

/**
 * createMessage with retry — handles transient API errors
 */
export async function createMessage({ model, maxTokens = 4096, system, tools, messages }) {
  const client = getClient();
  const resolvedModel = resolveModel(model);

  const params = {
    model: resolvedModel,
    max_tokens: maxTokens,
    messages,
  };

  if (system) params.system = system;
  if (tools && tools.length > 0) {
    // Tools supported on Anthropic and OpenRouter
    if (PROVIDER === 'anthropic' || PROVIDER === 'openrouter') {
      params.tools = tools;
    } else {
      // Fallback: inject tool descriptions into system prompt
      const toolDesc = tools.map(t =>
        `Tool: ${t.name}\nDescription: ${t.description}\nInput schema: ${JSON.stringify(t.input_schema)}`
      ).join('\n\n');
      params.system = (params.system || '') +
        `\n\nAvailable tools:\n${toolDesc}\n\nTo call a tool, respond with JSON: {"tool": "name", "input": {...}}`;
    }
  }

  // Retry up to 3 times with exponential backoff
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastError = e;
      const isRetryable = e.status === 429 || e.status === 500 || e.status === 503 || e.code === 'ECONNRESET';
      if (!isRetryable || attempt === 2) break;
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`⚠️ AI API error (attempt ${attempt + 1}/3), retrying in ${delay}ms: ${e.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

const cfg = getConfig();
console.log(`🤖 AI Provider: ${PROVIDER} | Model: ${resolveModel(cfg?.managementModel)}`);
