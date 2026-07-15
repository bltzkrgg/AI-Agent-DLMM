'use strict';

function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatClosedPositionDuration(openedAt = null, closedAt = Date.now()) {
  const openedMs = new Date(openedAt || '').getTime();
  const closedMs = new Date(closedAt || Date.now()).getTime();
  if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs) || closedMs < openedMs) {
    return 'UNKNOWN';
  }

  const totalMinutes = Math.max(0, Math.floor((closedMs - openedMs) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function buildClosedPositionReport({
  tokenLabel = 'UNKNOWN',
  pnlSol = null,
  pnlPct = null,
  feesSol = null,
  depositSol = null,
  takeHomeSol = null,
  exitLabel = 'Exit',
  openedAt = null,
  closedAt = Date.now(),
  inRange = null,
  rangeLabel = 'Range at Close',
  estimated = false,
  feesFromLastSnapshot = false,
  extraLines = [],
} = {}) {
  const pnlSolNum = finiteNumber(pnlSol);
  const pnlPctNum = finiteNumber(pnlPct);
  const feesSolNum = finiteNumber(feesSol);
  const depositSolNum = finiteNumber(depositSol);
  const takeHomeSolNum = finiteNumber(takeHomeSol);
  const directionValue = pnlSolNum ?? pnlPctNum;
  const statusIcon = directionValue > 0 ? '🟢' : directionValue < 0 ? '🔴' : '⚪';
  const pairLabel = String(tokenLabel || 'UNKNOWN').toUpperCase().endsWith('-SOL')
    ? String(tokenLabel)
    : `${String(tokenLabel || 'UNKNOWN')}-SOL`;
  const pnlText = pnlSolNum !== null && pnlPctNum !== null
    ? `${pnlSolNum >= 0 ? '+' : ''}${pnlSolNum.toFixed(6)} SOL (${pnlPctNum >= 0 ? '+' : ''}${pnlPctNum.toFixed(2)}%)`
    : 'N/A';
  const feeText = feesSolNum !== null ? `${feesSolNum.toFixed(6)} SOL` : 'N/A';
  const depositText = depositSolNum !== null ? `${depositSolNum.toFixed(6)} SOL` : 'N/A';
  const takeHomeText = takeHomeSolNum !== null ? `${takeHomeSolNum.toFixed(6)} SOL` : 'N/A';
  const rangeStatus = inRange === true ? 'IN_RANGE' : inRange === false ? 'OUT_OF_RANGE' : 'UNKNOWN';
  const estimatedTag = estimated ? ' <i>[ESTIMATED]</i>' : '';
  const feeSnapshotTag = feesFromLastSnapshot ? ' <i>[LAST SNAPSHOT]</i>' : '';
  const lines = [
    `${statusIcon} <b>CLOSED | ${escapeHTML(pairLabel)}</b>`,
    `💰 PnL : <code>${pnlText}</code>${estimatedTag}`,
    `💸 Fees: <code>${feeText}</code>${feeSnapshotTag}`,
    `📦 Deposit: <code>${depositText}</code>`,
    `💵 Take Home Pay : <code>${takeHomeText}</code>${estimatedTag}`,
    `🤖 Exit : <code>${escapeHTML(exitLabel)}</code>`,
    `⏱️ Duration : <code>${formatClosedPositionDuration(openedAt, closedAt)}</code> | ${escapeHTML(rangeLabel)}: <code>${rangeStatus}</code>`,
  ];

  for (const line of extraLines) {
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
