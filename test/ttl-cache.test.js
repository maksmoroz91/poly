import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/ttl-cache.js';

test('add+has tracks recent keys', () => {
  let now = 1_000;
  const cache = new TtlCache({ ttlMs: 100, now: () => now });
  cache.add('a');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
});

test('expired keys are dropped on read', () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 100, now: () => now });
  cache.add('a');
  now = 99;
  assert.equal(cache.has('a'), true);
  now = 200;
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size, 0);
});

test('prune removes only expired entries', () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 100, now: () => now });
  cache.add('a');
  now = 50;
  cache.add('b');
  now = 120;
  const removed = cache.prune();
  assert.equal(removed, 1);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('a'), false);
});

test('add re-bumps recency for an existing key', () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 100, now: () => now });
  cache.add('a');
  now = 80;
  cache.add('a'); // re-add resets timestamp
  now = 150;
  // 70ms after re-add — still fresh
  assert.equal(cache.has('a'), true);
});

test('maxSize trims oldest entry', () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 1000, maxSize: 2, now: () => now });
  cache.add('a');
  now = 1;
  cache.add('b');
  now = 2;
  cache.add('c');
  assert.equal(cache.size, 2);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
});

test('reopened market is re-emitted after TTL expiry', () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 60 * 60 * 1000, now: () => now });
  cache.add('cond-1');
  // Same scan iteration: filtered out as duplicate.
  assert.equal(cache.has('cond-1'), true);
  // 2 hours later: market reappears in API; cache must allow re-alert.
  now = 2 * 60 * 60 * 1000;
  assert.equal(cache.has('cond-1'), false);
});
