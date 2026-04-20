import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier, formatSignal } from '../src/telegram.js';

test('TelegramNotifier reports disabled without creds', async () => {
  const notifier = new TelegramNotifier({ logger: { warn: () => {} } });
  assert.equal(notifier.enabled, false);
  const res = await notifier.send('hi');
  assert.equal(res.skipped, true);
});

test('TelegramNotifier posts to bot API', async () => {
  let capturedUrl;
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return { ok: true, async json() { return { ok: true }; } };
  };
  const notifier = new TelegramNotifier({
    botToken: 'abc',
    chatId: '123',
    fetchImpl,
  });
  await notifier.send('hello');
  assert.ok(capturedUrl.endsWith('/botabc/sendMessage'));
  assert.equal(capturedBody.chat_id, '123');
  assert.equal(capturedBody.text, 'hello');
});

test('formatSignal includes key fields', () => {
  const msg = formatSignal({
    market: {
      question: 'CS2 Major winner?',
      slug: 'cs2-major',
      yes: { price: 0.45 },
      no: { price: 0.5 },
      liquidity: 12345,
      volume24h: 789,
    },
    profitPercent: 5.2,
    sum: 0.95,
    daysToClose: 2.5,
    category: 'esports',
  });
  assert.ok(msg.includes('CS2 Major winner?'));
  assert.ok(msg.includes('esports'));
  assert.ok(msg.includes('5.20%'));
  assert.ok(msg.includes('polymarket.com/event/cs2-major'));
});
