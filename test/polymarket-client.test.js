import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketClient, normalizeMarket, parseOrderBook } from '../src/polymarket/client.js';

test('normalizeMarket parses JSON-encoded outcome arrays', () => {
  const raw = {
    id: '1',
    conditionId: '0xabc',
    slug: 'market-x',
    question: 'Will X happen?',
    category: 'Sports',
    endDateIso: '2026-05-01T00:00:00Z',
    liquidityNum: '10000',
    volume24hr: '500',
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.45","0.50"]',
    clobTokenIds: '["tok-yes","tok-no"]',
  };
  const m = normalizeMarket(raw);
  assert.equal(m.yes.price, 0.45);
  assert.equal(m.no.price, 0.5);
  assert.equal(m.yes.tokenId, 'tok-yes');
  assert.equal(m.no.tokenId, 'tok-no');
  assert.equal(m.liquidity, 10000);
  assert.equal(m.volume24h, 500);
});

test('normalizeMarket handles missing outcomes gracefully', () => {
  const m = normalizeMarket({ id: '2' });
  assert.equal(m.yes, null);
  assert.equal(m.no, null);
  assert.equal(m.liquidity, 0);
  assert.equal(m.volume24h, 0);
});

test('normalizeMarket tolerates already-decoded arrays', () => {
  const m = normalizeMarket({
    id: '3',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.4', '0.55'],
    clobTokenIds: ['y', 'n'],
  });
  assert.equal(m.yes.price, 0.4);
  assert.equal(m.no.price, 0.55);
});

test('PolymarketClient fetches and normalizes markets', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes('/markets?'));
    assert.ok(url.includes('active=true'));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return [
          {
            id: '1',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.4","0.55"]',
            clobTokenIds: '["y","n"]',
          },
        ];
      },
    };
  };
  const client = new PolymarketClient({ fetchImpl });
  const markets = await client.fetchActiveMarkets();
  assert.equal(markets.length, 1);
  assert.equal(markets[0].yes.price, 0.4);
});

test('PolymarketClient pages through markets until a short page', async () => {
  const calls = [];
  let call = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    call += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        // Return 2 full pages of size 2, then a final short page with 1 row.
        if (call === 1) return [{ id: 'a' }, { id: 'b' }];
        if (call === 2) return [{ id: 'c' }, { id: 'd' }];
        return [{ id: 'e' }];
      },
    };
  };
  const client = new PolymarketClient({ fetchImpl });
  const markets = await client.fetchActiveMarkets({ pageSize: 2 });
  assert.equal(markets.length, 5);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes('offset=0'));
  assert.ok(calls[1].includes('offset=2'));
  assert.ok(calls[2].includes('offset=4'));
});

test('PolymarketClient retries on 429 and eventually succeeds', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call < 3) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        async text() { return 'rate limited'; },
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() { return []; },
    };
  };
  const client = new PolymarketClient({
    fetchImpl,
    retryOptions: { retries: 5, baseMs: 1, maxMs: 5, jitter: 0 },
  });
  const markets = await client.fetchActiveMarkets({ pageSize: 10 });
  assert.equal(markets.length, 0);
  assert.equal(call, 3);
});

test('PolymarketClient.fetchOrderBook returns sorted top-of-book', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes('/book?token_id=tok-1'));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return {
          asks: [
            { price: '0.55', size: '50' },
            { price: '0.50', size: '100' },
            { price: '0.60', size: '20' },
          ],
          bids: [
            { price: '0.40', size: '70' },
            { price: '0.45', size: '30' },
          ],
        };
      },
    };
  };
  const client = new PolymarketClient({ fetchImpl });
  const book = await client.fetchOrderBook('tok-1');
  assert.equal(book.bestAsk.price, 0.5);
  assert.equal(book.bestAsk.size, 100);
  assert.equal(book.bestBid.price, 0.45);
});

test('parseOrderBook tolerates empty / malformed input', () => {
  const empty = parseOrderBook(null);
  assert.equal(empty.bestAsk, null);
  assert.equal(empty.bestBid, null);
  const partial = parseOrderBook({ asks: [{ price: 'NaN', size: 5 }, { price: 0.7, size: 1 }] });
  assert.equal(partial.bestAsk.price, 0.7);
});

test('PolymarketClient throws on non-2xx', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    async text() { return ''; },
  });
  const client = new PolymarketClient({ fetchImpl, retryOptions: { retries: 0 } });
  await assert.rejects(() => client.fetchActiveMarkets(), /502/);
});
