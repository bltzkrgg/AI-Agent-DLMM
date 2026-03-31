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

// ─── Fetch free models dari OpenRouter ───────────────────────────

export async function fetchFreeModels() {
  if (PROVIDER !== 'openrouter') return [];
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.id.endsWith(':free'))
      .map(m => m.id);
  } catch {
    return [];
  }
}

// ─── Format pesan status model untuk Telegram ────────────────────

export async function formatModelStatus() {
  const result = await testCurrentModel();
  const freeModels = await fetchFreeModels();

  let text = `🤖 *Model Status*\n\n`;
  text += `Provider: \`${PROVIDER}\`\n`;
  text += `Model: \`${result.model}\`\n`;
  text += result.ok
    ? `Status: ✅ OK\n`
    : `Status: ❌ Error — ${result.error}\n`;

  if (!result.ok && freeModels.length > 0) {
    text += `\n💡 *Free models yang tersedia sekarang:*\n`;
    freeModels.slice(0, 8).forEach(m => { text += `• \`${m}\`\n`; });
    text += `\nGanti di \`.env\`:\n\`AI_MODEL=<nama model>\`\nlalu restart bot.`;
  }

  if (result.ok && freeModels.length > 0) {
    text += `\n\n📋 *Semua free models tersedia (${freeModels.length}):*\n`;
    freeModels.slice(0, 10).forEach(m => { text += `• \`${m}\`\n`; });
  }

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
