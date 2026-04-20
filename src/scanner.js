import { categorize, priorityOf } from './categorize.js';

// A market is "ready" when both YES and NO have sensible top-of-book asks.
// Gamma's outcomePrices field is a midpoint/last trade on many rows, so in
// auto mode the executor re-checks the real ask from the order book before
// firing a trade. The scanner uses the cheaper Gamma snapshot for filtering.

export function daysUntil(endDateIso, now = Date.now()) {
  if (!endDateIso) return Infinity;
  const end = new Date(endDateIso).getTime();
  if (!Number.isFinite(end)) return Infinity;
  return (end - now) / (1000 * 60 * 60 * 24);
}

export function computeArbitrage({ yesAsk, noAsk, feePercent }) {
  const sum = yesAsk + noAsk;
  const fee = feePercent / 100;
  const threshold = 1 - fee;
  const grossProfit = 1 - sum;
  // Profit as percent of capital deployed (sum per $1 payoff pair).
  const profitPercent = sum > 0 ? ((1 - fee - sum) / sum) * 100 : 0;
  return {
    sum,
    threshold,
    grossProfit,
    profitPercent,
    isOpportunity: sum < threshold,
  };
}

export function passesFilters(market, cfg, now = Date.now()) {
  if (!market?.yes || !market?.no) return false;
  if (!isFiniteAsk(market.yes.price) || !isFiniteAsk(market.no.price)) return false;
  if (market.liquidity < cfg.minLiquidityUsdc) return false;
  if (market.volume24h < cfg.minVolume24hUsdc) return false;
  const days = daysUntil(market.endDateIso, now);
  if (days < 0 || days > cfg.daysToClose) return false;
  return true;
}

function isFiniteAsk(p) {
  return Number.isFinite(p) && p > 0 && p < 1;
}

export function scan(markets, cfg, now = Date.now()) {
  const signals = [];
  for (const market of markets) {
    if (!passesFilters(market, cfg, now)) continue;
    const arb = computeArbitrage({
      yesAsk: market.yes.price,
      noAsk: market.no.price,
      feePercent: cfg.feePercent,
    });
    if (!arb.isOpportunity) continue;
    if (arb.profitPercent < cfg.minProfitPercent) continue;
    const category = categorize(market);
    signals.push({
      market,
      category,
      priority: priorityOf(category),
      daysToClose: daysUntil(market.endDateIso, now),
      ...arb,
    });
  }
  // Highest priority first (esports), then best profit.
  signals.sort((a, b) => a.priority - b.priority || b.profitPercent - a.profitPercent);
  return signals;
}
