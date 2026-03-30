/**
 * Token metadata resolution: mint address → { symbol, decimals }
 * Cache: in-memory Map (process lifetime). Hits known tokens instantly,
 * falls back to Jupiter API then DexScreener for unknowns.
 */
import { fetchWithTimeout } from './safeJson.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Well-known tokens — zero API calls, always correct ──────────
const KNOWN = {
  [WSOL_MINT]:                                          { symbol: 'SOL',     decimals: 9 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':    { symbol: 'USDC',    decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':     { symbol: 'USDT',    decimals: 6 },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':    { symbol: 'BONK',    decimals: 5 },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':      { symbol: 'JUP',     decimals: 6 },
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':    { symbol: 'WIF',     decimals: 6 },
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3':     { symbol: 'PYTH',    decimals: 6 },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':      { symbol: 'mSOL',    decimals: 9 },
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':     { symbol: 'jitoSOL', decimals: 9 },
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':      { symbol: 'bSOL',    decimals: 9 },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj':     { symbol: 'stSOL',   decimals: 9 },
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE':       { symbol: 'ORCA',    decimals: 6 },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':     { symbol: 'RAY',     decimals: 6 },
  'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk':       { symbol: 'WEN',     decimals: 5 },
  'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey':      { symbol: 'MNDE',    decimals: 9 },
  'SHDWyBxihqiCjDYwQBuLFQpKpKBjsPEGivwNxUcDt5N':      { symbol: 'SHDW',    decimals: 9 },
  'nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7':      { symbol: 'NOS',     decimals: 6 },
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5':       { symbol: 'MEW',     decimals: 5 },
  'A3eME5CetyZPBoWbRUwY3tSe25S6tb18ba9ZPbWk9eFJ':      { symbol: 'PENG',    decimals: 6 },
  'EzfgjvkSwthhgHtLLUL1zp5LBsy7xhpubjvg34sGEyTe':     { symbol: 'FWOG',    decimals: 6 },
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82':       { symbol: 'BOME',    decimals: 6 },
  'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump':      { symbol: 'CHILLGUY',decimals: 6 },
  '8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB':      { symbol: 'GECKO',   decimals: 6 },
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux':       { symbol: 'HNT',     decimals: 8 },
  'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6':        { symbol: 'MOBILE',  decimals: 6 },
  '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn':       { symbol: 'JSOL',    decimals: 9 },
  'ANViTbPnCbTBVbzFPGPqG4ta8oMKQqfE3G2TNxSdFxE6':      { symbol: 'ANIME',   decimals: 6 },
};

const _cache = new Map(Object.entries(KNOWN));

/**
 * Resolve a Solana mint address to { symbol, decimals }.
 * Results are cached for the process lifetime.
 */
export async function resolveToken(mintAddress) {
  if (!mintAddress) return { symbol: '???', decimals: 9 };

  const cached = _cache.get(mintAddress);
  if (cached) return cached;

  // ── Jupiter per-token API ─────────────────────────────────────
  try {
    const res = await fetchWithTimeout(
      `https://lite.jupiter.ag/v6/token/${mintAddress}`,
      { headers: { Accept: 'application/json' } },
      6000
    );
    if (res.ok) {
      const d = await res.json();
      if (d?.symbol) {
        const meta = { symbol: d.symbol, decimals: typeof d.decimals === 'number' ? d.decimals : 9 };
        _cache.set(mintAddress, meta);
        return meta;
      }
    }
  } catch { /* fallthrough */ }

  // ── DexScreener fallback ──────────────────────────────────────
  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      {},
      6000
    );
    if (res.ok) {
      const d = await res.json();
      const pair = d.pairs?.[0];
      if (pair) {
        const isBase = pair.baseToken?.address === mintAddress;
        const sym = isBase ? pair.baseToken?.symbol : pair.quoteToken?.symbol;
        if (sym) {
          // DexScreener does not provide decimals — keep SDK value if available
          const meta = { symbol: sym, decimals: 9 };
          _cache.set(mintAddress, meta);
          return meta;
        }
      }
    }
  } catch { /* fallthrough */ }

  // ── Last resort: truncated mint ───────────────────────────────
  const meta = { symbol: mintAddress.slice(0, 5) + '..', decimals: 9 };
  _cache.set(mintAddress, meta);
  return meta;
}

/**
 * Batch resolve multiple mints in parallel.
 */
export async function resolveTokens(mints) {
  return Promise.all(mints.map(resolveToken));
}
