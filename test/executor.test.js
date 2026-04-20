import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelExecutor } from '../src/executor.js';

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

function makeMarket(overrides = {}) {
  return {
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
