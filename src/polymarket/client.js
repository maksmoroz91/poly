// Client for the public Polymarket Gamma API.
// Docs: https://docs.polymarket.com — Gamma returns market metadata and
// top-of-book prices suitable for a cheap periodic scan.

export class PolymarketClient {
  constructor({ gammaUrl = 'https://gamma-api.polymarket.com', fetchImpl = globalThis.fetch } = {}) {
    if (!fetchImpl) {
      throw new Error('fetch is not available; pass fetchImpl or run on Node >= 18');
    }
    this.gammaUrl = gammaUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async fetchActiveMarkets({ limit = 500, offset = 0 } = {}) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      archived: 'false',
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${this.gammaUrl}/markets?${params.toString()}`;
    const res = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Gamma /markets failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data.map(normalizeMarket) : [];
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
