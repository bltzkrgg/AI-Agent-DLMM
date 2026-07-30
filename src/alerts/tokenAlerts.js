import bs58 from 'bs58';
import { escapeHTML } from '../utils/safeJson.js';

const TOKEN_ALERTS_STATE_KEY = 'tokenAlertsSeen';
const TOKEN_ALERTS_STATE_TTL_MS = 48 * 60 * 60 * 1000;

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeTimestampMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : null;
  }
  const numeric = finiteNumber(value);
  if (numeric == null || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function isValidSolanaMint(mint) {
  if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return false;
  try {
    return bs58.decode(mint).length === 32;
  } catch {
    return false;
  }
}

function normalizePercentage(value) {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed < 0) return null;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function getCandidateMint(candidate = {}) {
  return String(
    candidate.address ||
    candidate.mint ||
    candidate.token_address ||
    candidate.tokenAddress ||
    ''
  ).trim();
}

function getCandidateVolume(candidate = {}) {
  return firstFinite(
    candidate.volume,
    candidate.volume_5m,
    candidate.volume5m,
    candidate.volume_5m_usd
  );
}

function getCandidateMarketCap(candidate = {}) {
  return firstFinite(
    candidate.market_cap,
    candidate.marketcap,
    candidate.marketCap,
    candidate.market_cap_usd
  );
}

export function getTokenReferenceTimestamp(candidate = {}) {
  return normalizeTimestampMs(candidate.migrated_timestamp) ??
    normalizeTimestampMs(candidate.open_timestamp) ??
    normalizeTimestampMs(candidate.creation_timestamp);
}

function normalizeRankCandidate(candidate = {}, nowMs = Date.now()) {
  const mint = getCandidateMint(candidate);
  const referenceTimestamp = getTokenReferenceTimestamp(candidate);
  const volume5mUsd = getCandidateVolume(candidate);
  const marketCapUsd = getCandidateMarketCap(candidate);
  const buys5m = firstFinite(candidate.buys, candidate.buy_count, candidate.buys_5m);
  const sells5m = firstFinite(candidate.sells, candidate.sell_count, candidate.sells_5m);
  const swaps5m = firstFinite(candidate.swaps, candidate.swap_count, candidate.swaps_5m);
  const exchange = String(
    candidate.exchange || candidate.dex || candidate.pool_type || candidate.platform || ''
  ).trim();

  return {
    mint,
    name: String(candidate.name || candidate.token_name || 'Unknown').trim() || 'Unknown',
    symbol: String(candidate.symbol || candidate.token_symbol || 'UNKNOWN').trim() || 'UNKNOWN',
    priceUsd: firstFinite(candidate.price, candidate.price_usd, candidate.current_price),
    marketCapUsd,
    volume5mUsd,
    totalFeesSol: finiteNumber(candidate.totalFeesSol),
    liquidityUsd: firstFinite(candidate.liquidity, candidate.liquidity_usd),
    swaps5m: swaps5m ?? (
      buys5m != null && sells5m != null ? buys5m + sells5m : null
    ),
    buys5m,
    sells5m,
    ageMin: referenceTimestamp == null ? null : (nowMs - referenceTimestamp) / 60_000,
    referenceTimestamp,
    exchange,
    top10Pct: normalizePercentage(
      candidate.top_10_holder_rate ??
      candidate.top10_holder_rate ??
      candidate.top10Pct
    ),
    dexPaid: [
      candidate.dexscr_ad,
      candidate.dexscr_update_link,
      candidate.dexscr_boost_fee,
      candidate.dexscr_trending_bar,
    ].some((value) => (finiteNumber(value) ?? 0) > 0),
  };
}

function evaluateRankCandidate(candidate, config, nowMs) {
  const normalized = normalizeRankCandidate(candidate, nowMs);
  const minVolume = Number(config?.tokenAlertsMinVolume5mUsd ?? 100000);
  const minMarketCap = Number(config?.tokenAlertsMinMarketCapUsd ?? 100000);
  const maxAgeMin = Number(config?.tokenAlertsMaxAgeMin ?? 30);

  if (!isValidSolanaMint(normalized.mint)) {
    return { eligible: false, reason: 'INVALID_MINT', normalized };
  }
  if (normalized.volume5mUsd == null || normalized.volume5mUsd < minVolume) {
    return { eligible: false, reason: 'VOLUME_BELOW_MIN', normalized };
  }
  if (normalized.marketCapUsd == null || normalized.marketCapUsd <= minMarketCap) {
    return { eligible: false, reason: 'MCAP_NOT_ABOVE_MIN', normalized };
  }
  if (
    normalized.referenceTimestamp == null ||
    normalized.ageMin == null ||
    normalized.ageMin < 0
  ) {
    return { eligible: false, reason: 'AGE_UNKNOWN', normalized };
  }
  if (normalized.ageMin > maxAgeMin) {
    return { eligible: false, reason: 'TOKEN_TOO_OLD', normalized };
  }
  return { eligible: true, reason: 'PASS', normalized };
}

export function evaluateTokenAlertCandidate(candidate, config = {}, nowMs = Date.now()) {
  const rankResult = evaluateRankCandidate(candidate, config, nowMs);
  if (!rankResult.eligible) return rankResult;

  const minTotalFees = Number(config?.tokenAlertsMinTotalFeesSol ?? 10);
  const totalFeesSol = finiteNumber(candidate?.totalFeesSol);
  rankResult.normalized.totalFeesSol = totalFeesSol;
  if (totalFeesSol == null || totalFeesSol < 0) {
    return { ...rankResult, eligible: false, reason: 'TOTAL_FEES_UNKNOWN' };
  }
  if (totalFeesSol < minTotalFees) {
    return { ...rankResult, eligible: false, reason: 'TOTAL_FEES_BELOW_MIN' };
  }
  if (candidate?.alertedAt) {
    return { ...rankResult, eligible: false, reason: 'ALREADY_ALERTED' };
  }
  return rankResult;
}

export function extractGmgnTotalFeesSol(tokenInfo = {}) {
  const values = [
    tokenInfo?.total_fee,
    tokenInfo?.total_fees_sol,
    tokenInfo?.stat?.total_fees_sol,
    tokenInfo?.fees?.total_sol,
    tokenInfo?.fee?.total_sol,
  ];
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed != null && parsed >= 0) return parsed;
  }
  return null;
}

export function extractTopHolderPercentages(holderRows, limit = 5) {
  if (!Array.isArray(holderRows)) return [];
  return holderRows
    .filter((row) => Number(row?.addr_type) === 0)
    .filter((row) => !String(row?.exchange || '').trim())
    .map((row) => normalizePercentage(row?.amount_percentage))
    .filter((value) => value != null && value > 0)
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, Number(limit) || 5));
}

function formatUsdShort(value) {
  if (!Number.isFinite(value)) return 'N/A';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `$${value.toFixed(2)}`;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return 'N/A';
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function formatDex(exchange) {
  const raw = String(exchange || '').trim();
  const normalized = raw.toLowerCase();
  if (normalized === 'pump_amm') return 'PumpSwap';
  if (normalized === 'meteora_dlmm') return 'Meteora DLMM';
  if (normalized === 'raydium' || normalized === 'raydium_amm') return 'Raydium';
  if (normalized === 'orca') return 'Orca';
  return raw || 'Unknown';
}

function top10Indicator(value) {
  if (!Number.isFinite(value)) return '⚪ N/A';
  if (value <= 20) return `🟢 ${value.toFixed(1).replace(/\.0$/, '')}%`;
  if (value <= 30) return `🟡 ${value.toFixed(1).replace(/\.0$/, '')}%`;
  return `🔴 ${value.toFixed(1).replace(/\.0$/, '')}%`;
}

function formatFlow(buys, sells) {
  if (!Number.isFinite(buys) || !Number.isFinite(sells) || (buys + sells) <= 0) return 'N/A';
  const buyPct = Math.round((buys / (buys + sells)) * 100);
  return `Buy ${buyPct}% | Sell ${100 - buyPct}%`;
}

export function formatTokenAlertMessage(alert = {}) {
  const mint = getCandidateMint(alert);
  if (!isValidSolanaMint(mint)) {
    throw new Error('INVALID_MINT');
  }
  const holders = Array.isArray(alert.topHolderPercentages)
    ? alert.topHolderPercentages.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    : [];
  const holderText = holders.length > 0
    ? holders.map((value) => Number(value).toFixed(1).replace(/\.0$/, '')).join(' | ')
    : 'N/A';
  const ageMin = Number.isFinite(alert.ageMin) ? Math.floor(alert.ageMin) : null;
  const swaps = Number.isFinite(alert.swaps5m) ? Math.round(alert.swaps5m) : 'N/A';

  return [
    `💊 <code>${mint}</code>`,
    '',
    `┌ <b>${escapeHTML(alert.name || 'Unknown')} (${escapeHTML(alert.symbol || 'UNKNOWN')})</b>`,
    `├ USD:       <b>${formatPrice(alert.priceUsd)}</b>`,
    `├ MC:        <b>${formatUsdShort(alert.marketCapUsd)}</b> 🟢`,
    `├ Vol 5m:    <b>${formatUsdShort(alert.volume5mUsd)}</b> 🟢`,
    `├ Fees:      <b>${Number(alert.totalFeesSol).toFixed(2)} SOL</b> 🟢`,
    `├ Age:       <b>${ageMin == null ? 'N/A' : `${ageMin}m`}</b>`,
    `├ Seen:      <b>just now</b>`,
    `├ Dex:       <b>${escapeHTML(formatDex(alert.exchange))}</b>`,
    `├ Dex Paid:  <b>${alert.dexPaid ? '🟢' : '🔴'}</b>`,
    `├ Holder:    Top 10: <b>${top10Indicator(alert.top10Pct)}</b>`,
    `├ Flow:      <b>${escapeHTML(formatFlow(alert.buys5m, alert.sells5m))}</b>`,
    `└ TH:        <b>${escapeHTML(holderText)}</b>`,
    '',
    `Swaps 5m: <b>${swaps}</b> | Liquidity: <b>${formatUsdShort(alert.liquidityUsd)}</b>`,
    '',
    `🌐 <a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
  ].join('\n');
}

function pruneSeenRecords(records, nowMs) {
  const next = {};
  for (const [mint, record] of Object.entries(records || {})) {
    const timestamp = Number(record?.alertedAt || record?.firstSeenAt || 0);
    if (timestamp > 0 && (nowMs - timestamp) <= TOKEN_ALERTS_STATE_TTL_MS) {
      next[mint] = record;
    }
  }
  return next;
}

function recordScanError(summary, error, { partial = false } = {}) {
  const errorCode = String(error?.code || 'TOKEN_ALERT_PROCESSING_FAILED');
  const isGmgnError = errorCode.startsWith('GMGN_');
  summary.status = partial
    ? isGmgnError ? 'GMGN_PARTIAL_FAILURE' : 'TOKEN_ALERT_PARTIAL_FAILURE'
    : isGmgnError ? 'GMGN_FAILED' : 'TOKEN_ALERT_FAILED';
  summary.errorCode ||= errorCode;
  summary.error ||= String(error?.message || 'Token Alerts scan failed');
}

function recordRejection(summary, reason, count = 1) {
  const key = String(reason || 'UNKNOWN_REJECTION');
  summary.rejected[key] = (summary.rejected[key] || 0) + count;
}

export function createTokenAlertService({
  fetchTrending,
  fetchTokenInfo,
  fetchHolders,
  sendAlert,
  getConfig,
  getState,
  setState,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null;
  let scanInFlight = false;
  let lastScanAt = null;

  async function scanOnce({ source = 'manual' } = {}) {
    if (scanInFlight) {
      return {
        source,
        blocked: true,
        reason: 'SCAN_IN_FLIGHT',
        status: 'SCAN_IN_FLIGHT',
        fetched: 0,
        eligible: 0,
        alerted: 0,
        skipped: 0,
        failed: 0,
        rejected: {},
      };
    }

    scanInFlight = true;
    const startedAt = now();
    const summary = {
      source,
      blocked: false,
      fetched: 0,
      eligible: 0,
      alerted: 0,
      skipped: 0,
      failed: 0,
      status: 'GMGN_OK',
      rejected: {},
    };

    try {
      const config = getConfig();
      const seen = pruneSeenRecords(getState(TOKEN_ALERTS_STATE_KEY) || {}, startedAt);
      setState(TOKEN_ALERTS_STATE_KEY, seen);

      const rows = await fetchTrending({
        interval: '5m',
        limit: 100,
      });
      const candidates = Array.isArray(rows) ? rows : [];
      summary.fetched = candidates.length;
      summary.status = candidates.length > 0 ? 'GMGN_OK' : 'GMGN_OK_NO_RESULTS';

      const preliminaryCandidates = candidates
        .map((candidate) => ({ candidate, result: evaluateRankCandidate(candidate, config, startedAt) }))
        .filter(({ result }) => {
          if (!result.eligible) {
            summary.skipped += 1;
            recordRejection(summary, result.reason);
            return false;
          }
          if (seen[result.normalized.mint]?.alertedAt) {
            summary.skipped += 1;
            recordRejection(summary, 'ALREADY_ALERTED');
            return false;
          }
          return true;
        })
        .sort((a, b) => b.result.normalized.volume5mUsd - a.result.normalized.volume5mUsd);
      const maxPerScan = Math.max(1, Number(config.tokenAlertsMaxPerScan) || 5);
      const preliminary = preliminaryCandidates.slice(0, maxPerScan);
      const scanLimitSkipped = Math.max(0, preliminaryCandidates.length - preliminary.length);
      summary.skipped += scanLimitSkipped;
      if (scanLimitSkipped > 0) recordRejection(summary, 'SCAN_LIMIT', scanLimitSkipped);

      for (const { candidate, result: rankResult } of preliminary) {
        const mint = rankResult.normalized.mint;
        try {
          const tokenInfo = await fetchTokenInfo(mint, { strict: true });
          const totalFeesSol = extractGmgnTotalFeesSol(tokenInfo);
          const fullResult = evaluateTokenAlertCandidate(
            { ...candidate, totalFeesSol, alertedAt: seen[mint]?.alertedAt || null },
            config,
            startedAt
          );
          if (!fullResult.eligible) {
            summary.skipped += 1;
            recordRejection(summary, fullResult.reason);
            continue;
          }

          summary.eligible += 1;
          const currentRecord = seen[mint] || {};
          seen[mint] = {
            ...currentRecord,
            firstSeenAt: currentRecord.firstSeenAt || startedAt,
            referenceTimestamp: Math.floor(fullResult.normalized.referenceTimestamp / 1000),
            volume5mUsd: fullResult.normalized.volume5mUsd,
            marketCapUsd: fullResult.normalized.marketCapUsd,
            totalFeesSol,
          };
          setState(TOKEN_ALERTS_STATE_KEY, { ...seen });

          let topHolderPercentages = [];
          try {
            const holders = await fetchHolders(mint, { limit: 20 });
            topHolderPercentages = extractTopHolderPercentages(holders, 5);
          } catch {
            topHolderPercentages = [];
          }

          const message = formatTokenAlertMessage({
            ...fullResult.normalized,
            topHolderPercentages,
          });
          const sent = await sendAlert(message, {
            mint,
            source,
            alert: fullResult.normalized,
          });
          if (sent === false) {
            const error = new Error('Telegram alert delivery failed');
            error.code = 'TELEGRAM_SEND_FAILED';
            throw error;
          }

          seen[mint] = {
            ...seen[mint],
            alertedAt: now(),
          };
          setState(TOKEN_ALERTS_STATE_KEY, { ...seen });
          summary.alerted += 1;
        } catch (error) {
          summary.failed += 1;
          recordScanError(summary, error, { partial: true });
          console.warn(`[token-alerts] candidate failed mint=${mint}: ${error.message}`);
        }
      }
      if (
        summary.fetched > 0 &&
        summary.eligible === 0 &&
        summary.failed === 0
      ) {
        summary.status = 'GMGN_OK_FILTERED_OUT';
      }
    } catch (error) {
      summary.failed += 1;
      recordScanError(summary, error);
      console.warn(`[token-alerts] scan failed source=${source}: ${error.message}`);
    } finally {
      lastScanAt = now();
      scanInFlight = false;
      const rejected = Object.entries(summary.rejected)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',');
      console.log(
        `[token-alerts] scan source=${source} status=${summary.status} ` +
        `fetched=${summary.fetched} eligible=${summary.eligible} alerted=${summary.alerted} ` +
        `skipped=${summary.skipped} failed=${summary.failed}` +
        (rejected ? ` rejected=${rejected}` : '')
      );
    }
    return summary;
  }

  function start() {
    if (timer) return false;
    const intervalSec = Math.max(15, Number(getConfig().tokenAlertsPollIntervalSec) || 60);
    timer = setIntervalFn(() => {
      scanOnce({ source: 'timer' }).catch((error) => {
        console.warn(`[token-alerts] timer scan failed: ${error.message}`);
      });
    }, intervalSec * 1000);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  function status() {
    return {
      running: Boolean(timer),
      scanInFlight,
      lastScanAt,
      stateKey: TOKEN_ALERTS_STATE_KEY,
    };
  }

  return { start, stop, scanOnce, status };
}
