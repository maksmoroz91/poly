import { categorize, priorityOf } from './categorize.js';
import { logger as defaultLogger } from './logger.js';

// Gamma's outcomePrices are YES/NO probabilities that sum to $1.00 by
// definition, so arbitrage math on them can never flag a signal. The real
// spread lives in the CLOB order book — so when a fetchOrderBook fn is
// supplied the scanner pulls the top-of-book ask for each candidate and runs
// the arb math on real prices. Without it we fall back to Gamma prices purely
// for backwards compatibility (existing callers / tests).

// Soft warning cap: more candidates than this in a single cycle means the
// filters are too loose and the bot risks hammering CLOB /book.
const CLOB_WARN_THRESHOLD = 500;

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

export async function scan(markets, cfg, now = Date.now(), fetchOrderBook = null, log = defaultLogger) {
  const candidates = [];
  for (const market of markets) {
    if (!passesFilters(market, cfg, now)) continue;
    candidates.push(market);
  }

  log?.info?.(`scanner: ${candidates.length}/${markets.length} markets passed filters`);
  if (fetchOrderBook && candidates.length > CLOB_WARN_THRESHOLD) {
    log?.warn?.(
      `scanner: ${candidates.length} candidates exceeds CLOB warn threshold ${CLOB_WARN_THRESHOLD}; tighten filters to avoid rate limits`,
    );
  }

  const signals = [];
  let clobChecked = 0;
  let clobErrors = 0;

  for (const market of candidates) {
    let yesAsk = market.yes.price;
    let noAsk = market.no.price;

    if (fetchOrderBook) {
      try {
        const [yesBook, noBook] = await Promise.all([
          fetchOrderBook(market.yes.tokenId),
          fetchOrderBook(market.no.tokenId),
        ]);
        const yesLevel = yesBook?.bestAsk;
        const noLevel = noBook?.bestAsk;
        if (!isFiniteAsk(yesLevel?.price) || !isFiniteAsk(noLevel?.price)) {
          // No real ask on one side means no tradeable arb; skip quietly.
          continue;
        }
        yesAsk = yesLevel.price;
        noAsk = noLevel.price;
        clobChecked += 1;
      } catch (err) {
        clobErrors += 1;
        log?.warn?.(
          `scanner: CLOB book fetch failed for ${market.slug || market.id}: ${err?.message || err}`,
        );
        continue;
      }
    }

    const arb = computeArbitrage({
      yesAsk,
      noAsk,
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
      yesAsk,
      noAsk,
      ...arb,
    });
  }

  if (fetchOrderBook) {
    log?.info?.(
      `scanner: CLOB-checked ${clobChecked}/${candidates.length} candidates (${clobErrors} errors)`,
    );
  }

  // Highest priority first (esports), then best profit.
  signals.sort((a, b) => a.priority - b.priority || b.profitPercent - a.profitPercent);
  return signals;
}
