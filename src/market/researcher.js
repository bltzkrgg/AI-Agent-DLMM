import { safeParseAI, fetchWithTimeout } from '../utils/safeJson.js';
/**
 * Strategy Researcher
 * 
 * Extract strategi DLMM dari artikel yang di-paste user.
 * Menghasilkan strategi terstruktur yang disimpan ke Strategy Library.
 */

import { createMessage, resolveModel } from '../agent/provider.js';
import { getConfig } from '../config.js';
import { addResearchedStrategy } from './strategyLibrary.js';

export async function extractStrategiesFromArticle(articleText) {
  const cfg = getConfig();

  const systemPrompt = `Kamu adalah peneliti strategi DLMM (Dynamic Liquidity Market Maker) untuk Meteora di Solana.

Tugasmu: extract strategi LP yang konkret dari artikel yang diberikan.

Untuk setiap strategi yang ditemukan, extract:
1. Nama strategi
2. Kondisi market yang cocok (trend, volatilitas, sentiment, volume)
3. Parameter teknis (range %, bin step, distribusi token)
4. Kondisi entry yang ideal
5. Kondisi exit / kapan harus close
6. Risiko yang perlu diwaspadai
7. Tipe strategi: spot | curve | bid_ask | single_side_x | single_side_y

Kalau artikel tidak spesifik menyebut parameter angka, estimasikan berdasarkan konteks.

Respond HANYA dalam JSON array:
[
  {
    "name": "nama strategi",
    "type": "spot|curve|bid_ask|single_side_x|single_side_y",
    "description": "deskripsi singkat",
    "sourceQuote": "kutipan kunci dari artikel yang mendukung strategi ini",
    "marketConditions": {
      "trend": ["UPTREND"|"DOWNTREND"|"SIDEWAYS"],
      "volatility": ["HIGH"|"MEDIUM"|"LOW"],
      "sentiment": ["BULLISH"|"BEARISH"|"NEUTRAL"],
      "volumeVsAvg": { "min": 0.5, "max": 3.0 }
    },
    "parameters": {
      "priceRangePercent": 5,
      "binStep": 10,
      "strategyType": 0,
      "tokenXWeight": 50,
      "tokenYWeight": 50
    },
    "entryConditions": "kondisi ideal untuk masuk",
    "exitConditions": "kondisi untuk keluar",
    "risks": ["risiko 1", "risiko 2"],
    "confidence": 0.6
  }
]

Kalau artikel tidak mengandung strategi DLMM yang konkret, return array kosong: []`;

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 3000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Extract semua strategi DLMM dari artikel berikut:\n\n${articleText}`,
    }],
  });

  
  const strategies = safeParseAI(response.content[0].text);

  if (!Array.isArray(strategies) || strategies.length === 0) {
    return { extracted: [], message: 'Tidak ada strategi DLMM konkret yang ditemukan di artikel ini.' };
  }

  // Save all extracted strategies to library
  const saved = strategies.map(s => addResearchedStrategy(s));

  return {
    extracted: saved,
    message: `✅ ${saved.length} strategi berhasil di-extract dan disimpan ke Strategy Library.`,
  };
}

export async function summarizeArticle(articleText) {
  const cfg = getConfig();

  const response = await createMessage({
    model: resolveModel(cfg.generalModel),
    maxTokens: 500,
    messages: [{
      role: 'user',
      content: `Ringkas artikel ini dalam 3-4 kalimat Bahasa Indonesia, fokus pada poin-poin utama tentang strategi LP atau DLMM:\n\n${articleText.slice(0, 3000)}`,
    }],
  });

  return response.content[0].text.trim();
}
