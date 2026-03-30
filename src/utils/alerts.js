/**
 * Standardized DLMM Strategy Alert formatter
 * Dipakai oleh Hunter, Healer, dan Opportunity Scanner
 */

export function formatStrategyAlert({ strategy, pool, poolAddress, reason, priority }) {
  const poolLine = poolAddress
    ? `\`${poolAddress.slice(0, 4)}…${poolAddress.slice(-4)}\`` +
      (pool ? `  (${pool})` : '')
    : (pool || '-');

  const priorityEmoji = priority === 'HIGH' ? '🔴' : priority === 'MEDIUM' ? '🟡' : '🟢';

  return (
    `🚨 *DLMM STRATEGY ALERT*\n\n` +
    `Strategy : *${strategy}*\n` +
    `Pool     : ${poolLine}\n` +
    `Entry    : SINGLE-SIDED SOL\n` +
    `Reason   : ${reason}\n` +
    `Priority : ${priorityEmoji} *${priority}*\n\n` +
    `${'─'.repeat(46)}`
  );
}
