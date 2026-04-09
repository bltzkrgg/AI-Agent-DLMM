import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { safeParseAI } from '../utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LESSONS_PATH = join(__dirname, '../../lessons.json');


export function loadLessons() {
  if (!existsSync(LESSONS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LESSONS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveLessons(lessons) {
  try {
    writeFileSync(LESSONS_PATH, JSON.stringify(lessons, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save lessons.json:', e.message);
  }
}

// ─── Pin / Unpin lesson ───────────────────────────────────────────

export function pinLesson(indexOrId) {
  const lessons = loadLessons();
  const idx = typeof indexOrId === 'number' ? indexOrId : lessons.findIndex(l => l.id === indexOrId);
  if (idx < 0 || idx >= lessons.length) return { ok: false, reason: 'Index tidak valid' };
  lessons[idx].pinned = true;
  saveLessons(lessons);
  return { ok: true, lesson: lessons[idx].lesson };
}

export function unpinLesson(indexOrId) {
  const lessons = loadLessons();
  const idx = typeof indexOrId === 'number' ? indexOrId : lessons.findIndex(l => l.id === indexOrId);
  if (idx < 0 || idx >= lessons.length) return { ok: false, reason: 'Index tidak valid' };
  lessons[idx].pinned = false;
  saveLessons(lessons);
  return { ok: true };
}

export function deleteLesson(indexOrId) {
  const lessons = loadLessons();
  const idx = typeof indexOrId === 'number' ? indexOrId : lessons.findIndex(l => l.id === indexOrId);
  if (idx < 0 || idx >= lessons.length) return { ok: false, reason: 'Index tidak valid' };
  const removed = lessons.splice(idx, 1);
  saveLessons(lessons);
  return { ok: true, lesson: removed[0].lesson };
}

export function clearAllLessons() {
  saveLessons([]);
  return { ok: true };
}

// ─── Tiered lesson context injection ─────────────────────────────
// Tier 1: pinned (selalu muncul, max 5)
// Tier 2: cross-pool (berlaku di banyak pool, max 5)
// Tier 3: recent high-confidence (max 5)
// Role filter: jika role diberikan, prioritaskan lesson yang match

export function getLessonsContext(role = null) {
  const lessons = loadLessons();
  if (lessons.length === 0) return '';

  // Tier 1 — pinned
  const pinned = lessons.filter(l => l.pinned).slice(0, 5);

  // Tier 2 — cross-pool (berlaku lintas pool, bukan hanya satu pool)
  const crossPool = lessons
    .filter(l => !l.pinned && l.crossPool && (l.confidence || 0) >= 0.6)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 5);

  // Tier 3 — recent high-confidence (exclude yang sudah masuk tier 1/2)
  const usedTexts = new Set([...pinned, ...crossPool].map(l => l.lesson));
  const recent = lessons
    .filter(l => !l.pinned && !l.crossPool && !usedTexts.has(l.lesson))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(-10)
    .slice(0, 5);

  const allTiers = [
    ...pinned.map(l => ({ ...l, tier: 'PINNED' })),
    ...crossPool.map(l => ({ ...l, tier: 'CROSS-POOL' })),
    ...recent.map(l => ({ ...l, tier: 'RECENT' })),
  ];

  if (allTiers.length === 0) return '';

  const lines = allTiers.map((l, i) => `${i + 1}. [${l.tier}] ${l.lesson}`);
  return `\n\n📚 LESSONS LEARNED (${allTiers.length} aktif):\n${lines.join('\n')}`;
}

// ─── Format list untuk Telegram ──────────────────────────────────

export function formatLessonsList() {
  const lessons = loadLessons();
  if (lessons.length === 0) return 'Belum ada lessons tersimpan.';

  const sorted = [...lessons].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const recent = sorted.slice(0, 15);
  let text = `📚 *Lessons (${lessons.length} total)*\n\n`;
  for (let i = 0; i < recent.length; i++) {
    const l = recent[i];
    const pin = l.pinned ? '📌 ' : '';
    const cross = l.crossPool ? '🌐 ' : '';
    const conf = l.confidence ? ` (${(l.confidence * 100).toFixed(0)}%)` : '';
    text += `${i + 1}. ${pin}${cross}${l.lesson}${conf}\n`;
  }
  if (lessons.length > 15) text += `\n_...dan ${lessons.length - 15} lagi_`;
  return text;
}

async function fetchTopLpers(poolAddress) {
  try {
    // Fetch top LPers from Meteora API
    const url = `https://dlmm-api.meteora.ag/position/top_lpers?pool=${poolAddress}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    // Fallback: fetch recent positions from pool
    try {
      const res = await fetch(`https://dlmm-api.meteora.ag/position/list?pool=${poolAddress}&limit=20&sort_key=fee_claimed&order_by=desc`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}

export async function learnFromPool(poolAddress) {
  const topLpers = await fetchTopLpers(poolAddress);
  if (!topLpers) throw new Error(`Tidak bisa fetch data LPer dari pool ${poolAddress}`);

  const cfg = getConfig();

  const prompt = `Kamu adalah AI analyst untuk Meteora DLMM liquidity providing.

Analisa data top LPers berikut dari pool ${poolAddress}:
${JSON.stringify(topLpers, null, 2)}

Tugas kamu:
1. Identifikasi pola behavior yang membuat LPer ini sukses
2. Perhatikan: durasi hold, timing entry/exit, ukuran posisi, frekuensi rebalance
3. Ekstrak 4-6 lessons konkret dan actionable dalam Bahasa Indonesia
4. Prioritaskan pola yang muncul di banyak LPer (lebih generalizable)

Respond HANYA dengan JSON array, format:
[
  {
    "lesson": "teks lesson yang konkret dan actionable",
    "confidence": 0.0-1.0,
    "poolAddress": "${poolAddress}",
    "crossPool": false
  }
]

Jangan ada teks lain selain JSON.`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = extractText(response).trim();
  const newLessons = safeParseAI(text, []);
  if (!Array.isArray(newLessons) || newLessons.length === 0) return [];

  // Merge dengan lessons yang ada
  const existing = loadLessons();
  const merged = [
    ...existing,
    ...newLessons.map(l => ({ ...l, learnedAt: new Date().toISOString() }))
  ];

  // Keep max 50 lessons, prioritize pinned + high confidence
  const sorted = merged.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });
  const kept = sorted.slice(0, 50);
  saveLessons(kept);

  return newLessons;
}

export async function learnFromMultiplePools(poolAddresses) {
  const allLessons = [];
  const errors = [];

  for (const addr of poolAddresses) {
    try {
      const lessons = await learnFromPool(addr);
      allLessons.push(...lessons);
    } catch (e) {
      errors.push({ pool: addr, error: e.message });
    }
  }

  // Mark cross-pool patterns
  const lessonTexts = allLessons.map(l => l.lesson);
  const cfg = getConfig();

  if (allLessons.length > 0) {
    const crossPoolPrompt = `Dari lessons berikut yang dikumpulkan dari ${poolAddresses.length} pool berbeda:
${lessonTexts.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Identifikasi mana yang merupakan pola cross-pool (muncul di banyak pool).
Respond HANYA dengan JSON array index (0-based) yang cross-pool. Contoh: [0, 2, 5]`;

    try {
      const res = await createMessage({
        model: resolveModel(cfg.generalModel),
        maxTokens: 200,
        messages: [{ role: 'user', content: crossPoolPrompt }],
      });
      const indices = JSON.parse(res.content[0].text.trim().replace(/```json|```/g, ''));
      indices.forEach(i => {
        if (allLessons[i]) {
          allLessons[i].crossPool = true;
          allLessons[i].confidence = Math.min(1.0, (allLessons[i].confidence || 0.5) + 0.2);
        }
      });
    } catch {
      // ignore cross-pool tagging errors
    }
  }

  return { lessons: allLessons, errors };
}
