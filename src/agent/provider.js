import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getConfig } from '../config.js';

const PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

// ─── Clients ─────────────────────────────────────────────────────

let _anthropicClient = null;
let _openaiClient    = null;

function getAnthropicClient() {
  if (!_anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY tidak di-set di .env');
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

function getOpenRouterClient() {
  if (!_openaiClient) {
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY tidak di-set di .env');
    _openaiClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/meteora-dlmm-bot',
        'X-Title': 'Meteora DLMM Bot',
      },
    });
  }
  return _openaiClient;
}

function getOpenAIClient() {
  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY tidak di-set di .env');
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getCustomClient() {
  if (!process.env.CUSTOM_AI_BASE_URL) throw new Error('CUSTOM_AI_BASE_URL tidak di-set di .env');
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.CUSTOM_AI_API_KEY || 'dummy',
      baseURL: process.env.CUSTOM_AI_BASE_URL,
    });
  }
  return _openaiClient;
}

function getGroqClient() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY tidak di-set di .env');
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return _openaiClient;
}

function getHuggingFaceClient() {
  if (!process.env.HUGGINGFACE_API_KEY) throw new Error('HUGGINGFACE_API_KEY tidak di-set di .env');
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.HUGGINGFACE_API_KEY,
      baseURL: 'https://api-inference.huggingface.co/v1',
    });
  }
  return _openaiClient;
}

// ─── Model resolution ────────────────────────────────────────────
// Priority (highest → lowest):
//   1. AI_MODEL env var — set di .env, absolute override
//   2. cfg.activeModel  — diset via /model command (runtime override)
//   3. modelFromConfig  — per-component config (managementModel / screeningModel / generalModel)
//   4. provider default fallback

export function resolveModel(modelFromConfig) {
  // 1. Env var selalu menang — user set di .env = "saya mau model ini"
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  const cfg = getConfig();
  // 2. /model command override (session-level, hanya berlaku jika AI_MODEL tidak di-set)
  if (cfg.activeModel) return cfg.activeModel;
  // 3. Per-component config
  if (modelFromConfig) return modelFromConfig;
  // 4. Provider default
  const defaults = {
    openrouter:  'openai/gpt-4o-mini',
    anthropic:   'claude-haiku-4-5',
    openai:      'gpt-4o-mini',
    custom:      'gpt-4o-mini',
    groq:        'mixtral-8x7b-32768',
    huggingface: 'mistral-7b-instruct-v0.1',
  };
  return defaults[PROVIDER] || 'openai/gpt-4o-mini';
}

const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL || 'openai/gpt-4o-mini';

// ─── extractText — skip thinking blocks dari reasoning models ─────

export function extractText(response) {
  if (!response?.content?.length) return '';
  const block = response.content.find(b => b.type === 'text');
  return block?.text ?? '';
}

// ─── Format converters (Anthropic ↔ OpenAI) ──────────────────────

function toOAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function toOAIMessages(system, messages) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Tool results → OpenAI tool messages
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            result.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          result.push({ role: 'user', content: text || JSON.stringify(msg.content) });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textBlocks   = msg.content.filter(b => b.type === 'text');
        const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
        const assistantMsg = {
          role: 'assistant',
          content: textBlocks.map(b => b.text).join('\n') || null,
        };
        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        }
        result.push(assistantMsg);
      }
    }
  }
  return result;
}

function toAnthropicResponse(oaiResponse) {
  const choice  = oaiResponse.choices?.[0];
  const message = choice?.message;
  if (!message) return { content: [], stop_reason: 'end_turn' };

  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
  };
}

// ─── cleanError ───────────────────────────────────────────────────

function cleanError(e) {
  let msg = e?.message || String(e);
  if (msg.includes('<!DOCTYPE') || msg.includes('<html')) {
    const status = e?.status || e?.statusCode || '?';
    return `Model tidak ditemukan di provider (HTTP ${status}). Ganti model di .env.`;
  }
  return msg.slice(0, 200);
}

// ─── Response validators ─────────────────────────────────────────

function isValidResponse(response) {
  // Check if response has content
  if (!response) return false;

  // Anthropic format: { content: [{ type: 'text', text: '...' }, ...] }
  if (response.content && Array.isArray(response.content)) {
    if (response.content.length === 0) return false;
    // At least one non-empty text content block
    const hasText = response.content.some(b =>
      b.type === 'text' && b.text && String(b.text).trim().length > 0
    );
    return hasText;
  }

  return false;
}

function extractResponseText(response) {
  if (!response?.content?.length) return '';
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}

// ─── Core: createMessage ─────────────────────────────────────────
// Interface tetap sama untuk semua caller — provider-specific logic di sini.
// Improved: Better validation, fallback chains, and error handling

export async function createMessage({ model, maxTokens = 4096, system, tools, messages, forceModel }) {
  let resolvedModel = forceModel || resolveModel(model);
  let lastError;
  let usedFallback = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let response;

      if (PROVIDER === 'anthropic') {
        // ── Anthropic native ──────────────────────────────────
        const client = getAnthropicClient();
        const params = { model: resolvedModel, max_tokens: maxTokens, messages };
        if (system) params.system = system;
        if (tools?.length) params.tools = tools;
        response = await client.messages.create(params);

      } else {
        // ── OpenAI-compatible (openrouter / openai / custom / groq / huggingface) ──
        let client;
        if (PROVIDER === 'openai') client = getOpenAIClient();
        else if (PROVIDER === 'custom') client = getCustomClient();
        else if (PROVIDER === 'groq') client = getGroqClient();
        else if (PROVIDER === 'huggingface') client = getHuggingFaceClient();
        else client = getOpenRouterClient();

        const oaiMessages = toOAIMessages(system, messages);
        const params = {
          model: resolvedModel,
          max_tokens: maxTokens,
          messages: oaiMessages,
        };

        // Only include tools if model supports them
        const modelsWithoutTools = [
          'minimax/minimax-m2.7',
          'minimax/minimax-m2.5',
          'minimax-m2.7',
          'minimax-m2.5',
        ];
        if (tools?.length && !modelsWithoutTools.some(m => resolvedModel.includes(m))) {
          params.tools = toOAITools(tools);
        }

        const oaiResponse = await client.chat.completions.create(params);
        response = toAnthropicResponse(oaiResponse);
      }

      // ── Validate response content ──────────────────────────
      if (!isValidResponse(response)) {
        const text = extractResponseText(response);
        lastError = new Error(
          `Model "${resolvedModel}" returned empty/invalid response: "${text.slice(0, 50)}". ` +
          `Model mungkin overloaded, unsupported, atau response corrupted.`
        );
        console.warn(`⚠️ Attempt ${attempt + 1}: Invalid response from ${resolvedModel}`);

        // Fallback to fallback model on second attempt
        if (attempt === 1 && resolvedModel !== FALLBACK_MODEL && !usedFallback) {
          console.warn(`⚠️ Switching to fallback model: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          usedFallback = true;
          continue;
        }

        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      return response;

    } catch (e) {
      lastError = e;
      const status = e?.status || e?.statusCode;
      const isRateLimit = status === 429;
      const isNotFound = status === 404;
      const isServerError = status === 502 || status === 503 || status === 529 || status === 500;
      const isTimeout = e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT';

      // Rate limit — exponential backoff
      if (isRateLimit) {
        const wait = (attempt + 1) * 10000; // 10s, 20s, 30s
        console.warn(`⚠️ Rate limited, waiting ${wait / 1000}s... (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // Model tidak ditemukan → switch ke fallback
      if (isNotFound) {
        if (resolvedModel !== FALLBACK_MODEL && !usedFallback) {
          console.warn(`⚠️ Model "${resolvedModel}" not found (404), switching to fallback: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          usedFallback = true;
          continue;
        }
        throw new Error(`Model tidak tersedia: ${resolvedModel}. Cek AI_MODEL di .env`);
      }

      // Server error atau timeout → retry dengan fallback
      if (isServerError || isTimeout) {
        if (attempt === 1 && resolvedModel !== FALLBACK_MODEL && !usedFallback) {
          console.warn(`⚠️ Server error (${status || 'timeout'}), switching to fallback: ${FALLBACK_MODEL}`);
          resolvedModel = FALLBACK_MODEL;
          usedFallback = true;
          continue;
        }
        const delay = (attempt + 1) * 5000;
        console.warn(`⚠️ Server error (${status || 'timeout'}), retry in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Auth error — fail immediately
      if (status === 401 || status === 403) {
        throw new Error(`Authentication failed for ${PROVIDER}. Check your API keys in .env`);
      }

      break;
    }
  }

  const err = new Error(cleanError(lastError));
  err.status = lastError?.status;
  throw err;
}

const cfg = getConfig();
console.log(`🤖 AI Provider: ${PROVIDER} | Model: ${resolveModel(cfg?.managementModel)}`);
