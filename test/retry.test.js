import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry, defaultIsRetryable, HttpError, backoffDelay } from '../src/retry.js';

test('retry returns the value on first success', async () => {
  const result = await retry(async () => 'hello', { retries: 3 });
  assert.equal(result, 'hello');
});

test('retry retries on retryable errors and eventually succeeds', async () => {
  let attempts = 0;
  const out = await retry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new HttpError('boom', { status: 503 });
      return 'ok';
    },
    { retries: 5, baseMs: 1, maxMs: 5, jitter: 0 },
  );
  assert.equal(attempts, 3);
  assert.equal(out, 'ok');
});

test('retry surfaces non-retryable errors immediately', async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw new HttpError('client error', { status: 400 });
      },
      { retries: 5, baseMs: 1, maxMs: 5, jitter: 0 },
    ),
    /client error/,
  );
  assert.equal(attempts, 1);
});

test('retry gives up after configured retries', async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw new HttpError('boom', { status: 502 });
      },
      { retries: 2, baseMs: 1, maxMs: 5, jitter: 0 },
    ),
    /boom/,
  );
  assert.equal(attempts, 3); // initial + 2 retries
});

test('defaultIsRetryable classifies common cases', () => {
  assert.equal(defaultIsRetryable(new HttpError('x', { status: 429 })), true);
  assert.equal(defaultIsRetryable(new HttpError('x', { status: 500 })), true);
  assert.equal(defaultIsRetryable(new HttpError('x', { status: 404 })), false);
  const network = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  assert.equal(defaultIsRetryable(network), true);
});

test('backoffDelay grows roughly exponentially within bounds', () => {
  const a = backoffDelay({ attempt: 1, baseMs: 100, maxMs: 10_000, jitter: 0 });
  const b = backoffDelay({ attempt: 2, baseMs: 100, maxMs: 10_000, jitter: 0 });
  const c = backoffDelay({ attempt: 3, baseMs: 100, maxMs: 10_000, jitter: 0 });
  assert.equal(a, 100);
  assert.equal(b, 200);
  assert.equal(c, 400);
});
