/**
 * Model Validator
 *
 * - Startup check: test model aktif, warn jika gagal
 * - Fetch free models dari OpenRouter secara live
 * - Suggest model alternatif jika model saat ini error
 */

import { createMessage, resolveModel, extractText } from './provider.js';
import { getConfig } from '../config.js';

const PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

// ─── Test apakah model bisa dipakai sekarang ──────────────────────

export async function testCurrentModel() {
  const cfg = getConfig();
  const model = resolveModel(cfg.generalModel);

  try {
    const res = await createMessage({
      model,
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const text = extractText(res);
    return { ok: true, model, response: text };
  } catch (e) {
    return { ok: false, model, error: e.message };
  }
}

// ─── Test model spesifik (untuk /model command) ───────────────────

export async function testModel(modelId) {
  try {
    const res = await createMessage({
      forceModel: modelId,    // bypass resolveModel — test model ini langsung
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    if (!res?.content?.length) return { ok: false, model: modelId, error: 'Empty response' };
    return { ok: true, model: modelId };
  } catch (e) {
    return { ok: false, model: modelId, error: e.message };
  }
}

// ─── Fetch free models dari berbagai provider ───────────────────

export async function fetchFreeModels() {
  const freeModels = [];
  // Blocked models that should never be suggested
  const blockedModels = new Set([
    'minimax/minimax-m2.5',
    'minimax/minimax-m2.7',
    'minimax-m2.5',
    'minimax-m2.7',
  ]);

  // OpenRouter free models
  if (PROVIDER === 'openrouter' || process.env.OPENROUTER_API_KEY) {
    try {
      const key = process.env.OPENROUTER_API_KEY;
      if (key) {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) {
          const data = await res.json();
          const orFree = (data.data || [])
            .filter(m => m.id.endsWith(':free') && !blockedModels.has(m.id))
            .map(m => m.id);
          freeModels.push(...orFree.slice(0, 10));
        }
      }
    } catch (e) {
      console.warn('Failed to fetch OpenRouter free models:', e.message);
    }
  }

  // Groq free models (jika ada key)
  if (process.env.GROQ_API_KEY) {
    freeModels.push(
      'groq/mixtral-8x7b-32768',
      'groq/llama2-70b-4096',
      'groq/gemma-7b-it'
    );
  }

  // HuggingFace free inference (jika ada key)
  if (process.env.HUGGINGFACE_API_KEY) {
    freeModels.push(
      'huggingface/mistral-7b-instruct-v0.1',
      'huggingface/zephyr-7b-beta'
    );
  }

  // Fallback free models
  if (freeModels.length === 0) {
    freeModels.push(
      'openai/gpt-4o-mini',
      'qwen/qwen3.6-plus:free',
      'meta-llama/llama-2-70b-chat'
    );
  }

  return freeModels;
}

// ─── Format pesan status model — INSTANT, tanpa API call ─────────
// Tidak lagi test model di sini agar /model (no args) tidak delay.
// Gunakan /testmodel untuk test API call secara eksplisit.

export function formatModelStatus() {
  const cfg = getConfig();
  const activeModel  = resolveModel(cfg.generalModel);
  const envModel     = process.env.AI_MODEL;
  const sessionModel = cfg.activeModel;

  let text = `🤖 *Model Status*\n\n`;
  text += `Provider : \`${PROVIDER}\`\n`;
  text += `Aktif    : \`${activeModel}\`\n\n`;

  if (envModel) {
    text += `📌 \`AI_MODEL\` env: \`${envModel}\` _(tertinggi)_\n`;
  }
  if (sessionModel) {
    text += `🎮 Session \`/model\`: \`${sessionModel}\`${envModel ? ' _(diabaikan karena AI\\_MODEL di env)_' : ''}\n`;
  }

  text += `\n*Slot model:*\n`;
  text += `• General  : \`${cfg.generalModel}\`\n`;
  text += `• Screening: \`${cfg.screeningModel}\`\n`;
  text += `• Mgmt     : \`${cfg.managementModel}\`\n`;

  text += `\n_Gunakan \`/testmodel\` untuk test koneksi API._\n`;
  text += `_Ganti model: \`/model <model\\_id>\` atau set \`AI\\_MODEL\` di .env_\n`;
  text += `_Reset session: \`/model reset\`_`;

  return text;
}

// ─── Startup check — dipanggil saat bot start ─────────────────────

export async function runStartupModelCheck(notifyFn) {
  try {
    const result = await testCurrentModel();
    if (!result.ok) {
      const freeModels = await fetchFreeModels();
      let msg = `⚠️ *Model tidak bisa dipakai!*\n\nModel: \`${result.model}\`\nError: ${result.error}\n`;
      if (freeModels.length > 0) {
        msg += `\n*Ganti model tanpa restart:*\n`;
        freeModels.slice(0, 5).forEach(m => { msg += `• \`/model ${m}\`\n`; });
        msg += `\nAtau set \`AI_MODEL\` di .env lalu restart.`;
      }
      await notifyFn(msg);
    } else {
      console.log(`✅ Model check OK: ${result.model}`);
    }
  } catch (e) {
    console.error('Startup model check error:', e.message);
  }
}
