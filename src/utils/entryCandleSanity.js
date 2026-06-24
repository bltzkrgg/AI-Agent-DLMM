'use strict';

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function candleTimestampMs(candle = {}) {
  const raw = toFiniteNumber(
    candle.time ?? candle.t ?? candle.timestamp ?? candle.ts ?? candle.unixTime,
    null
  );
  if (raw === null || raw <= 0) return null;
  return raw > 1e12 ? raw : raw * 1000;
}

function normalizeCandle(candle = {}) {
  if (Array.isArray(candle)) {
    return normalizeCandle({
      time: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
    });
  }

  const open = toFiniteNumber(candle.open ?? candle.o, null);
  const high = toFiniteNumber(candle.high ?? candle.h, null);
  const low = toFiniteNumber(candle.low ?? candle.l, null);
  const close = toFiniteNumber(candle.close ?? candle.c, null);
  const volume = toFiniteNumber(candle.volume ?? candle.v, null);
  const timeMs = candleTimestampMs(candle);
  if (open === null || close === null || volume === null || timeMs === null) return null;
  return {
    ...candle,
    open,
    high: high ?? Math.max(open, close),
    low: low ?? Math.min(open, close),
    close,
    volume,
    timeMs,
  };
}

function getOhlcv(input = null) {
  if (!input) return null;
  return input.ohlcv || input;
}

function getEntryCandles5m(ohlcv = {}) {
  if (Array.isArray(ohlcv?.entryCandles5m)) return ohlcv.entryCandles5m;
  if (Array.isArray(ohlcv?.candles5m)) return ohlcv.candles5m;
  if (Array.isArray(ohlcv?.entryCandleSanity?.candles5m)) return ohlcv.entryCandleSanity.candles5m;
  if (ohlcv?.entryCandle5m) return [ohlcv.entryCandle5m];
  if (ohlcv?.entryCandleSanity?.lastClosedCandle) return [ohlcv.entryCandleSanity.lastClosedCandle];
  return [];
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const CLOSED_5M_BUFFER_MS = 15 * 1000;

function filterClosed5mCandles(candles = [], now = Date.now()) {
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return candles;
  return candles.filter((candle) => Number(candle?.timeMs) + FIVE_MIN_MS <= (nowMs - CLOSED_5M_BUFFER_MS));
}

function buildEntryCandleDiagnostics({
  mode = 'strict',
  source = 'unknown',
  rawCandles = [],
  closedCandles = [],
  m15Candles = [],
  last = null,
  decision = null,
  cfg = {},
} = {}) {
  const m15 = last || null;
  return {
    mode,
    source,
    raw5mCount: Array.isArray(rawCandles) ? rawCandles.length : 0,
    closed5mCount: Array.isArray(closedCandles) ? closedCandles.length : 0,
    derivedM15Count: Array.isArray(m15Candles) ? m15Candles.length : 0,
    droppedOpenCandleCount: Math.max(0, (Array.isArray(rawCandles) ? rawCandles.length : 0) - (Array.isArray(closedCandles) ? closedCandles.length : 0)),
    lastM15Timestamp: m15?.timeMs || null,
    m15AgeSec: decision?.m15AgeSec ?? decision?.ageSec ?? null,
    entryM15MaxAgeSec: Number(cfg.entryM15MaxAgeSec ?? 1800) || 1800,
    m15Open: m15 ? Number(m15.open) : null,
    m15Close: m15 ? Number(m15.close) : null,
    m15Pct: decision?.m15Pct ?? null,
    m15Volume: decision?.m15Volume ?? (m15 ? Number(m15.volume) : null),
    m15AvgVolume: decision?.m15AvgVolume ?? null,
    m15VolumeRatio: decision?.m15VolumeRatio ?? null,
    entryM15MinVolumeRatio: Number(cfg.entryM15MinVolumeRatio ?? 0.7) || 0.7,
    m15Green: m15 ? Boolean(m15.close > m15.open) : null,
    m15ReclaimConsecutiveAboveLine: decision?.m15ReclaimConsecutiveAboveLine ?? null,
    m15ReclaimFreshWindowOk: decision?.m15ReclaimFreshWindowOk ?? null,
    m15ReclaimTimingState: decision?.m15ReclaimTimingState ?? null,
    m15ReclaimDistancePct: decision?.m15ReclaimDistancePct ?? null,
    m15Source: source,
    reason: decision?.reason || null,
    enough5m: Boolean(decision?.code ? !['M15_UNAVAILABLE', 'M15_STALE', 'M15_VOLUME_LOOKBACK_UNAVAILABLE'].includes(decision.code) : true),
    enough15m: Array.isArray(m15Candles) ? m15Candles.length >= 1 : false,
  };
}

function analyzeClosedM15ReclaimWindow(candlesM15 = [], supertrendValue = null) {
  const resolvedSupertrendValue = toFiniteNumber(supertrendValue, null);
  if (!(resolvedSupertrendValue > 0) || !Array.isArray(candlesM15) || candlesM15.length === 0) {
    return {
      consecutiveAboveLineCount: 0,
      freshWindowOk: null,
      timingState: 'UNKNOWN',
    };
  }

  let consecutiveAboveLineCount = 0;
  for (let i = candlesM15.length - 1; i >= 0; i--) {
    const candle = candlesM15[i];
    const close = toFiniteNumber(candle?.close, null);
    if (!(close > resolvedSupertrendValue)) break;
    consecutiveAboveLineCount += 1;
  }

  const last = candlesM15[candlesM15.length - 1] || null;
  const lastClose = toFiniteNumber(last?.close, null);
  const lastDistancePct = resolvedSupertrendValue > 0 && Number.isFinite(lastClose)
    ? ((lastClose - resolvedSupertrendValue) / resolvedSupertrendValue) * 100
    : null;
  let timingState = 'UNKNOWN';
  if (consecutiveAboveLineCount <= 0) {
    timingState = 'UNKNOWN';
  } else {
    timingState = consecutiveAboveLineCount >= 2 ? 'CONFIRMED' : 'TOO_EARLY';
  }

  return {
    consecutiveAboveLineCount,
    // Two or more closed M15 candles above Supertrend are enough.
    freshWindowOk: consecutiveAboveLineCount >= 2,
    timingState,
    distancePct: lastDistancePct,
  };
}

export function aggregateClosed5mCandlesToClosedM15(candles5m = []) {
  if (!Array.isArray(candles5m) || candles5m.length < 3) return [];
  const buckets = new Map();
  for (const row of candles5m) {
    const candle = normalizeCandle(row);
    if (!candle) continue;
    const timeSec = Math.floor(candle.timeMs / 1000);
    const bucketStartSec = Math.floor(timeSec / 900) * 900;
    const fiveMinSlot = Math.floor(timeSec / 300) * 300;
    if (!buckets.has(bucketStartSec)) buckets.set(bucketStartSec, new Map());
    buckets.get(bucketStartSec).set(fiveMinSlot, candle);
  }

  const aggregated = [];
  for (const [bucketStartSec, slotMap] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    if (!slotMap || slotMap.size < 3) continue;
    const group = Array.from(slotMap.values())
      .sort((a, b) => a.timeMs - b.timeMs)
      .slice(0, 3);
    if (group.length < 3) continue;
    aggregated.push({
      time: bucketStartSec,
      timeMs: bucketStartSec * 1000,
      open: group[0].open,
      high: Math.max(...group.map((c) => Number(c.high) || Number(c.close) || 0)),
      low: Math.min(...group.map((c) => Number(c.low) || Number(c.close) || 0)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + Math.max(0, Number(c.volume) || 0), 0),
      sourceCandles: group.length,
    });
  }
  return aggregated;
}

export function evaluateClosedM15SupertrendReclaim({
  snapshot = null,
  now = Date.now(),
  maxAgeSec = 1800,
  supertrendValue = null,
} = {}) {
  const ohlcv = getOhlcv(snapshot);
  const rawCandles = getEntryCandles5m(ohlcv);
  const candles = rawCandles.map(normalizeCandle).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);
  const closed5m = filterClosed5mCandles(candles, now);
  const candlesM15 = aggregateClosed5mCandlesToClosedM15(closed5m);
  const last = candlesM15[candlesM15.length - 1] || null;
  const source = ohlcv?.source || snapshot?.dataSource || 'unknown';
  const resolvedSupertrendValue = toFiniteNumber(
    supertrendValue ??
    snapshot?.ta?.supertrend?.value ??
    ohlcv?.ta?.supertrend?.value,
    null
  );

  if (!last) {
    return {
      known: false,
      aboveLine: null,
      reason: 'M15_RECLAIM_UNAVAILABLE',
      source,
      candle: null,
      candlesM15,
      ageSec: null,
      supertrendValue: resolvedSupertrendValue,
      distancePct: null,
    };
  }

  const ageSec = Math.max(0, (Number(now) - Number(last.timeMs)) / 1000);
  if (!Number.isFinite(ageSec) || ageSec > Math.max(1, Number(maxAgeSec) || 1800)) {
    return {
      known: false,
      aboveLine: null,
      reason: 'M15_RECLAIM_STALE',
      source,
      candle: last,
      candlesM15,
      ageSec,
      supertrendValue: resolvedSupertrendValue,
      distancePct: null,
    };
  }

  if (!(resolvedSupertrendValue > 0)) {
    return {
      known: false,
      aboveLine: null,
      reason: 'SUPERTRAND_LINE_UNAVAILABLE',
      source,
      candle: last,
      candlesM15,
      ageSec,
      supertrendValue: resolvedSupertrendValue,
      distancePct: null,
    };
  }

  const distancePct = ((Number(last.close) - resolvedSupertrendValue) / resolvedSupertrendValue) * 100;
  const reclaimWindow = analyzeClosedM15ReclaimWindow(candlesM15, resolvedSupertrendValue);
  return {
    known: Number.isFinite(distancePct),
    aboveLine: Number.isFinite(distancePct) ? distancePct > 0 : null,
    reason: Number.isFinite(distancePct) && distancePct > 0 ? 'M15_RECLAIM_CONFIRMED' : 'M15_RECLAIM_NOT_CONFIRMED',
    source,
    candle: last,
    candlesM15,
    ageSec,
    supertrendValue: resolvedSupertrendValue,
    distancePct: Number.isFinite(distancePct) ? distancePct : null,
    consecutiveAboveLineCount: reclaimWindow.consecutiveAboveLineCount,
    freshWindowOk: reclaimWindow.freshWindowOk,
    timingState: reclaimWindow.timingState,
  };
}

function evaluateLpSimpleM15Sanity({
  ohlcv = {},
  candles5m = [],
  cfg = {},
  now = Date.now(),
} = {}) {
  const closed5m = filterClosed5mCandles(candles5m, now);
  const candlesM15 = aggregateClosed5mCandlesToClosedM15(closed5m);
  const last = candlesM15[candlesM15.length - 1] || null;
  const maxAgeSec = Math.max(1, Number(cfg.entryM15MaxAgeSec ?? 1800) || 1800);
  const mode = String(cfg.entryDecisionMode || 'strict').trim().toLowerCase();
  const source = ohlcv?.source || 'unknown';
  const supertrendValue = toFiniteNumber(
    ohlcv?.ta?.supertrend?.value ??
    ohlcv?.supertrend?.value ??
    null,
    null
  );

  if (!last) {
    const decision = {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: M15 candle sanity unavailable/stale',
      code: 'M15_UNAVAILABLE',
      retryable: true,
      source,
      m15CandleCount: 0,
    };
    return {
      ...decision,
      diagnostics: buildEntryCandleDiagnostics({
        mode,
        source,
        rawCandles: candles5m,
        closedCandles: closed5m,
        m15Candles: candlesM15,
        last,
        decision,
        cfg,
      }),
    };
  }

  const ageSec = Math.max(0, (Number(now) - Number(last.timeMs)) / 1000);
  if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) {
    const decision = {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: M15 candle sanity unavailable/stale',
      code: 'M15_STALE',
      retryable: true,
      source,
      m15AgeSec: ageSec,
      m15MaxAgeSec: maxAgeSec,
      m15CandleCount: candlesM15.length,
    };
    return {
      ...decision,
      diagnostics: buildEntryCandleDiagnostics({
        mode,
        source,
        rawCandles: candles5m,
        closedCandles: closed5m,
        m15Candles: candlesM15,
        last,
        decision,
        cfg,
      }),
    };
  }

  if (cfg.entryM15RequireGreenCandle !== false && !(last.close > last.open)) {
    const decision = {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: last closed M15 candle not green',
      code: 'M15_RED_CANDLE',
      retryable: false,
      source,
      m15AgeSec: ageSec,
      candle: last,
      m15CandleCount: candlesM15.length,
    };
    return {
      ...decision,
      diagnostics: buildEntryCandleDiagnostics({
        mode,
        source,
        rawCandles: candles5m,
        closedCandles: closed5m,
        m15Candles: candlesM15,
        last,
        decision,
        cfg,
      }),
    };
  }

  const reclaimWindow = analyzeClosedM15ReclaimWindow(candlesM15, supertrendValue);
  if (reclaimWindow.freshWindowOk === false) {
    const decision = {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: closed M15 reclaim needs at least 2 closed candles above Supertrend',
      code: 'M15_RECLAIM_LATE',
      retryable: false,
      source,
      m15AgeSec: ageSec,
      candle: last,
      m15CandleCount: candlesM15.length,
      m15ReclaimConsecutiveAboveLine: reclaimWindow.consecutiveAboveLineCount,
      m15ReclaimFreshWindowOk: reclaimWindow.freshWindowOk,
      m15ReclaimTimingState: reclaimWindow.timingState,
      m15ReclaimDistancePct: reclaimWindow.distancePct,
    };
    return {
      ...decision,
      diagnostics: buildEntryCandleDiagnostics({
        mode,
        source,
        rawCandles: candles5m,
        closedCandles: closed5m,
        m15Candles: candlesM15,
        last,
        decision,
        cfg,
      }),
    };
  }

  let avgVolume = null;
  let volumeRatio = null;
  let minRatio = Math.max(0, Number(cfg.entryM15MinVolumeRatio ?? 0.7) || 0.7);
  if (cfg.entryM15RequireVolumeConfirm !== false) {
    const lookback = Math.max(1, Math.floor(Number(cfg.entryM15VolumeLookbackCandles ?? 8) || 8));
    const previous = candlesM15.slice(0, -1).slice(-lookback);
    if (previous.length < lookback) {
      const decision = {
        ok: false,
        action: 'HOLD',
        reason: 'HOLD: M15 volume lookback unavailable',
        code: 'M15_VOLUME_LOOKBACK_UNAVAILABLE',
        retryable: true,
        source,
        m15AgeSec: ageSec,
        m15CandleCount: candlesM15.length,
      };
      return {
        ...decision,
        diagnostics: buildEntryCandleDiagnostics({
          mode,
          source,
          rawCandles: candles5m,
          closedCandles: closed5m,
          m15Candles: candlesM15,
          last,
          decision,
          cfg,
        }),
      };
    }
    avgVolume = previous.reduce((sum, c) => sum + Math.max(0, Number(c.volume) || 0), 0) / previous.length;
    volumeRatio = avgVolume > 0 ? (Number(last.volume) / avgVolume) : null;
    const threshold = avgVolume * minRatio;
    if (!(avgVolume > 0) || last.volume < threshold) {
      const decision = {
        ok: false,
        action: 'HOLD',
        reason: 'HOLD: M15 candle volume below threshold',
        code: 'M15_THIN_VOLUME',
        retryable: false,
        source,
        m15AgeSec: ageSec,
        m15Volume: last.volume,
        m15AvgVolume: avgVolume,
        m15VolumeRatio: volumeRatio,
        m15MinVolumeRatio: minRatio,
        m15CandleCount: candlesM15.length,
      };
      return {
        ...decision,
        diagnostics: buildEntryCandleDiagnostics({
          mode,
          source,
          rawCandles: candles5m,
          closedCandles: closed5m,
          m15Candles: candlesM15,
          last,
          decision,
          cfg,
        }),
      };
    }
  }

  const decision = {
    ok: true,
    action: 'ALLOW',
    reason: 'entry M15 sanity pass',
    source,
    m15AgeSec: ageSec,
    m15Volume: Number(last.volume),
    m15AvgVolume: avgVolume,
    m15VolumeRatio: volumeRatio,
    m15MinVolumeRatio: minRatio,
    m15CandleCount: candlesM15.length,
    m15Pct: last.open > 0 ? Number((((last.close - last.open) / last.open) * 100).toFixed(4)) : null,
    m15ReclaimConsecutiveAboveLine: reclaimWindow.consecutiveAboveLineCount,
    m15ReclaimFreshWindowOk: reclaimWindow.freshWindowOk,
    m15ReclaimTimingState: reclaimWindow.timingState,
    m15ReclaimDistancePct: reclaimWindow.distancePct,
    candle: last,
    candlesM15,
  };
  return {
    ...decision,
    diagnostics: buildEntryCandleDiagnostics({
      mode,
      source,
      rawCandles: candles5m,
      closedCandles: closed5m,
      m15Candles: candlesM15,
      last,
      decision,
      cfg,
    }),
  };
}

export function evaluateEntryCandleSanity({
  snapshot = null,
  cfg = {},
  now = Date.now(),
} = {}) {
  if (cfg.entryCandleSanityEnabled === false) {
    return { ok: true, action: 'ALLOW', reason: 'entry candle sanity disabled', source: 'disabled' };
  }

  const ohlcv = getOhlcv(snapshot);
  const rawCandles = getEntryCandles5m(ohlcv);
  const candles = rawCandles.map(normalizeCandle).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);
  const mode = String(cfg.entryDecisionMode || 'strict').trim().toLowerCase();
  if (mode === 'lp_simple_m15') {
    return evaluateLpSimpleM15Sanity({
      ohlcv,
      candles5m: candles,
      cfg,
      now,
    });
  }

  const last = candles[candles.length - 1] || null;
  const maxAgeSec = Math.max(1, Number(cfg.entryCandleMaxAgeSec ?? 420) || 420);

  if (!last) {
    return {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: entry candle sanity unavailable/stale',
      code: 'UNAVAILABLE',
      retryable: true,
      source: ohlcv?.source || 'unknown',
    };
  }

  const ageSec = Math.max(0, (Number(now) - last.timeMs) / 1000);
  if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) {
    return {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: entry candle sanity unavailable/stale',
      code: 'STALE',
      retryable: true,
      source: ohlcv?.source || 'unknown',
      ageSec,
      maxAgeSec,
    };
  }

  if (cfg.entryRequireGreenCandle !== false && !(last.close > last.open)) {
    return {
      ok: false,
      action: 'HOLD',
      reason: 'HOLD: last closed 5m candle not green',
      code: 'RED_CANDLE',
      retryable: false,
      source: ohlcv?.source || 'unknown',
      ageSec,
      candle: last,
    };
  }

  if (cfg.entryRequireVolumeConfirm !== false) {
    const lookback = Math.max(1, Math.floor(Number(cfg.entryVolumeLookbackCandles ?? 12) || 12));
    const previous = candles.slice(0, -1).slice(-lookback);
    if (previous.length < lookback) {
      return {
        ok: false,
        action: 'HOLD',
        reason: 'HOLD: entry candle sanity unavailable/stale',
        code: 'VOLUME_LOOKBACK_UNAVAILABLE',
        retryable: true,
        source: ohlcv?.source || 'unknown',
        ageSec,
      };
    }
    const avgVolume = previous.reduce((sum, c) => sum + Math.max(0, Number(c.volume) || 0), 0) / previous.length;
    const minRatio = Math.max(0, Number(cfg.entryMinVolumeRatio ?? 1.5) || 1.5);
    const threshold = avgVolume * minRatio;
    if (!(avgVolume > 0) || last.volume < threshold) {
      return {
        ok: false,
        action: 'HOLD',
        reason: 'HOLD: entry candle volume below threshold',
        code: 'THIN_VOLUME',
        retryable: false,
        source: ohlcv?.source || 'unknown',
        ageSec,
        volume: last.volume,
        avgVolume,
        minRatio,
        threshold,
      };
    }
  }

  return {
    ok: true,
    action: 'ALLOW',
    reason: 'entry candle sanity pass',
    source: ohlcv?.source || 'cache',
    ageSec,
    candle: last,
  };
}
