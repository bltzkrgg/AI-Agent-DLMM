import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('telegram command handlers do not register duplicate regex patterns', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');
  const matches = [...content.matchAll(/bot\.onText\((\/[^,]+\/)/g)].map(m => m[1]);

  const counts = new Map();
  for (const pattern of matches) {
    counts.set(pattern, (counts.get(pattern) || 0) + 1);
  }

  const duplicates = [...counts.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(duplicates, []);
});

test('/strategy_report and /claim_fees handlers are registered', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /bot\.onText\(\/\\\/strategy_report\//);
  assert.match(content, /bot\.onText\(\/\\\/claim_fees/);
  assert.match(content, /AI-Agent-DLMM Strategy/);
});

test('/ca handler is registered and exposed in /start help', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /bot\.onText\(\/\\\/ca/);
  assert.match(content, /\/ca\s+— kirim CA \/ pool Meteora \/ cek posisi aktif/);
  assert.match(content, /HOLD = pantau dulu, DROP = buang/);
  assert.match(content, /Manual <code>\/ca<\/code> stays attach-only when <code>Manual TA Exit<\/code> is ON\./);
  assert.match(content, /bot\.on\('message'/);
});

test('/strategy_report uses sendLong transport to avoid Telegram length limit issues', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');
  const reportBlock = content.slice(
    content.indexOf("bot.onText(/\\/strategy_report/"),
    content.indexOf('// Research sessions state')
  );

  assert.match(reportBlock, /await sendLong\(chatId,\s*text\)/);
});

test('/config and startup messages expose realtime PnL interval', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /realtimePnlIntervalSec/);
  assert.match(content, /Realtime PnL/);
  assert.match(content, /realtimePnlSec/);
  assert.match(content, /reply_markup:\s*\{\s*inline_keyboard:/);
  assert.match(content, /setconfig_section:finance/);
  assert.match(content, /setconfig_section:discovery/);
  assert.match(content, /setconfig_section:strategy/);
  assert.match(content, /setconfig_section:entry/);
  assert.match(content, /setconfig_section:watch/);
  assert.match(content, /setconfig_section:oor/);
  assert.match(content, /setconfig_section:poolImpactGuard/);
  assert.match(content, /setconfig_section:poolPatternLearning/);
  assert.match(content, /buildSetconfigSectionMenu/);
  assert.match(content, /buildSetconfigSectionDetail/);
  assert.match(content, /isSetconfigSection/);
  assert.match(content, /isCommandShortcut/);
  assert.match(content, /runCommandShortcut/);
  assert.match(content, /await sendLong\(chatId, menu\.text, menu\.opts\)/);
});

test('startup and shutdown banners use the simplified AI-Agent-DLMM text', () => {
  const indexPath = join(__dirname, '../src/index.js');
  const content = readFileSync(indexPath, 'utf-8');

  assert.match(content, /🟢 <b>AI-Agent-DLMM Activated<\/b>/);
  assert.match(content, /Balance: <code>\$\{balance\} SOL<\/code>/);
  assert.match(content, /Deploy Size: <code>\$\{cfg\.deployAmountSol \|\| 0\.1\} SOL<\/code>/);
  assert.match(content, /formatTakeProfitRiskLabel\(cfg\.takeProfitMinNetPnlPct, cfg\.stopLossPct\)/);
  assert.match(content, /buildActivationLaunchPanel/);
  assert.match(content, /callback_data: 'cmd:\/autoscreen on'/);
  assert.match(content, /callback_data: 'cmd:\/manualexit on'/);
  assert.match(content, /callback_data: 'cmd:\/start'/);
  assert.match(content, /buildStartCommandPanel/);
  assert.match(content, /\/start — lihat command/);
  assert.match(content, /\/autoscreen — on\/off auto-screening/);
  assert.match(content, /\/manualexit — on\/off TA-only exit untuk \/ca manual/);
  assert.match(content, /🛑 <b>AI-Agent-DLMM Shutdown<\/b>/);
  assert.match(content, /Tidak ada posisi aktif\./);
  assert.match(content, /✅ AI-Agent-DLMM ready\. Balance:/);
});

test('telegram cycle report labels deferred scout state as HOLD', () => {
  const reporterPath = join(__dirname, '../src/utils/reporter.js');
  const content = readFileSync(reporterPath, 'utf-8');

  assert.match(content, /DEFER\/HOLD/);
});
