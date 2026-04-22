import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier, TelegramQueue, formatSignal } from '../src/telegram.js';

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

test('TelegramNotifier retries on 429 then succeeds', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call < 3) {
      return {
        ok: false,
        status: 429,
        async text() { return 'rate limit'; },
        async json() { return {}; },
      };
    }
    return { ok: true, async json() { return { ok: true }; } };
  };
  const notifier = new TelegramNotifier({
    botToken: 'tok',
    chatId: '1',
    fetchImpl,
    logger: { warn: () => {}, error: () => {} },
    retryOptions: { retries: 5, baseMs: 1, maxMs: 5, jitter: 0 },
  });
  await notifier.send('hello');
  assert.equal(call, 3);
});

test('TelegramNotifier.enqueue returns immediately and does not throw on failure', async () => {
  const errors = [];
  const fetchImpl = async () => { throw new Error('nope'); };
  const notifier = new TelegramNotifier({
    botToken: 't',
    chatId: 'c',
    fetchImpl,
    logger: { warn: () => {}, error: (m) => errors.push(m) },
    retryOptions: { retries: 0 },
  });
  const start = Date.now();
  notifier.enqueue('msg-1');
  notifier.enqueue('msg-2');
  // enqueue must be sync — it returns void. Confirm by elapsed time:
  assert.ok(Date.now() - start < 50);
  await notifier.drain();
  assert.equal(errors.length, 2);
});

test('TelegramQueue serializes pushes', async () => {
  const order = [];
  const queue = new TelegramQueue({ logger: { error: () => {} } });
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  queue.push(async () => {
    order.push('first-start');
    await first;
    order.push('first-end');
  });
  queue.push(async () => {
    order.push('second');
  });
  resolveFirst();
  await queue.drain();
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
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
