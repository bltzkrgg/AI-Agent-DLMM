import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TELEGRAM_COMMANDS,
  registerTelegramCommandMenu,
} from '../src/telegram/commandMenu.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('command menu keeps runner commands prominent and command names unique', () => {
  const commands = TELEGRAM_COMMANDS.map(({ command }) => command);

  assert.equal(new Set(commands).size, commands.length);
  assert.deepEqual(commands.slice(0, 4), [
    'start',
    'status',
    'tokenalerts',
    'robinhood',
  ]);
  assert.ok(commands.includes('strategy_report'));
  assert.ok(commands.includes('claim_fees'));
});

test('bot startup registers the native Telegram command menu', () => {
  const index = readFileSync(join(__dirname, '../src/index.js'), 'utf8');

  assert.match(index, /await registerTelegramCommandMenu\(bot, CHAT_ID\)/);
  assert.match(index, /command menu registration failed/);
});

test('registerTelegramCommandMenu installs commands and activates the menu button', async () => {
  const calls = [];
  const bot = {
    async setMyCommands(commands, options) {
      calls.push(['commands', commands, options]);
    },
    async setChatMenuButton(options) {
      calls.push(['menu', options]);
    },
  };

  await registerTelegramCommandMenu(bot, 123456);

  assert.deepEqual(calls, [
    [
      'commands',
      TELEGRAM_COMMANDS,
      { scope: { type: 'chat', chat_id: 123456 } },
    ],
    [
      'menu',
      {
        chat_id: 123456,
        menu_button: { type: 'commands' },
      },
    ],
  ]);
});
