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
