/**
 * Strict Unit Protocol
 * Handles BigInt conversions for Solana units to prevent precision loss.
 */

export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Converts any number/string/bigint to Lamports (BigInt)
 */
export function toLamports(amount, decimals = 9) {
  if (amount === null || amount === undefined) return 0n;
  
  const sAmount = String(amount).trim();
  if (sAmount === '0' || sAmount === '') return 0n;

  // Handle scientific notation or fractional strings
  const [integers, decimals_part = ''] = sAmount.split('.');
  const paddedDecimals = decimals_part.padEnd(decimals, '0').slice(0, decimals);
  
  return BigInt(integers || '0') * (10n ** BigInt(decimals)) + BigInt(paddedDecimals || '0');
}

/**
 * Converts Lamports (BigInt) to SOL (Number for display)
 */
export function fromLamports(lamports, decimals = 9) {
  const s = lamports.toString().padStart(decimals + 1, '0');
  const integerPart = s.slice(0, -decimals);
  const decimalPart = s.slice(-decimals);
  return parseFloat(`${integerPart}.${decimalPart}`);
}

/**
 * Converts SOL to Micro-Lamports (BigInt) for Priority Fees
 * 1 SOL = 10^9 Lamports = 10^15 Micro-Lamports
 */
export function toMicroLamports(solAmount) {
  return toLamports(solAmount, 15);
}

/**
 * Utility to sum an array of amounts safely
 */
export function sumBigInts(arr) {
  return arr.reduce((acc, val) => acc + BigInt(val), 0n);
}
