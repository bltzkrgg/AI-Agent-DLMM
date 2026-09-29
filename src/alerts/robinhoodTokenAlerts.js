import { escapeHTML } from '../utils/safeJson.js';
import { extractTopHolderPercentages } from './tokenAlerts.js';

const STATE_KEY = 'robinhoodTokenAlertsSeen';
const STATE_TTL_MS = 48 * 60 * 60 * 1000;

function finiteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizePercentage(value) {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed < 0) return null;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function normalizeTimestampMs(value) {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

export function isValidRobinhoodAddress(address) {
  return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

function candidateAddress(candidate = {}) {
  return String(candidate.address || candidate.token_address || candidate.tokenAddress || '').trim();
}

export function extractGmgnTotalFeesEth(...sources) {
  for (const source of sources) {
    const value = firstFinite(
      source?.total_fee,
      source?.total_fees_eth,
      source?.stat?.total_fee,
      source?.stat?.total_fees_eth,
      source?.fees?.total_eth,
      source?.fee?.total_eth
    );
    if (value != null && value >= 0) return value;
  }
  return null;
}

function normalizeCandidate(candidate = {}, tokenInfo = {}, nowMs = Date.now()) {
  const address = candidateAddress(candidate);
  const buys5m = firstFinite(candidate.buys, candidate.buy_count, candidate.buys_5m);
  const sells5m = firstFinite(candidate.sells, candidate.sell_count, candidate.sells_5m);
  const referenceTimestamp = normalizeTimestampMs(
    candidate.open_timestamp ?? candidate.creation_timestamp ?? tokenInfo.open_timestamp
  );
  const paidFields = [
    candidate.dexscr_ad,
    candidate.dexscr_update_link,
    candidate.dexscr_boost_fee,
    candidate.dexscr_trending_bar,
    tokenInfo?.dev?.dexscr_boost_fee,
    tokenInfo?.dev?.dexscr_trending_bar,
  ];

  return {
    address,
    addressKey: address.toLowerCase(),
    name: String(candidate.name || candidate.token_name || tokenInfo.name || 'Unknown').trim() || 'Unknown',
    symbol: String(candidate.symbol || candidate.token_symbol || tokenInfo.symbol || 'UNKNOWN').trim() || 'UNKNOWN',
    exchange: String(candidate.exchange || candidate.dex || candidate.launchpad_platform || '').trim(),
    priceUsd: firstFinite(candidate.price, candidate.price_usd),
    marketCapUsd: firstFinite(candidate.market_cap, candidate.marketcap, candidate.market_cap_usd),
    volume5mUsd: firstFinite(candidate.volume, candidate.volume_5m, candidate.volume5m),
    totalFeesEth: extractGmgnTotalFeesEth(candidate, tokenInfo),
    liquidityUsd: firstFinite(candidate.liquidity, candidate.liquidity_usd),
    swaps5m: firstFinite(candidate.swaps, candidate.swap_count, candidate.swaps_5m) ?? (
      buys5m != null && sells5m != null ? buys5m + sells5m : null
    ),
    buys5m,
    sells5m,
    ageMin: referenceTimestamp == null ? null : Math.max(0, (nowMs - referenceTimestamp) / 60_000),
    top10Pct: normalizePercentage(
      candidate.top_10_holder_rate ?? tokenInfo?.stat?.top_10_holder_rate
    ),
    dexPaid: paidFields.some((value) => (finiteNumber(value) ?? 0) > 0),
  };
}

export function evaluateRobinhoodTokenCandidate(candidate, config = {}, tokenInfo = {}, nowMs = Date.now()) {
  const normalized = normalizeCandidate(candidate, tokenInfo, nowMs);
  const minVolume = Number(config.robinhoodAlertsMinVolume5mUsd ?? 100000);
  const minFees = Number(config.robinhoodAlertsMinTotalFeesEth ?? 0.1);

  if (!isValidRobinhoodAddress(normalized.address)) {
    return { eligible: false, reason: 'INVALID_ADDRESS', normalized };
  }
  if (normalized.volume5mUsd == null || normalized.volume5mUsd < minVolume) {
    return { eligible: false, reason: 'VOLUME_BELOW_MIN', normalized };
  }
  if (normalized.totalFeesEth == null) {
    return { eligible: false, reason: 'TOTAL_FEES_UNKNOWN', normalized };
  }
  if (normalized.totalFeesEth < minFees) {
    return { eligible: false, reason: 'TOTAL_FEES_BELOW_MIN', normalized };
  }
  return { eligible: true, reason: 'PASS', normalized };
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

function formatDex(value) {
  const raw = String(value || '').trim();
  const known = {
    uniswap_v2: 'Uniswap V2',
    uniswap_v3: 'Uniswap V3',
    pancakeswap_v3: 'PancakeSwap V3',
    dyorswap: 'DYORSwap',
  };
  return known[raw.toLowerCase()] || raw || 'Unknown';
}

function formatFlow(buys, sells) {
  if (!Number.isFinite(buys) || !Number.isFinite(sells) || buys + sells <= 0) return 'N/A';
  const buyPct = Math.round((buys / (buys + sells)) * 100);
  return `Buy ${buyPct}% • Sell ${100 - buyPct}%`;
}

function formatPercentage(value) {
  return Number.isFinite(value) ? `${value.toFixed(1).replace(/\.0$/, '')}%` : 'N/A';
}

export function formatRobinhoodTokenAlertMessage(alert = {}) {
  if (!isValidRobinhoodAddress(alert.address)) throw new Error('INVALID_ADDRESS');
  const age = Number.isFinite(alert.ageMin) ? `${Math.floor(alert.ageMin)}m` : 'N/A';
  const swaps = Number.isFinite(alert.swaps5m)
    ? Math.round(alert.swaps5m).toLocaleString('en-US')
    : 'N/A';
  const holders = Array.isArray(alert.topHolderPercentages)
    ? alert.topHolderPercentages
      .map((value) => finiteNumber(value))
      .filter((value) => value != null && value > 0)
      .map((value) => value.toFixed(1).replace(/\.0$/, ''))
      .join(' • ')
    : '';

  return [
    '🟢 <b>ROBINHOOD TOKEN RUNNER</b>',
    '',
    `<b>💊 ${escapeHTML(alert.symbol || 'UNKNOWN')} • ${age}</b>`,
    `${escapeHTML(alert.name || 'Unknown')} | ${escapeHTML(formatDex(alert.exchange))}`,
    '',
    '┌ <b>MARKET</b>',
    `├ <code>Price     :</code> <b>${formatPrice(alert.priceUsd)}</b>`,
    `├ <code>MC        :</code> <b>${formatUsdShort(alert.marketCapUsd)}</b>`,
    `├ <code>Vol 5m    :</code> <b>${formatUsdShort(alert.volume5mUsd)}</b>`,
    `├ <code>Swaps 5m  :</code> <b>${swaps}</b>`,
    `├ <code>Fees      :</code> <b>${Number(alert.totalFeesEth).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} ETH</b>`,
    `└ <code>Liquidity :</code> <b>${formatUsdShort(alert.liquidityUsd)}</b>`,
    '',
    '┌ <b>ACTIVITY</b>',
    `├ <code>Flow      :</code> <b>${escapeHTML(formatFlow(alert.buys5m, alert.sells5m))}</b>`,
    `├ <code>Top 10    :</code> <b>${formatPercentage(alert.top10Pct)}</b>`,
    `├ <code>Wallets   :</code> <b>${escapeHTML(holders || 'N/A')}</b>`,
    `└ <code>Dex Paid  :</code> <b>${alert.dexPaid ? 'Yes' : 'No'}</b>`,
    '',
    '┌ <b>STATUS</b>',
    '└ 🟢 <b>ROBINHOOD QUALIFIED</b>',
    '   <code>VOL • FEES</code>',
    '',
    '<b>CA</b>',
    `<code>${alert.address}</code>`,
  ].join('\n');
}

function pruneSeen(records, nowMs) {
  return Object.fromEntries(Object.entries(records || {}).filter(([, record]) => {
    const timestamp = Number(record?.alertedAt || 0);
    return timestamp > 0 && nowMs - timestamp <= STATE_TTL_MS;
  }));
}

function reject(summary, reason) {
  summary.skipped += 1;
  summary.rejected[reason] = (summary.rejected[reason] || 0) + 1;
}

export function createRobinhoodTokenAlertService({
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
    const summary = {
      source, blocked: false, status: 'GMGN_OK', fetched: 0, eligible: 0,
      alerted: 0, skipped: 0, failed: 0, rejected: {},
    };
    if (scanInFlight) return { ...summary, blocked: true, status: 'SCAN_IN_FLIGHT' };

    scanInFlight = true;
    const startedAt = now();
    try {
      const config = getConfig();
      const seen = pruneSeen(getState(STATE_KEY) || {}, startedAt);
      setState(STATE_KEY, seen);
      const rows = await fetchTrending({
        interval: '5m',
        limit: 100,
        minVolumeUsd: config.robinhoodAlertsMinVolume5mUsd,
        minTotalFeesEth: config.robinhoodAlertsMinTotalFeesEth,
      });
      const candidates = Array.isArray(rows) ? rows : [];
      summary.fetched = candidates.length;
      summary.status = candidates.length ? 'GMGN_OK' : 'GMGN_OK_NO_RESULTS';

      for (const candidate of candidates) {
        if (summary.alerted >= Math.max(1, Number(config.robinhoodAlertsMaxPerScan) || 5)) {
          reject(summary, 'SCAN_LIMIT');
          continue;
        }
        const address = candidateAddress(candidate);
        const addressKey = address.toLowerCase();
        if (!isValidRobinhoodAddress(address)) {
          reject(summary, 'INVALID_ADDRESS');
          continue;
        }
        const volume5mUsd = firstFinite(candidate.volume, candidate.volume_5m, candidate.volume5m);
        if (volume5mUsd == null || volume5mUsd < Number(config.robinhoodAlertsMinVolume5mUsd ?? 100000)) {
          reject(summary, 'VOLUME_BELOW_MIN');
          continue;
        }
        if (seen[addressKey]?.alertedAt) {
          reject(summary, 'ALREADY_ALERTED');
          continue;
        }

        try {
          const needsInfo = extractGmgnTotalFeesEth(candidate) == null;
          const tokenInfo = needsInfo ? await fetchTokenInfo(address, { strict: true }) : {};
          const result = evaluateRobinhoodTokenCandidate(candidate, config, tokenInfo, startedAt);
          if (!result.eligible) {
            reject(summary, result.reason);
            continue;
          }

          summary.eligible += 1;
          let topHolderPercentages = [];
          try {
            topHolderPercentages = extractTopHolderPercentages(await fetchHolders(address, { limit: 20 }), 5);
          } catch {
            topHolderPercentages = [];
          }
          const sent = await sendAlert(formatRobinhoodTokenAlertMessage({
            ...result.normalized,
            topHolderPercentages,
          }), { address, source, alert: result.normalized });
          if (sent === false) throw Object.assign(new Error('Telegram alert delivery failed'), { code: 'TELEGRAM_SEND_FAILED' });

          seen[addressKey] = { alertedAt: now() };
          setState(STATE_KEY, { ...seen });
          summary.alerted += 1;
        } catch (error) {
          summary.failed += 1;
          summary.status = String(error?.code || '').startsWith('GMGN_')
            ? 'GMGN_PARTIAL_FAILURE'
            : 'ROBINHOOD_ALERT_PARTIAL_FAILURE';
          summary.errorCode ||= String(error?.code || 'ROBINHOOD_ALERT_PROCESSING_FAILED');
          console.warn(`[robinhood-alerts] candidate failed address=${address}: ${error.message}`);
        }
      }
      if (summary.fetched > 0 && summary.eligible === 0 && summary.failed === 0) {
        summary.status = 'GMGN_OK_FILTERED_OUT';
      }
    } catch (error) {
      summary.failed += 1;
      summary.status = String(error?.code || '').startsWith('GMGN_') ? 'GMGN_FAILED' : 'ROBINHOOD_ALERT_FAILED';
      summary.errorCode = String(error?.code || 'ROBINHOOD_ALERT_SCAN_FAILED');
      summary.error = String(error?.message || 'Robinhood alert scan failed');
      console.warn(`[robinhood-alerts] scan failed source=${source}: ${error.message}`);
    } finally {
      lastScanAt = now();
      scanInFlight = false;
      console.log(
        `[robinhood-alerts] scan source=${source} status=${summary.status} fetched=${summary.fetched} ` +
        `eligible=${summary.eligible} alerted=${summary.alerted} skipped=${summary.skipped} failed=${summary.failed}`
      );
    }
    return summary;
  }

  function start() {
    if (timer) return false;
    const intervalSec = Math.max(15, Number(getConfig().robinhoodAlertsPollIntervalSec) || 60);
    timer = setIntervalFn(() => scanOnce({ source: 'timer' }).catch((error) => {
      console.warn(`[robinhood-alerts] timer scan failed: ${error.message}`);
    }), intervalSec * 1000);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return {
    start,
    stop,
    scanOnce,
    status: () => ({ running: Boolean(timer), scanInFlight, lastScanAt, stateKey: STATE_KEY }),
  };
}
