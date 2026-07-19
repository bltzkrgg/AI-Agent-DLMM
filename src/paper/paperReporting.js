'use strict';

import { escapeHTML } from '../utils/safeJson.js';
import { formatClosedPositionDuration } from '../utils/exitReport.js';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatSol(value, digits = 6) {
  const numeric = finiteNumber(value);
  return numeric === null ? 'N/A' : `${numeric.toFixed(digits)} SOL`;
}

function formatSignedSol(value, digits = 6) {
  const numeric = finiteNumber(value);
  if (numeric === null) return 'N/A';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)} SOL`;
}

function formatSignedPct(value) {
  const numeric = finiteNumber(value);
  if (numeric === null) return 'N/A';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}%`;
}

function getRangeStatus(position = {}) {
  if (position.inRange === true) return 'IN_RANGE';
  if (position.inRange === false) return 'OUT_OF_RANGE';
  return 'UNKNOWN';
}

function getPairLabel(position = {}) {
  const symbol = String(
    position.symbol ||
    position.tokenXSymbol ||
    position.tokenMint ||
    position.tokenXMint ||
    'UNKNOWN'
  );
  return symbol.toUpperCase().endsWith('-SOL') ? symbol : `${symbol}-SOL`;
}

function getPnlIcon(pnlSol, pnlPct) {
  const value = finiteNumber(pnlSol) ?? finiteNumber(pnlPct) ?? 0;
  return value > 0 ? '🟢' : value < 0 ? '🔴' : '⚪';
}

function getPaperFeeEstimate(position = {}) {
  const available = position.feePnlAvailable === true &&
    String(position.feePnlSource || '').startsWith('paper_pool_fee_tvl_estimate');
  const feePnlSol = available ? finiteNumber(position.feePnlSol) : null;
  const feePnlPct = available ? finiteNumber(position.feePnlPct) : null;
  const netPnlSol = available
    ? finiteNumber(position.estimatedNetPnlSol)
    : null;
  const netPnlPct = available
    ? finiteNumber(position.estimatedNetPnlPct)
    : null;
  const netValueSol = available
    ? finiteNumber(position.estimatedNetValueSol)
    : null;
  return {
    available,
    feePnlSol,
    feePnlPct,
    netPnlSol,
    netPnlPct,
    netValueSol,
  };
}

function formatEstimatedFee(value) {
  return value === null ? 'N/A' : formatSignedSol(value);
}

function formatEstimatedPnl(sol, pct) {
  if (sol === null || pct === null) return 'N/A';
  return `${formatSignedSol(sol)} / ${formatSignedPct(pct)}`;
}

export function formatPaperPositionsTelegram(positions = [], {
  dryRun = false,
  maxItems = 8,
} = {}) {
  const rows = Array.isArray(positions) ? positions : [];
  const lines = [
    `🧪 <b>PAPER LP STATUS</b>`,
    `New Entry Mode: <code>${dryRun ? 'PAPER' : 'REAL'}</code>`,
    `Active Paper Positions: <code>${rows.length}</code>`,
    `Accounting: <code>PRICE + ESTIMATED FEES</code>`,
  ];

  if (rows.length === 0) {
    lines.push('', '<i>Belum ada posisi paper aktif.</i>');
    return lines.join('\n');
  }

  const safeLimit = Math.max(1, Number(maxItems) || 8);
  for (const [index, position] of rows.slice(0, safeLimit).entries()) {
    const pnlSol = finiteNumber(position.pnlSol ?? position.pnlTotalSol);
    const pnlPct = finiteNumber(position.pnlPct ?? position.pnlTotalPct);
    const currentBin = finiteNumber(position.activeBinId);
    const rangeMin = finiteNumber(position.rangeMin);
    const rangeMax = finiteNumber(position.rangeMax);
    const feeEstimate = getPaperFeeEstimate(position);
    lines.push(
      '',
      `${index + 1}. ${getPnlIcon(pnlSol, pnlPct)} <b>${escapeHTML(getPairLabel(position))}</b>`,
      `Paper ID: <code>${escapeHTML(String(position.id || 'UNKNOWN').slice(0, 28))}</code>`,
      `Virtual Deposit: <code>${formatSol(position.deploySol, 4)}</code>`,
      `Virtual Value (Price): <code>${formatSol(position.currentValueSol, 4)}</code>`,
      `Price PnL: <code>${formatSignedSol(pnlSol)} / ${formatSignedPct(pnlPct)}</code>`,
      `Estimated Fees: <code>${formatEstimatedFee(feeEstimate.feePnlSol)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
      `Estimated Net PnL: <code>${formatEstimatedPnl(feeEstimate.netPnlSol, feeEstimate.netPnlPct)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
      `Estimated Net Value: <code>${formatSol(feeEstimate.netValueSol, 4)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
      `Bin: <code>${currentBin ?? 'N/A'}</code> | Range: <code>${rangeMin ?? 'N/A'}-${rangeMax ?? 'N/A'}</code>`,
      `Status: <code>${getRangeStatus(position)}</code> | Action: <code>${escapeHTML(position.action || 'HOLD')}</code>`,
      `Data: <code>${escapeHTML(position.dataState || 'WAITING')}</code>`
    );
  }

  if (rows.length > safeLimit) {
    lines.push('', `<i>${rows.length - safeLimit} posisi paper lainnya tidak ditampilkan.</i>`);
  }
  lines.push('', '<i>Fee paper adalah estimasi berbasis fee/TVL pool saat posisi berada dalam range.</i>');
  return lines.join('\n');
}

export function formatPaperOpenedNotification(position = {}) {
  return [
    `🧪 <b>PAPER OPENED | ${escapeHTML(getPairLabel(position))}</b>`,
    `Pool: <code>${escapeHTML(String(position.poolAddress || 'UNKNOWN').slice(0, 8))}</code>`,
    `Paper ID: <code>${escapeHTML(String(position.id || 'UNKNOWN').slice(0, 28))}</code>`,
    `Virtual Deposit: <code>${formatSol(position.deploySol, 4)}</code>`,
    `Entry Price: <code>${finiteNumber(position.entryPrice)?.toPrecision(8) ?? 'N/A'}</code>`,
    `Entry Bin: <code>${finiteNumber(position.entryActiveBin) ?? 'N/A'}</code>`,
    `Range: <code>${finiteNumber(position.rangeMin) ?? 'N/A'}-${finiteNumber(position.rangeMax) ?? 'N/A'}</code>`,
    `Fees: <code>N/A</code>`,
    `<i>Simulasi aktif. Tidak ada modal, signing, atau transaksi on-chain.</i>`,
  ].join('\n');
}

export function formatPaperRealtimeNotification({
  position = {},
  status = {},
  intervalSec = 0,
} = {}) {
  const pnlSol = finiteNumber(status.pnlSol ?? status.pnlTotalSol);
  const pnlPct = finiteNumber(status.pnlPct ?? status.pnlTotalPct);
  const feeEstimate = getPaperFeeEstimate(status);
  return [
    `📊 <b>PAPER REALTIME | ${escapeHTML(getPairLabel(position))}</b>`,
    `Price PnL: <code>${formatSignedSol(pnlSol)} / ${formatSignedPct(pnlPct)}</code>`,
    `Virtual Value (Price): <code>${formatSol(status.currentValueSol, 4)}</code>`,
    `Estimated Fees: <code>${formatEstimatedFee(feeEstimate.feePnlSol)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Estimated Net PnL: <code>${formatEstimatedPnl(feeEstimate.netPnlSol, feeEstimate.netPnlPct)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Estimated Net Value: <code>${formatSol(feeEstimate.netValueSol, 4)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Active Bin: <code>${finiteNumber(status.activeBinId) ?? 'N/A'}</code>`,
    `Range: <code>${getRangeStatus(status)}</code>`,
    `Action: <code>${escapeHTML(status.action || 'HOLD')}</code>`,
    `Interval: <code>${Math.max(0, Number(intervalSec) || 0)}s</code>`,
  ].join('\n');
}

export function formatPaperClosedNotification({
  position = {},
  closed = {},
  action = 'PAPER_CLOSE',
  reason = '',
} = {}) {
  const pnlSol = finiteNumber(closed.pnlSol ?? closed.pnlTotalSol);
  const pnlPct = finiteNumber(closed.pnlPct ?? closed.pnlTotalPct);
  const icon = getPnlIcon(pnlSol, pnlPct);
  const feeEstimate = getPaperFeeEstimate(closed);
  return [
    `${icon} <b>PAPER CLOSED | ${escapeHTML(getPairLabel(position))}</b>`,
    `Price PnL: <code>${formatSignedSol(pnlSol)} / ${formatSignedPct(pnlPct)}</code>`,
    `Estimated Fees: <code>${formatEstimatedFee(feeEstimate.feePnlSol)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Estimated Net PnL: <code>${formatEstimatedPnl(feeEstimate.netPnlSol, feeEstimate.netPnlPct)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Virtual Deposit: <code>${formatSol(position.deploySol, 4)}</code>`,
    `Virtual Value at Exit (Price): <code>${formatSol(closed.currentValueSol, 4)}</code>`,
    `Estimated Net Value at Exit: <code>${formatSol(feeEstimate.netValueSol, 4)}</code>${feeEstimate.available ? ' <i>[ESTIMATED]</i>' : ''}`,
    `Exit: <code>${escapeHTML(action)}</code>`,
    `Duration: <code>${formatClosedPositionDuration(position.openedAt, closed.closedAt || Date.now())}</code> | ` +
      `Range: <code>${getRangeStatus(closed)}</code>`,
    `<i>${escapeHTML(reason || 'Paper exit policy triggered.')}</i>`,
    `<i>Fee estimate memakai fee/TVL pool selama posisi berada dalam range; bukan fee aktual per bin.</i>`,
  ].join('\n');
}
