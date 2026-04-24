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

  // Fallback free models (guaranteed to exist on OpenRouter)
  if (freeModels.length === 0) {
    freeModels.push(
      'meta-llama/llama-3.3-70b-instruct:free',      // Proven to work
      'qwen/qwen3-next-80b-a3b-instruct:free',       // Alternative
      'google/gemma-4-26b-a4b-it:free'               // Another option
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

  let text = `🤖 <b>Model Status</b>\n\n`;
  text += `Provider : <code>${PROVIDER}</code>\n`;
  text += `Aktif    : <code>${activeModel}</code>\n\n`;

  if (envModel) {
    text += `📌 <code>AI_MODEL</code> env: <code>${envModel}</code> <i>(tertinggi)</i>\n`;
  }
  if (sessionModel) {
    text += `🎮 Session <code>/model</code>: <code>${sessionModel}</code>${envModel ? ' <i>(diabaikan karena AI_MODEL di env)</i>' : ''}\n`;
  }

  text += `\n<b>Slot model:</b>\n`;
  text += `• General  : <code>${cfg.generalModel}</code>\n`;
  text += `• Screening: <code>${cfg.screeningModel}</code>\n`;
  text += `• Mgmt     : <code>${cfg.managementModel}</code>\n`;

  text += `\n<i>Gunakan <code>/testmodel</code> untuk test koneksi API.</i>\n`;
  text += `<i>Ganti model: <code>/model &lt;model_id&gt;</code> atau set <code>AI_MODEL</code> di .env</i>\n`;
  text += `<i>Reset session: <code>/model reset</code></i>`;

  return text;
}

// ─── Startup check — fire-and-forget, non-blocking ───────────────
// Tidak memblokir startup. Notifikasi hanya dikirim saat model gagal.

export function runStartupModelCheck(notifyFn) {
  (async () => {
    try {
      const result = await testCurrentModel();
      if (!result.ok) {
        const freeModels = await fetchFreeModels();
        let msg = `⚠️ <b>Model tidak bisa dipakai!</b>\n\nModel: <code>${result.model}</code>\nError: ${result.error}\n`;
        if (freeModels.length > 0) {
          msg += `\n<b>Ganti model tanpa restart:</b>\n`;
          freeModels.slice(0, 5).forEach(m => { msg += `• <code>/model ${m}</code>\n`; });
          msg += `\nAtau set <code>AI_MODEL</code> di .env lalu restart.`;
        }
        await notifyFn(msg);
      } else {
        console.log(`✅ Model check OK: ${result.model}`);
      }
    } catch (e) {
      console.error('Startup model check error:', e.message);
    }
  })();
}
