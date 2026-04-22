import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelExecutor, isAlreadyFilledError } from '../src/executor.js';

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

function makeMarket(overrides = {}) {
  return {
    id: 'm1',
    slug: 'some-market',
    yes: { price: 0.45, tokenId: 'yes-token' },
    no: { price: 0.5, tokenId: 'no-token' },
    ...overrides,
  };
}

test('executes both legs in parallel and returns ids', async () => {
  const calls = [];
  const executor = new ParallelExecutor({
    placeOrder: async (args) => {
      calls.push(args);
      return { id: `o-${args.tokenId}` };
    },
    cancelOrder: async () => {},
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.yesOrderId, 'o-yes-token');
  assert.equal(result.noOrderId, 'o-no-token');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].side, 'BUY');
  assert.equal(calls[1].side, 'BUY');
  assert.ok(calls[0].size > 0);
});

test('rolls back the surviving leg when the other fails', async () => {
  const cancelled = [];
  const executor = new ParallelExecutor({
    placeOrder: async ({ tokenId }) => {
      if (tokenId === 'no-token') throw new Error('book empty');
      return { id: 'yes-order-1' };
    },
    cancelOrder: async (id) => {
      cancelled.push(id);
    },
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.deepEqual(cancelled, ['yes-order-1']);
  assert.ok(result.errors[0].includes('book empty'));
});

test('swallows cancellation failures but still reports the primary error', async () => {
  const executor = new ParallelExecutor({
    placeOrder: async ({ tokenId }) => {
      if (tokenId === 'yes-token') throw new Error('yes rejected');
      return { id: 'no-order-1' };
    },
    cancelOrder: async () => {
      throw new Error('cancel failed');
    },
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes('yes rejected'));
});

test('refuses when preconditions are not met', async () => {
  const executor = new ParallelExecutor({
    placeOrder: async () => ({ id: 'x' }),
    cancelOrder: async () => {},
    logger: silentLogger,
  });

  await assert.rejects(
    () => executor.executeArbitrage({ market: makeMarket({ yes: { price: 0.6, tokenId: 'y' }, no: { price: 0.6, tokenId: 'n' } }), maxBetUsdc: 10 }),
    /preconditions/,
  );
});

test('refuses when token ids are missing', async () => {
  const executor = new ParallelExecutor({
    placeOrder: async () => ({ id: 'x' }),
    cancelOrder: async () => {},
    logger: silentLogger,
  });

  await assert.rejects(
    () => executor.executeArbitrage({
      market: { yes: { price: 0.4 }, no: { price: 0.5, tokenId: 'n' } },
      maxBetUsdc: 10,
    }),
    /token ids/,
  );
});

test('isAlreadyFilledError detects common phrasings', () => {
  assert.equal(isAlreadyFilledError(new Error('Order is already filled')), true);
  assert.equal(isAlreadyFilledError(new Error('order already_matched on-chain')), true);
  assert.equal(isAlreadyFilledError(new Error('order is complete')), true);
  assert.equal(isAlreadyFilledError(new Error('Cannot cancel: not cancellable')), true);
  assert.equal(isAlreadyFilledError(new Error('connection refused')), false);
  const tagged = new Error('whatever');
  tagged.alreadyFilled = true;
  assert.equal(isAlreadyFilledError(tagged), true);
});

test('critical alert fires when cancel fails because leg is already filled', async () => {
  const alerts = [];
  const executor = new ParallelExecutor({
    placeOrder: async ({ tokenId }) => {
      if (tokenId === 'no-token') throw new Error('no leg rejected');
      return { id: 'yes-order-1' };
    },
    cancelOrder: async () => {
      throw new Error('Order is already filled');
    },
    onCriticalAlert: (a) => alerts.push(a),
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'naked_leg');
  assert.match(alerts[0].message, /Naked YES position/);
  assert.equal(result.naked.length, 1);
  assert.equal(result.naked[0].label, 'YES');
  assert.equal(result.naked[0].alreadyFilled, true);
});

test('critical alert does NOT fire when cancel fails for transient network reasons', async () => {
  const alerts = [];
  const executor = new ParallelExecutor({
    placeOrder: async ({ tokenId }) => {
      if (tokenId === 'no-token') throw new Error('no leg rejected');
      return { id: 'yes-order-1' };
    },
    cancelOrder: async () => {
      throw new Error('connection refused');
    },
    onCriticalAlert: (a) => alerts.push(a),
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.equal(alerts.length, 0);
  assert.equal(result.naked.length, 0);
});

test('aborts when real top-of-book ask kills the arb', async () => {
  const placed = [];
  const executor = new ParallelExecutor({
    placeOrder: async (a) => { placed.push(a); return { id: 'x' }; },
    cancelOrder: async () => {},
    fetchOrderBook: async (tokenId) => {
      // Real asks much higher than mid-quote: arb is gone.
      const price = tokenId === 'yes-token' ? 0.55 : 0.55;
      return { bestAsk: { price, size: 1000 }, bestBid: null };
    },
    feePercent: 2,
    minProfitPercent: 3,
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'real_ask_too_high');
  assert.equal(placed.length, 0);
});

test('aborts when real top-of-book has insufficient size', async () => {
  const placed = [];
  const executor = new ParallelExecutor({
    placeOrder: async (a) => { placed.push(a); return { id: 'x' }; },
    cancelOrder: async () => {},
    fetchOrderBook: async () => ({
      bestAsk: { price: 0.45, size: 0.1 }, // not enough size
      bestBid: null,
    }),
    feePercent: 2,
    minProfitPercent: 1,
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'insufficient_size');
  assert.equal(placed.length, 0);
});

test('proceeds and uses real ask when book confirms arb', async () => {
  const placed = [];
  const executor = new ParallelExecutor({
    placeOrder: async (a) => { placed.push(a); return { id: `o-${a.tokenId}` }; },
    cancelOrder: async () => {},
    fetchOrderBook: async (tokenId) => ({
      bestAsk: { price: tokenId === 'yes-token' ? 0.46 : 0.51, size: 1000 },
      bestBid: null,
    }),
    feePercent: 2,
    minProfitPercent: 0.5,
    logger: silentLogger,
  });

  const result = await executor.executeArbitrage({ market: makeMarket(), maxBetUsdc: 10 });
  assert.equal(result.ok, true);
  // Order was placed at the real ask, not the stale Gamma quote.
  const yesOrder = placed.find((p) => p.tokenId === 'yes-token');
  assert.equal(yesOrder.price, 0.46);
});
