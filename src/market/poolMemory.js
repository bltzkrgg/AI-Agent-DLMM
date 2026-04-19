/**
 * Pool Memory — per-pool deploy history & cooldown
 *
 * Setiap pool punya record:
 *   - totalDeploys, wins, losses, avgPnl, lastOutcome
 *   - Deploy records individual (max 20 terbaru)
 *   - Cooldown: blokir re-entry X jam setelah close
 *
 * Dipakai oleh:
 *   - Hunter: filter pool yang sedang cooldown
 *   - Healer: inject context "pool ini pernah rugi 3x berturut-turut"
 *   - index.js: update saat deploy & close
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const POOL_MEMORY_PATH = join(ROOT, 'pool-memory.json');

// Default cooldown setelah posisi ditutup dengan loss
const COOLDOWN_LOSS_HOURS   = 6;   // 6 jam cooldown jika rugi
const COOLDOWN_WIN_HOURS    = 1;   // 1 jam cooldown jika profit (boleh re-entry cepat)
const COOLDOWN_STREAK_HOURS = 24;  // 24 jam jika 2+ loss berturut-turut

function getOorConfig() {
  try {
    const cfg = getConfig();
    return {
      triggerCount:  cfg.oorCooldownTriggerCount ?? 3,
      cooldownHours: cfg.oorCooldownHours        ?? 12,
    };
  } catch {
    return { triggerCount: 3, cooldownHours: 12 };
  }
}

// ─── Load / Save ──────────────────────────────────────────────────

function loadPoolMemory() {
  if (!existsSync(POOL_MEMORY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(POOL_MEMORY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function savePoolMemory(memory) {
  try {
    const tmp = `${POOL_MEMORY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(memory, null, 2));
    renameSync(tmp, POOL_MEMORY_PATH);
  } catch (e) {
    console.error('⚠️ Failed to save pool-memory.json:', e.message);
  }
}

function getOrCreate(memory, poolAddress) {
  if (!memory[poolAddress]) {
    memory[poolAddress] = {
      poolAddress,
      totalDeploys:       0,
      wins:               0,
      losses:             0,
      avgPnlPct:          0,
      lastOutcome:        null,   // 'win' | 'loss'
      lastClosedAt:       null,
      cooldownUntil:      null,
      consecutiveLosses:  0,
      oorCloseCount:      0,      // total closes due to OUT_OF_RANGE
      deploys:            [],     // array of { pnlPct, reason, deployedAt, closedAt }
    };
  }
  return memory[poolAddress];
}

// ─── Public: record deployment ────────────────────────────────────

export function recordDeployment(poolAddress, { deployedAt = null } = {}) {
  if (!poolAddress) return;
  const memory = loadPoolMemory();
  const pool   = getOrCreate(memory, poolAddress);
  pool.totalDeploys++;
  pool.deploys.push({
    pnlPct:     null,
    reason:     null,
    deployedAt: deployedAt || new Date().toISOString(),
    closedAt:   null,
  });
  // Keep max 20 deploys
  if (pool.deploys.length > 20) pool.deploys = pool.deploys.slice(-20);
  savePoolMemory(memory);
}

// ─── Public: record close outcome ─────────────────────────────────

export function recordClose(poolAddress, { pnlPct = 0, reason = 'unknown', closedAt = null } = {}) {
  if (!poolAddress) return;
  const memory = loadPoolMemory();
  const pool   = getOrCreate(memory, poolAddress);

  const isWin  = pnlPct > 0;
  const closedTs = closedAt || new Date().toISOString();

  if (isWin) {
    pool.wins++;
    pool.consecutiveLosses = 0;
    pool.lastOutcome = 'win';
  } else {
    pool.losses++;
    pool.consecutiveLosses = (pool.consecutiveLosses || 0) + 1;
    pool.lastOutcome = 'loss';
  }

  pool.lastClosedAt = closedTs;

  // Update avg PnL (rolling average)
  const total = pool.wins + pool.losses;
  pool.avgPnlPct = parseFloat(
    ((pool.avgPnlPct * (total - 1) + pnlPct) / total).toFixed(2)
  );

  // Update last deploy record
  const last = pool.deploys[pool.deploys.length - 1];
  if (last && last.closedAt === null) {
    last.pnlPct   = pnlPct;
    last.reason   = reason;
    last.closedAt = closedTs;
  }

  // OOR-specific cooldown tracking
  const isOorClose = /out.?of.?range|oor/i.test(reason || '');
  if (isOorClose) {
    pool.oorCloseCount = (pool.oorCloseCount || 0) + 1;
  }

  // Set cooldown
  const cfg = getConfig();
  const rawCooldownMin = Number(cfg.slCooldownMinutes);
  const configuredLossCooldownHours = Math.max(
    0,
    (Number.isFinite(rawCooldownMin) ? rawCooldownMin : COOLDOWN_LOSS_HOURS * 60) / 60
  );
  let cooldownHours = isWin ? COOLDOWN_WIN_HOURS : configuredLossCooldownHours;
  if (!isWin && pool.consecutiveLosses >= 2) cooldownHours = COOLDOWN_STREAK_HOURS;

  // OOR-specific cooldown overrides normal cooldown if trigger count reached
  if (isOorClose) {
    const oorCfg = getOorConfig();
    if (pool.oorCloseCount >= oorCfg.triggerCount) {
      cooldownHours = Math.max(cooldownHours, oorCfg.cooldownHours);
    }
  }

  const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
  pool.cooldownUntil = cooldownUntil.toISOString();

  savePoolMemory(memory);
  return pool;
}

// ─── Public: cek apakah pool sedang cooldown ─────────────────────

export function isOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const memory = loadPoolMemory();
  const pool   = memory[poolAddress];
  if (!pool?.cooldownUntil) return false;
  return new Date(pool.cooldownUntil) > new Date();
}

// ─── Public: ambil memory satu pool ──────────────────────────────

export function getPoolMemory(poolAddress) {
  const memory = loadPoolMemory();
  const pool = memory[poolAddress];
  if (!pool) return null;
  const total = (pool.wins || 0) + (pool.losses || 0);
  return {
    ...pool,
    totalTrades: total,
    winRate: total > 0 ? parseFloat(((pool.wins || 0) / total).toFixed(3)) : null,
  };
}

// ─── Public: context string untuk inject ke prompt ───────────────

export function getPoolMemoryContext(poolAddress) {
  const pool = getPoolMemory(poolAddress);
  if (!pool || pool.totalDeploys === 0) return '';

  const winRate = pool.totalDeploys > 0
    ? ((pool.wins / pool.totalDeploys) * 100).toFixed(0)
    : '0';

  const cooldownMsg = pool.cooldownUntil && new Date(pool.cooldownUntil) > new Date()
    ? ` ⏳ Cooldown sampai ${new Date(pool.cooldownUntil).toLocaleTimeString('id-ID')}`
    : '';

  const oorCfg = getOorConfig();
  return `\n📦 POOL MEMORY [${poolAddress.slice(0, 8)}...]:\n` +
    `  Deploy: ${pool.totalDeploys}x | Win: ${pool.wins} Loss: ${pool.losses} (${winRate}%)\n` +
    `  Avg PnL: ${pool.avgPnlPct >= 0 ? '+' : ''}${pool.avgPnlPct}% | Last: ${pool.lastOutcome || '-'}${cooldownMsg}\n` +
    (pool.consecutiveLosses >= 2 ? `  ⚠️ STREAK LOSS: ${pool.consecutiveLosses}x berturut-turut!\n` : '') +
    (pool.oorCloseCount >= oorCfg.triggerCount ? `  ⚠️ OOR: ${pool.oorCloseCount}x tutup karena out-of-range!\n` : '');
}

// ─── Public: daftar semua pool dengan context ─────────────────────

export function getAllPoolMemory() {
  return loadPoolMemory();
}

// ─── Public: format top/bottom pools untuk Telegram ──────────────

export function formatPoolMemoryReport() {
  const memory = loadPoolMemory();
  const pools  = Object.values(memory).filter(p => p.totalDeploys >= 2);
  if (pools.length === 0) return 'Belum ada pool dengan ≥2 deployment untuk dibandingkan.';

  const sorted = pools.sort((a, b) => b.avgPnlPct - a.avgPnlPct);
  const top3   = sorted.slice(0, 3);
  const bot3   = sorted.slice(-3).reverse();

  let text = `🏆 *Pool Memory Report*\n\n`;
  text += `*Top Performer:*\n`;
  for (const p of top3) {
    const wr = ((p.wins / p.totalDeploys) * 100).toFixed(0);
    text += `• \`${p.poolAddress.slice(0, 8)}...\` — avg ${p.avgPnlPct >= 0 ? '+' : ''}${p.avgPnlPct}% | ${p.totalDeploys}x | ${wr}% win\n`;
  }

  if (bot3.length > 0 && bot3[0].poolAddress !== top3[top3.length - 1]?.poolAddress) {
    text += `\n*Worst Performer:*\n`;
    for (const p of bot3) {
      const wr = ((p.wins / p.totalDeploys) * 100).toFixed(0);
      text += `• \`${p.poolAddress.slice(0, 8)}...\` — avg ${p.avgPnlPct >= 0 ? '+' : ''}${p.avgPnlPct}% | ${p.totalDeploys}x | ${wr}% win\n`;
    }
  }

  return text;
}
