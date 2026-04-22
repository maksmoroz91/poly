// Client for the public Polymarket Gamma + CLOB APIs.
// Docs: https://docs.polymarket.com — Gamma returns market metadata and
// outcomePrices (mid/last); CLOB exposes the real top-of-book.

import { retry, HttpError } from '../retry.js';

export class PolymarketClient {
  constructor({
    gammaUrl = 'https://gamma-api.polymarket.com',
    clobUrl = 'https://clob.polymarket.com',
    fetchImpl = globalThis.fetch,
    retryOptions,
    logger,
  } = {}) {
    if (!fetchImpl) {
      throw new Error('fetch is not available; pass fetchImpl or run on Node >= 18');
    }
    this.gammaUrl = gammaUrl.replace(/\/$/, '');
    this.clobUrl = clobUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.retryOptions = retryOptions;
    this.logger = logger;
  }

  // Pages through `/markets` until the API returns fewer than `pageSize`
  // records, so the scanner sees every active market (Gamma caps each page
  // at a few hundred rows). `maxPages` is a safety cap.
  async fetchActiveMarkets({ pageSize = 500, maxPages = 20 } = {}) {
    const all = [];
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const batch = await this.#fetchMarketsPage({ limit: pageSize, offset });
      all.push(...batch);
      if (batch.length < pageSize) break;
    }
    return all;
  }

  async #fetchMarketsPage({ limit, offset }) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      archived: 'false',
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${this.gammaUrl}/markets?${params.toString()}`;
    const data = await this.#getJson(url, 'Gamma /markets');
    return Array.isArray(data) ? data.map(normalizeMarket) : [];
  }

  // Real top-of-book ask/bid for a CLOB token. `outcomePrices` from Gamma is
  // a mid/last-trade and overstates how much fills are actually available.
  async fetchOrderBook(tokenId) {
    if (!tokenId) throw new Error('fetchOrderBook requires tokenId');
    const url = `${this.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const raw = await this.#getJson(url, 'CLOB /book');
    return parseOrderBook(raw);
  }

  async #getJson(url, label) {
    return retry(
      async () => {
        const res = await this.fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          const body = await safeText(res);
          throw new HttpError(`${label} failed: ${res.status} ${res.statusText}`, {
            status: res.status,
            body,
          });
        }
        return res.json();
      },
      {
        ...this.retryOptions,
        onRetry: (err, attempt, delay) => {
          this.logger?.warn?.(`[polymarket] retrying ${label} (attempt ${attempt}, in ${delay}ms): ${err?.message || err}`);
        },
      },
    );
  }
}

// Gamma returns outcomes, outcomePrices, clobTokenIds as JSON-encoded strings.
// Parse them defensively and surface a flat shape the scanner can use.
export function normalizeMarket(raw) {
  const outcomes = parseJsonArray(raw.outcomes);
  const prices = parseJsonArray(raw.outcomePrices).map((p) => Number(p));
  const tokenIds = parseJsonArray(raw.clobTokenIds);

  const yesIndex = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const noIndex = outcomes.findIndex((o) => String(o).toLowerCase() === 'no');

  return {
    id: raw.id,
    conditionId: raw.conditionId,
    slug: raw.slug,
    question: raw.question,
    category: raw.category,
    endDateIso: raw.endDateIso || raw.endDate,
    liquidity: toNumber(raw.liquidityNum ?? raw.liquidity),
    volume24h: toNumber(raw.volume24hr ?? raw.volume24Hr ?? raw.volume_24hr),
    outcomes,
    yes: yesIndex === -1 ? null : {
      price: prices[yesIndex],
      tokenId: tokenIds[yesIndex],
    },
    no: noIndex === -1 ? null : {
      price: prices[noIndex],
      tokenId: tokenIds[noIndex],
    },
    raw,
  };
}

// CLOB /book returns { asks: [{price, size}], bids: [{price, size}] }.
// Asks are returned sorted ascending by price; the lowest is the top-of-book.
export function parseOrderBook(raw) {
  const asks = normalizeLevels(raw?.asks).sort((a, b) => a.price - b.price);
  const bids = normalizeLevels(raw?.bids).sort((a, b) => b.price - a.price);
  return {
    asks,
    bids,
    bestAsk: asks[0] || null,
    bestBid: bids[0] || null,
  };
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const lvl of levels) {
    if (!lvl) continue;
    const price = Number(lvl.price ?? lvl[0]);
    const size = Number(lvl.size ?? lvl.amount ?? lvl[1]);
    if (Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0) {
      out.push({ price, size });
    }
  }
  return out;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
