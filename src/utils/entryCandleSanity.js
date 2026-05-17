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
  const close = toFiniteNumber(candle.close ?? candle.c, null);
  const volume = toFiniteNumber(candle.volume ?? candle.v, null);
  const timeMs = candleTimestampMs(candle);
  if (open === null || close === null || volume === null || timeMs === null) return null;
  return { ...candle, open, close, volume, timeMs };
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
