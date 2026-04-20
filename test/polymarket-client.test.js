import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketClient, normalizeMarket } from '../src/polymarket/client.js';

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

test('PolymarketClient throws on non-2xx', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' });
  const client = new PolymarketClient({ fetchImpl });
  await assert.rejects(() => client.fetchActiveMarkets(), /502/);
});
