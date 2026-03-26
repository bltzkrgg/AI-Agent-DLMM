import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMessage, resolveModel, extractText } from '../agent/provider.js';
import { getConfig } from '../config.js';

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

export function getLessonsContext() {
  const lessons = loadLessons();
  if (lessons.length === 0) return '';
  const recent = lessons.slice(-10);
  return `\n\n📚 LESSONS FROM TOP LPers:\n${recent.map((l, i) => `${i + 1}. ${l.lesson}`).join('\n')}`;
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
  const clean = text.replace(/```json|```/g, '').trim();
  const newLessons = JSON.parse(clean);

  // Merge dengan lessons yang ada
  const existing = loadLessons();
  const merged = [
    ...existing,
    ...newLessons.map(l => ({ ...l, learnedAt: new Date().toISOString() }))
  ];

  // Keep max 50 lessons, prioritize high confidence
  const sorted = merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
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
