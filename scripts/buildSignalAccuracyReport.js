#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { calculateSupertrend } = await import('../src/utils/ta.js');

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
};

const outPath = resolve(getArg('--out', join(__dirname, '../data/signal-accuracy-report.json')));
const inputDir = getArg('--input-dir', null);
const inputsRaw = getArg('--inputs', null);
const minMatch = Number(getArg('--min-match', '0.20'));
const maxBearishFpr = Number(getArg('--max-bearish-fpr', '0.95'));
const maxBullishFnr = Number(getArg('--max-bullish-fnr', '1.00'));
const strict = getArg('--strict', 'true') !== 'false';

function classifyProxy(meta = {}) {
  const p5m = Number(meta.priceChangeM5 ?? 0);
  const p1h = Number(meta.priceChangeH1 ?? 0);
  const bp = Number(meta.buyPressurePct ?? 50);
  const isBullish = (p1h > 1.0 && bp > 55) || (p5m > 3 && p1h > -1);
  const isBearish = (p1h < -5 || bp < 35);
  if (isBullish) return 'BULLISH';
  if (isBearish) return 'BEARISH';
  return 'NEUTRAL';
}

function mapRawCandle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tsRaw = Number(raw.time ?? raw.t ?? raw.unixTime ?? raw.timestamp ?? NaN);
  const time = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw;
  const open = Number(raw.open ?? raw.o ?? NaN);
  const high = Number(raw.high ?? raw.h ?? NaN);
  const low = Number(raw.low ?? raw.l ?? NaN);
  const close = Number(raw.close ?? raw.c ?? NaN);
  const volume = Number(raw.volume ?? raw.v ?? 0);
  if (![time, open, high, low, close].every(Number.isFinite) || close <= 0) return null;

  const p5m = Number(raw.priceChangeM5 ?? raw.p5m ?? raw._meta?.priceChangeM5 ?? ((close - open) / open) * 100);
  const p1h = Number(raw.priceChangeH1 ?? raw.p1h ?? raw._meta?.priceChangeH1 ?? p5m);
  const bp = Number(raw.buyPressurePct ?? raw.bp ?? raw._meta?.buyPressurePct ?? 50);

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    _meta: {
      priceChangeM5: Number.isFinite(p5m) ? p5m : 0,
      priceChangeH1: Number.isFinite(p1h) ? p1h : 0,
      buyPressurePct: Number.isFinite(bp) ? bp : 50,
    },
  };
}

function loadCandles(filePath) {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.candles)
      ? parsed.candles
      : Array.isArray(parsed?.data?.items)
        ? parsed.data.items
        : Array.isArray(parsed?.data?.candles)
          ? parsed.data.candles
          : [];
  return arr.map(mapRawCandle).filter(Boolean).sort((a, b) => a.time - b.time);
}

function computeMetrics(candles) {
  const WINDOW = 11;
  const rows = [];
  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(i - WINDOW, i);
    const st = calculateSupertrend(window, 10, 3);
    const proxy = classifyProxy(candles[i]._meta);
    rows.push({ st: st.trend, proxy, match: st.trend === proxy });
  }

  const total = rows.length;
  const matches = rows.filter((r) => r.match).length;
  const matchRate = total > 0 ? matches / total : 0;
  const perClass = {};
  for (const cls of ['BULLISH', 'BEARISH', 'NEUTRAL']) {
    const gt = rows.filter((r) => r.st === cls);
    const pred = rows.filter((r) => r.proxy === cls);
    const tp = rows.filter((r) => r.st === cls && r.proxy === cls).length;
    const fpRate = pred.length > 0 ? (pred.length - tp) / pred.length : 0;
    const fnRate = gt.length > 0 ? (gt.length - tp) / gt.length : 0;
    perClass[cls] = {
      gtCount: gt.length,
      predCount: pred.length,
      truePositives: tp,
      falsePositiveRate: Number(fpRate.toFixed(4)),
      falseNegativeRate: Number(fnRate.toFixed(4)),
    };
  }
  return {
    total,
    matchRate: Number(matchRate.toFixed(4)),
    bearishFalsePositiveRate: perClass.BEARISH.falsePositiveRate,
    bullishFalseNegativeRate: perClass.BULLISH.falseNegativeRate,
    perClass,
  };
}

function collectInputFiles() {
  const files = new Set();
  if (inputsRaw) {
    for (const item of inputsRaw.split(',')) {
      const p = item.trim();
      if (p) files.add(resolve(p));
    }
  }
  if (inputDir) {
    const dir = resolve(inputDir);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (extname(name).toLowerCase() === '.json') files.add(join(dir, name));
      }
    }
  }
  return [...files];
}

const inputFiles = collectInputFiles();
const datasets = [];
for (const file of inputFiles) {
  try {
    const candles = loadCandles(file);
    if (candles.length < 20) continue;
    const metrics = computeMetrics(candles);
    if (metrics.total <= 0) continue;
    datasets.push({
      file,
      candles: candles.length,
      evaluated: metrics.total,
      metrics,
    });
  } catch {
    // ignore bad dataset file
  }
}

const totalEvaluated = datasets.reduce((s, d) => s + d.evaluated, 0);
const weighted = (pick) => totalEvaluated > 0
  ? datasets.reduce((s, d) => s + d.metrics[pick] * d.evaluated, 0) / totalEvaluated
  : 0;

const aggregate = {
  datasetCount: datasets.length,
  totalEvaluated,
  matchRate: Number(weighted('matchRate').toFixed(4)),
  bearishFalsePositiveRate: Number(weighted('bearishFalsePositiveRate').toFixed(4)),
  bullishFalseNegativeRate: Number(weighted('bullishFalseNegativeRate').toFixed(4)),
};

const passed = (
  aggregate.datasetCount > 0 &&
  aggregate.totalEvaluated > 0 &&
  aggregate.matchRate >= minMatch &&
  aggregate.bearishFalsePositiveRate <= maxBearishFpr &&
  aggregate.bullishFalseNegativeRate <= maxBullishFnr
);

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: { minMatch, maxBearishFpr, maxBullishFnr },
  aggregate,
  passed,
  datasets,
  notes: datasets.length === 0
    ? ['No valid OHLCV dataset found.']
    : [],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`[signal-report] wrote ${outPath}`);
console.log(`[signal-report] datasets=${aggregate.datasetCount}, evaluated=${aggregate.totalEvaluated}`);
console.log(`[signal-report] match=${(aggregate.matchRate * 100).toFixed(1)}% | bearishFPR=${(aggregate.bearishFalsePositiveRate * 100).toFixed(1)}% | bullishFNR=${(aggregate.bullishFalseNegativeRate * 100).toFixed(1)}%`);
console.log(`[signal-report] verdict=${passed ? 'PASS' : 'FAIL'}`);

if (strict && !passed) process.exit(2);
