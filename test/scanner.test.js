import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeArbitrage, passesFilters, scan, daysUntil } from '../src/scanner.js';

const baseCfg = {
  minProfitPercent: 3,
  maxBetUsdc: 10,
  daysToClose: 7,
  minLiquidityUsdc: 5000,
  minVolume24hUsdc: 500,
  feePercent: 2,
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function market(overrides = {}) {
  return {
    id: '1',
    conditionId: '0xabc',
    slug: 'dota-2-final',
    question: 'Will Team Spirit win the Dota 2 Major?',
    category: 'Sports',
    endDateIso: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    liquidity: 10_000,
    volume24h: 2_000,
    yes: { price: 0.45, tokenId: 'y1' },
    no: { price: 0.5, tokenId: 'n1' },
    outcomes: ['Yes', 'No'],
    ...overrides,
  };
}

test('computeArbitrage flags sub-threshold sums', () => {
  const arb = computeArbitrage({ yesAsk: 0.45, noAsk: 0.5, feePercent: 2 });
  assert.equal(arb.isOpportunity, true);
  assert.ok(arb.profitPercent > 0);
});

test('computeArbitrage does not flag when sum + fee >= 1', () => {
  const arb = computeArbitrage({ yesAsk: 0.6, noAsk: 0.45, feePercent: 2 });
  assert.equal(arb.isOpportunity, false);
});

test('daysUntil returns Infinity for missing dates', () => {
  assert.equal(daysUntil(undefined), Infinity);
  assert.equal(daysUntil('not-a-date'), Infinity);
});

test('passesFilters rejects markets closing too far out', () => {
  const m = market({ endDateIso: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  assert.equal(passesFilters(m, baseCfg), false);
});

test('passesFilters rejects already-closed markets', () => {
  const m = market({ endDateIso: new Date(Date.now() - 86_400_000).toISOString() });
  assert.equal(passesFilters(m, baseCfg), false);
});

test('passesFilters rejects thin liquidity', () => {
  const m = market({ liquidity: 100 });
  assert.equal(passesFilters(m, baseCfg), false);
});

test('passesFilters rejects missing legs', () => {
  assert.equal(passesFilters(market({ yes: null }), baseCfg), false);
  assert.equal(passesFilters(market({ no: null }), baseCfg), false);
});

test('scan returns signals sorted by category priority', async () => {
  const esports = market({ id: 'e', conditionId: 'ce', question: 'CS2 major winner' });
  const crypto = market({
    id: 'c',
    conditionId: 'cc',
    slug: 'btc-100k',
    question: 'Will BTC close above $100k?',
    category: 'Crypto',
    yes: { price: 0.3, tokenId: 'y2' },
    no: { price: 0.6, tokenId: 'n2' },
  });
  const politics = market({
    id: 'p',
    conditionId: 'cp',
    slug: 'us-election',
    question: 'Will Candidate X win the presidential election?',
    category: 'Politics',
    yes: { price: 0.4, tokenId: 'y3' },
    no: { price: 0.5, tokenId: 'n3' },
  });

  const signals = await scan([crypto, politics, esports], baseCfg, Date.now(), null, silentLogger);
  assert.equal(signals.length, 3);
  assert.equal(signals[0].category, 'esports');
  assert.equal(signals[1].category, 'politics');
  assert.equal(signals[2].category, 'crypto');
});

test('scan drops opportunities below minProfitPercent', async () => {
  // yes+no = 0.97, fee 2% => threshold 0.98, profit ≈ (0.98-0.97)/0.97 ≈ 1.03%
  const m = market({ yes: { price: 0.48, tokenId: 'y' }, no: { price: 0.49, tokenId: 'n' } });
  const cfgHigh = { ...baseCfg, minProfitPercent: 10 };
  assert.equal((await scan([m], cfgHigh, Date.now(), null, silentLogger)).length, 0);
  const cfgLow = { ...baseCfg, minProfitPercent: 0.5 };
  assert.equal((await scan([m], cfgLow, Date.now(), null, silentLogger)).length, 1);
});

test('scan with fetchOrderBook emits a signal when CLOB sum clears threshold', async () => {
  // Gamma prices sum to 1.00 (no arb possible on them). CLOB asks are tighter.
  const m = market({
    yes: { price: 0.55, tokenId: 'y-clob' },
    no: { price: 0.45, tokenId: 'n-clob' },
  });
  const books = {
    'y-clob': { bestAsk: { price: 0.45, size: 100 } },
    'n-clob': { bestAsk: { price: 0.5, size: 100 } },
  };
  const fetchOrderBook = async (id) => books[id];
  const signals = await scan([m], baseCfg, Date.now(), fetchOrderBook, silentLogger);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].yesAsk, 0.45);
  assert.equal(signals[0].noAsk, 0.5);
  assert.ok(signals[0].profitPercent > 0);
});

test('scan with fetchOrderBook drops markets when CLOB sum fails threshold', async () => {
  const m = market();
  const books = {
    y1: { bestAsk: { price: 0.7, size: 100 } },
    n1: { bestAsk: { price: 0.35, size: 100 } },
  };
  const fetchOrderBook = async (id) => books[id];
  const signals = await scan([m], baseCfg, Date.now(), fetchOrderBook, silentLogger);
  assert.equal(signals.length, 0);
});

test('scan skips a market when fetchOrderBook throws and continues the loop', async () => {
  const bad = market({ id: 'bad', conditionId: 'bad', slug: 'bad', yes: { price: 0.45, tokenId: 'bad-y' }, no: { price: 0.5, tokenId: 'bad-n' } });
  const good = market({ id: 'good', conditionId: 'good', slug: 'good', yes: { price: 0.45, tokenId: 'good-y' }, no: { price: 0.5, tokenId: 'good-n' } });
  const books = {
    'good-y': { bestAsk: { price: 0.45, size: 100 } },
    'good-n': { bestAsk: { price: 0.5, size: 100 } },
  };
  const fetchOrderBook = async (id) => {
    if (id.startsWith('bad')) throw new Error('boom');
    return books[id];
  };
  const signals = await scan([bad, good], baseCfg, Date.now(), fetchOrderBook, silentLogger);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].market.id, 'good');
});

test('scan falls back to Gamma prices when fetchOrderBook is not provided', async () => {
  const m = market();
  const signals = await scan([m], baseCfg, Date.now(), null, silentLogger);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].yesAsk, 0.45);
  assert.equal(signals[0].noAsk, 0.5);
});

test('scan with fetchOrderBook skips market when CLOB has no asks', async () => {
  const m = market();
  const fetchOrderBook = async () => ({ bestAsk: null });
  const signals = await scan([m], baseCfg, Date.now(), fetchOrderBook, silentLogger);
  assert.equal(signals.length, 0);
});
