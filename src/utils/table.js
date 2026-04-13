// Terminal-style table helpers for Telegram messages
import { safeNum } from './safeJson.js';
// All output goes inside ``` code blocks for monospace alignment

export const padR = (str, n) => {
  const s = String(str ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};

export const padL = (str, n) => {
  const s = String(str ?? '');
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
};

export const hr = (n, ch = '─') => ch.repeat(n);

// Key-value row: "Pool     : AB12…"
export const kv = (key, val, kw = 9) => padR(key, kw) + ': ' + String(val ?? '');

// Wrap lines in a Telegram code block
export const codeBlock = (lines) => '```\n' + lines.join('\n') + '\n```';

// Format PnL with mandatory sign: "+$1.23 +4.56%"
export const formatPnl = (usd, pct) => {
  const u = safeNum(usd) || 0;
  const p = safeNum(pct) || 0;
  const sign = (v) => v >= 0 ? '+' : '';
  return `${sign(u)}$${Math.abs(u).toFixed(2)}  ${sign(p)}${Math.abs(p).toFixed(2)}%`;
};

// Short pool/position address: "AB12…EF78"
export const shortAddr = (addr, head = 4, tail = 4) =>
  addr ? addr.slice(0, head) + '…' + addr.slice(-tail) : '?';

// Strategy display name — shorten common names to fit column width
export const shortStrat = (name) => {
  if (!name) return 'default';
  return name
    .replace('Single-Side SOL', 'SS-SOL')
    .replace('Single-Side Token X', 'SS-TokenX')
    .replace('Curve Concentrated', 'Curve Conc')
    .replace('Bid-Ask Wide', 'Bid-Ask')
    .replace('Spot Balanced', 'Spot Bal')
    .replace('Evil Panda', 'Evil Panda');
};
