import { fetchWithTimeout } from '../utils/fetch.js';

export async function getOHLCV(token) {
  const res = await fetchWithTimeout(
    `https://public-api.birdeye.so/defi/ohlcv?address=${token}&type=15m&limit=50`,
    { headers: { 'x-chain': 'solana' } }
  );

  if (!res || !res.ok) return null;

  const json = await res.json();
  const items = json.data?.items || [];

  if (items.length < 10) return null;

  const closes = items.map(i => i.c);
  const last = closes.at(-1);
  const prev = closes.at(-2);

  return {
    price: last,
    changePct: ((last - prev) / prev) * 100,
    trend: detectTrend(closes),
  };
}

function detectTrend(c) {
  const r = c.slice(-5);
  const o = c.slice(-10, -5);

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  if (avg(r) > avg(o) * 1.02) return 'UP';
  if (avg(r) < avg(o) * 0.98) return 'DOWN';
  return 'SIDEWAYS';
}
