import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageTransport } from '../src/telegram/messageTransport.js';

test('message transport splits long text into chunks', async () => {
  const sent = [];
  const bot = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
  const { sendLong } = createMessageTransport(bot, 123);
  await sendLong(1, 'a'.repeat(9000), {});
  assert.equal(sent.length >= 3, true);
  assert.equal(sent.every((m) => m.text.length <= 4000), true);
});

test('notify sends markdown to allowed chat', async () => {
  const sent = [];
  const bot = {
    async sendMessage(chatId, text, opts) {
      sent.push({ chatId, text, opts });
    },
  };
  const { notify } = createMessageTransport(bot, 777);
  await notify('hello');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 777);
  assert.equal(sent[0].opts.parse_mode, 'Markdown');
});
