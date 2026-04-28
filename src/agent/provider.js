import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getConfig } from '../config.js';
import { globalRateLimiter } from '../utils/rateLimiter.js';
import { stringify } from '../utils/safeJson.js';
import {
  discoverAllModels,
  getBestModel,
  buildAdaptiveFallbackChain,
  getNextFallback,
  resetFallbackChain,
  setModelStatus,
  getModelStatus,
} from './modelDiscovery.js';

const PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

// ─── Clients ─────────────────────────────────────────────────────

let _anthropicClient = null;
let _openaiClient    = null;
let _nvidiaClient    = null;

function getNvidiaClient() {
  if (!_nvidiaClient) {
    if (!process.env.NVIDIA_API_KEY) {
      return getOpenRouterClient();
    }
    _nvidiaClient = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });
  }
  return _nvidiaClient;
}

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

// Models yang diketahui fail silent atau return empty di OpenRouter.
// Catatan: penggantian model sekarang dilakukan via .env (SCREENING_MODEL / MANAGEMENT_MODEL / AGENT_MODEL).
// Daftar ini hanya untuk model yang confirm broken, bukan untuk membatasi pilihan user.
const BLOCKED_MODELS = new Set([
  // Minimax versi non-free terbukti fail silent — versi :free boleh dipakai
  'minimax/minimax-m2.7',
  'minimax-m2.7',
]);

export function resolveModel(modelFromConfig) {
  // Penggantian model via .env (SCREENING_MODEL / MANAGEMENT_MODEL / AGENT_MODEL).
  // Priority (highest → lowest):
  //   1. AI_MODEL env var  — set di .env, global override semua komponen
  //   2. cfg.activeModel   — diset via /model command (session-level override)
  //   3. modelFromConfig   — per-component model (screeningModel/managementModel/agentModel)
  //   4. cfg.agentModel    — fallback ke model agen utama jika komponen tidak punya model sendiri
  //   5. Provider default  — last resort

  // 1. AI_MODEL global override
  let model = process.env.AI_MODEL;
  if (model && BLOCKED_MODELS.has(model)) {
    console.warn(`⚠️ Model "${model}" dari AI_MODEL env diblokir. Pakai safe default.`);
    model = null;
  }
  if (model) return model;

  const cfg = getConfig();

  // 2. /model command override (session-level)
  model = cfg.activeModel;
  if (model && BLOCKED_MODELS.has(model)) {
    console.warn(`⚠️ Model "${model}" dari /model command diblokir. Pakai safe default.`);
    model = null;
  }
  if (model) return model;

  // 3. Per-component model (dari config / env)
  model = modelFromConfig;
  if (model && BLOCKED_MODELS.has(model)) {
    console.warn(`⚠️ Model "${model}" dari config diblokir. Pakai safe default.`);
    model = null;
  }
  if (model) return model;

  // 4. Fallback ke agentModel (model utama — biasanya paling capable)
  model = cfg.agentModel;
  if (model && !BLOCKED_MODELS.has(model)) return model;

  // 5. Provider default — last resort (tidak perlu memblokir deepseek atau model lain di sini)
  const defaults = {
    openrouter:  'deepseek/deepseek-v3.2',
    anthropic:   'claude-haiku-4-5',
    openai:      'gpt-4o-mini',
    custom:      'gpt-4o-mini',
    groq:        'mixtral-8x7b-32768',
    huggingface: 'mistral-7b-instruct-v0.1',
  };
  return defaults[PROVIDER] || 'deepseek/deepseek-v3.2';
}

// Intelligent fallback chain based on available provider keys
// Uses only models that are known to exist and work reliably
// ⚠️ IMPORTANT: OpenRouter model availability changes frequently.
//   Last verified: Jan 2025
//   qwen/qwen3.6-plus:free NO LONGER EXISTS (removed from OpenRouter)
//   Use meta-llama/llama-3.3-70b-instruct:free instead
function getFallbackModel() {
  const fallback = process.env.FALLBACK_AI_MODEL;
  if (fallback && !BLOCKED_MODELS.has(fallback)) {
    return fallback;
  }

  // Build fallback chain based on what provider keys are available
  // Order prioritizes reliability and speed
  const fallbacks = [];

  if (process.env.OPENROUTER_API_KEY) {
    // Use models KNOWN to exist on OpenRouter and work reliably (verified Jan 2025)
    fallbacks.push('meta-llama/llama-3.3-70b-instruct:free');      // ✅ Verified working, high quality
    fallbacks.push('qwen/qwen3-next-80b-a3b-instruct:free');       // ✅ Alternative Qwen (newer version)
    fallbacks.push('google/gemma-4-26b-a4b-it:free');              // ✅ Google's Gemma
  }
  if (process.env.GROQ_API_KEY) {
    fallbacks.push('mixtral-8x7b-32768');
    fallbacks.push('llama-3.3-70b-versatile');                     // Latest Llama on Groq
  }
  if (process.env.OPENAI_API_KEY) {
    fallbacks.push('gpt-4o-mini');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    fallbacks.push('claude-haiku-4-5');
  }

  // Default fallback if nothing else configured - use proven OpenRouter free model
  if (fallbacks.length === 0) {
    fallbacks.push('meta-llama/llama-3.3-70b-instruct:free');
  }

  return fallbacks[0];
}

const FALLBACK_MODEL = getFallbackModel();

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
              content: typeof tr.content === 'string' ? tr.content : stringify(tr.content),
            });
          }
        } else {
          const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          result.push({ role: 'user', content: text || stringify(msg.content) });
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
            function: { name: b.name, arguments: stringify(b.input) },
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
    // At least one non-empty text content block OR a tool use block
    const hasText = response.content.some(b =>
      b.type === 'text' && b.text && String(b.text).trim().length > 0
    );
    const hasTools = response.content.some(b => b.type === 'tool_use');
    return hasText || hasTools;
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

  // Block minimax models — they fail silently on OpenRouter
  if (BLOCKED_MODELS.has(resolvedModel)) {
    throw new Error(`Model "${resolvedModel}" is blocked (known to fail). Please choose a different model in .env`);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let response;

      if (PROVIDER === 'anthropic') {
        // ── Anthropic native ──────────────────────────────────
        const client = getAnthropicClient();
        const params = { model: resolvedModel, max_tokens: maxTokens, messages };
        if (system) params.system = system;
        if (tools?.length) params.tools = tools;
        
        await globalRateLimiter.acquire('api.anthropic.com');
        response = await client.messages.create(params);

      } else {
        // ── OpenAI-compatible (openrouter / openai / custom / groq / huggingface / nvidia) ──
        let client;
        if (PROVIDER === 'openai') client = getOpenAIClient();
        else if (PROVIDER === 'custom') client = getCustomClient();
        else if (PROVIDER === 'groq') client = getGroqClient();
        else if (PROVIDER === 'huggingface') client = getHuggingFaceClient();
        else if (resolvedModel.startsWith('nvidia/')) client = getNvidiaClient();
        else client = getOpenRouterClient();

        const oaiMessages = toOAIMessages(system, messages);
        const params = {
          model: resolvedModel,
          max_tokens: maxTokens,
          messages: oaiMessages,
        };
        
        // ... tool support logic ...
        const modelsWithoutTools = [
          'minimax/minimax-m2.7',
          'minimax/minimax-m2.5',
          'minimax-m2.7',
          'minimax-m2.5',
        ];
        const supportsTools = !modelsWithoutTools.some(m => resolvedModel.includes(m));
        if (tools?.length && supportsTools) {
          params.tools = toOAITools(tools);
        }

        const hostname = PROVIDER === 'openai' ? 'api.openai.com'
                       : PROVIDER === 'groq'   ? 'api.groq.com'
                       : 'openrouter.ai';
                       
        await globalRateLimiter.acquire(hostname);
        const oaiResponse = await client.chat.completions.create(params);
        response = toAnthropicResponse(oaiResponse);
      }

      // ── Validate response content ──────────────────────────
      if (!isValidResponse(response)) {
        const text = extractResponseText(response);
        lastError = new Error(
          `Model "${resolvedModel}" returned empty/invalid response. ` +
          `Model mungkin overloaded, unsupported, atau response corrupted.`
        );
        console.warn(`⚠️ Attempt ${attempt + 1}: Invalid response from ${resolvedModel}. Retrying...`);
        setModelStatus(resolvedModel, false, 'Empty response');

        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      // Mark model as working
      setModelStatus(resolvedModel, true);

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
        const wait = (attempt + 1) * 20000; // 20s, 40s, 60s
        console.warn(`⚠️ Rate limited, waiting ${wait / 1000}s... (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // Server error atau timeout → retry model yang sama
      if (isServerError || isTimeout || isNotFound) {
        const delay = (attempt + 1) * 5000;
        console.warn(`⚠️ AI Error (${status || 'timeout'}), retry in ${delay}ms... (attempt ${attempt + 1}/3)`);
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
console.log(
  `🤖 AI Provider : ${PROVIDER}\n` +
  `   Screening  : ${resolveModel(cfg?.screeningModel)}   (SCREENING_MODEL env)\n` +
  `   Management : ${resolveModel(cfg?.managementModel)}  (MANAGEMENT_MODEL env)\n` +
  `   Agent      : ${resolveModel(cfg?.agentModel)}       (AGENT_MODEL env)`
);
