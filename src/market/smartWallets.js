/**
 * Smart Wallets — alpha wallet tracking
 *
 * Simpan daftar wallet yang dikenal sebagai "alpha" LP/holder.
 * Saat screening: cek apakah wallet ini ada di top holders pool.
 * Jika ada → boost confidence sinyal entry.
 *
 * Telegram commands (di index.js):
 *   /addwallet <address> <label>   — tambah ke list
 *   /removewallet <address>        — hapus dari list
 *   /listwallet                    — tampilkan semua
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchWithTimeout } from '../utils/safeJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const WALLETS_PATH = join(ROOT, 'smart-wallets.json');

const METEORA_DATAPI = 'https://dlmm.datapi.meteora.ag';

// ─── Load / Save ──────────────────────────────────────────────────

export function loadSmartWallets() {
  if (!existsSync(WALLETS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(WALLETS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSmartWallets(list) {
  try {
    writeFileSync(WALLETS_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('⚠️ Failed to save smart-wallets.json:', e.message);
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────

export function addSmartWallet(address, label = 'unknown', type = 'alpha') {
  if (!address || address.length < 32) return { ok: false, reason: 'Alamat tidak valid' };
  const list = loadSmartWallets();
  if (list.find(w => w.address === address)) {
    return { ok: false, reason: 'Wallet sudah ada di list' };
  }
  list.push({ address, label, type, addedAt: new Date().toISOString() });
  saveSmartWallets(list);
  return { ok: true };
}

export function removeSmartWallet(address) {
  const list = loadSmartWallets();
  const before = list.length;
  const filtered = list.filter(w => w.address !== address);
  if (filtered.length === before) return { ok: false, reason: 'Wallet tidak ditemukan' };
  saveSmartWallets(filtered);
  return { ok: true };
}

export function listSmartWallets() {
  return loadSmartWallets();
}

// ─── Check presence in pool ───────────────────────────────────────
// Fetch top LPers dari Meteora API dan cek apakah ada wallet kita di sana.
// Returns { found: bool, matches: [{ address, label }], confidence: 0-1 }

export async function checkSmartWalletsOnPool(poolAddress) {
  const wallets = loadSmartWallets();
  if (wallets.length === 0) return { found: false, matches: [], confidence: 0 };

  const walletSet = new Set(wallets.map(w => w.address));

  try {
    // Fetch top LPers dari pool
    const res = await fetchWithTimeout(
      `${METEORA_DATAPI}/position/top_lpers?pool=${poolAddress}&limit=20`,
      { headers: { Accept: 'application/json' } },
      8000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Extract addresses (struktur Meteora: array of { owner, ... })
    const lpers = Array.isArray(data) ? data : (data?.data || data?.positions || []);
    const matches = [];

    for (const lper of lpers) {
      const owner = lper.owner || lper.wallet || lper.address;
      if (owner && walletSet.has(owner)) {
        const meta = wallets.find(w => w.address === owner);
        matches.push({ address: owner, label: meta?.label || 'unknown', type: meta?.type || 'alpha' });
      }
    }

    // Confidence: 0.3 per wallet found, max 1.0
    const confidence = Math.min(1.0, matches.length * 0.3);
    return { found: matches.length > 0, matches, confidence };

  } catch {
    return { found: false, matches: [], confidence: 0 };
  }
}

// ─── Format context untuk inject ke prompt ────────────────────────

export function formatSmartWalletSignal(checkResult, poolAddress) {
  if (!checkResult?.found) return '';
  const names = checkResult.matches.map(m => m.label).join(', ');
  return `\n🎯 SMART WALLET DETECTED [${poolAddress?.slice(0, 8)}...]: ${names} (${checkResult.matches.length} wallet, conf: ${(checkResult.confidence * 100).toFixed(0)}%)`;
}

// ─── Telegram format ──────────────────────────────────────────────

export function formatWalletList() {
  const list = loadSmartWallets();
  if (list.length === 0) return '📋 Belum ada smart wallet tersimpan.\n\nGunakan: `/addwallet <address> <label>`';

  let text = `📋 *Smart Wallets (${list.length})*\n\n`;
  for (const w of list) {
    const added = w.addedAt ? new Date(w.addedAt).toLocaleDateString('id-ID') : '-';
    text += `• \`${w.address.slice(0, 12)}...\` — *${w.label}* [${w.type}] (${added})\n`;
  }
  return text;
}
