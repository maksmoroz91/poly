// Parallel YES+NO order executor with rollback.
//
// Polymarket settles via CLOB; posting real orders requires signing EIP-712
// payloads with the wallet's private key via @polymarket/clob-client. That
// dependency is optional — this module accepts an injected `orderPlacer` so
// the bot can run in `monitor` mode without any chain libraries installed,
// and unit tests can exercise the rollback logic with an in-memory fake.

// Cancel-failure reasons that mean a leg actually executed and the operator
// is now naked on one side. These need a separate, louder alert path than
// generic network errors.
const ALREADY_FILLED_PATTERNS = [
  /already[\s_-]*filled/i,
  /already[\s_-]*matched/i,
  /already[\s_-]*executed/i,
  /not[\s_-]*cancellable/i,
  /cannot[\s_-]*cancel/i,
  /order[\s_-]*(is[\s_-]*)?(complete|completed|done)/i,
];

function isAlreadyFilledError(err) {
  if (!err) return false;
  if (err.alreadyFilled === true) return true;
  if (typeof err.code === 'string' && /filled|matched/i.test(err.code)) return true;
  const msg = err.message || String(err);
  return ALREADY_FILLED_PATTERNS.some((re) => re.test(msg));
}

export class ParallelExecutor {
  /**
   * @param {object} opts
   * @param {(args: {tokenId: string, size: number, price: number, side: 'BUY'|'SELL'}) => Promise<{id: string}>} opts.placeOrder
   * @param {(orderId: string) => Promise<void>} opts.cancelOrder
   * @param {(tokenId: string) => Promise<{bestAsk: {price:number,size:number}|null}>} [opts.fetchOrderBook]
   *   Called in auto mode to verify the real top-of-book ask before firing.
   * @param {number} [opts.feePercent]   Fee % used in the threshold check.
   * @param {number} [opts.minProfitPercent] Minimum profit % required after re-check.
   * @param {(alert: {kind: string, message: string, context?: object}) => void} [opts.onCriticalAlert]
   *   Invoked when a leg appears to be filled but cancellation failed (manual reconciliation needed).
   * @param {object} [opts.logger]
   */
  constructor({
    placeOrder,
    cancelOrder,
    fetchOrderBook,
    feePercent = 0,
    minProfitPercent = 0,
    onCriticalAlert,
    logger = console,
  }) {
    if (typeof placeOrder !== 'function' || typeof cancelOrder !== 'function') {
      throw new Error('ParallelExecutor requires placeOrder and cancelOrder functions');
    }
    this.placeOrder = placeOrder;
    this.cancelOrder = cancelOrder;
    this.fetchOrderBook = fetchOrderBook;
    this.feePercent = feePercent;
    this.minProfitPercent = minProfitPercent;
    this.onCriticalAlert = onCriticalAlert;
    this.logger = logger;
  }

  /**
   * Buy YES and NO of the same market in parallel, for an equal notional
   * capped at maxBetUsdc. If either order fails we attempt to cancel the
   * other; cancellation failures are classified as either a benign network
   * miss or — critically — an already-filled order that needs operator
   * intervention.
   */
  async executeArbitrage({ market, maxBetUsdc }) {
    const yes = market.yes;
    const no = market.no;
    if (!yes?.tokenId || !no?.tokenId) {
      throw new Error('Market is missing CLOB token ids for YES/NO');
    }

    let yesPrice = yes.price;
    let noPrice = no.price;

    // Fix #1 from issue: outcomePrices is a mid/last quote on Gamma. Before
    // committing capital we pull the real top-of-book ask from the CLOB and
    // re-validate the arb. If the real spread is gone we abort cleanly.
    if (this.fetchOrderBook) {
      const recheck = await this.recheckTopOfBook({ yes, no, maxBetUsdc });
      if (!recheck.ok) return recheck;
      yesPrice = recheck.yesAsk;
      noPrice = recheck.noAsk;
    }

    const sum = yesPrice + noPrice;
    if (!(sum > 0 && sum < 1)) {
      throw new Error(`Arbitrage preconditions not met; sum=${sum}`);
    }

    // Split capital proportionally so the YES and NO share settles to the
    // same number of pair-tokens ($1 payoff each) at maxBetUsdc total.
    const pairs = maxBetUsdc / sum;
    const yesSize = pairs;
    const noSize = pairs;

    const results = await Promise.allSettled([
      this.placeOrder({ tokenId: yes.tokenId, size: yesSize, price: yesPrice, side: 'BUY' }),
      this.placeOrder({ tokenId: no.tokenId, size: noSize, price: noPrice, side: 'BUY' }),
    ]);

    const [yesRes, noRes] = results;

    if (yesRes.status === 'fulfilled' && noRes.status === 'fulfilled') {
      return {
        ok: true,
        yesOrderId: yesRes.value.id,
        noOrderId: noRes.value.id,
        pairs,
        yesPrice,
        noPrice,
      };
    }

    // One leg failed — roll back the other so we don't end up naked on a side.
    const rollback = [];
    if (yesRes.status === 'fulfilled') {
      rollback.push(this.safeCancel(yesRes.value.id, 'YES', { market }));
    }
    if (noRes.status === 'fulfilled') {
      rollback.push(this.safeCancel(noRes.value.id, 'NO', { market }));
    }
    const rollbackResults = await Promise.all(rollback);
    const naked = rollbackResults.filter((r) => r.alreadyFilled);

    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message || String(r.reason));

    return { ok: false, errors, naked };
  }

  async recheckTopOfBook({ yes, no, maxBetUsdc }) {
    const [yesBook, noBook] = await Promise.all([
      this.fetchOrderBook(yes.tokenId),
      this.fetchOrderBook(no.tokenId),
    ]);
    const yesAskLevel = yesBook?.bestAsk;
    const noAskLevel = noBook?.bestAsk;
    if (!yesAskLevel || !noAskLevel) {
      return { ok: false, errors: ['real top-of-book ask unavailable'], aborted: 'no_ask' };
    }
    const yesAsk = yesAskLevel.price;
    const noAsk = noAskLevel.price;
    const sum = yesAsk + noAsk;
    const fee = this.feePercent / 100;
    const profitPercent = sum > 0 ? ((1 - fee - sum) / sum) * 100 : -100;
    if (profitPercent < this.minProfitPercent) {
      this.logger.warn?.(
        `[executor] real-ask re-check killed arb: yesAsk=${yesAsk} noAsk=${noAsk} sum=${sum.toFixed(4)} profit%=${profitPercent.toFixed(2)} (min ${this.minProfitPercent})`,
      );
      return {
        ok: false,
        aborted: 'real_ask_too_high',
        yesAsk,
        noAsk,
        sum,
        profitPercent,
        errors: [`real ask sum ${sum.toFixed(4)} fails minProfitPercent ${this.minProfitPercent}`],
      };
    }
    // Make sure the book has enough size to fill what we want to spend.
    const pairs = maxBetUsdc / sum;
    if (yesAskLevel.size < pairs || noAskLevel.size < pairs) {
      this.logger.warn?.(
        `[executor] insufficient ask size: need ${pairs.toFixed(2)} pairs, yes=${yesAskLevel.size} no=${noAskLevel.size}`,
      );
      return {
        ok: false,
        aborted: 'insufficient_size',
        yesAsk,
        noAsk,
        errors: [`insufficient ask size for ${pairs.toFixed(2)} pairs`],
      };
    }
    return { ok: true, yesAsk, noAsk, profitPercent };
  }

  async safeCancel(orderId, label, { market } = {}) {
    try {
      await this.cancelOrder(orderId);
      this.logger.warn?.(`[executor] rolled back ${label} order ${orderId}`);
      return { ok: true, orderId, label };
    } catch (err) {
      const alreadyFilled = isAlreadyFilledError(err);
      const msg = err?.message || String(err);
      if (alreadyFilled) {
        // Naked leg — operator MUST intervene.
        this.logger.error?.(
          `[executor] CRITICAL: ${label} order ${orderId} already filled; manual reconciliation required: ${msg}`,
        );
        this.onCriticalAlert?.({
          kind: 'naked_leg',
          message: `Naked ${label} position: order ${orderId} filled but counter-leg failed. Reconcile immediately.`,
          context: { orderId, leg: label, marketId: market?.id, slug: market?.slug, error: msg },
        });
      } else {
        this.logger.error?.(
          `[executor] failed to cancel ${label} order ${orderId}: ${msg}`,
        );
      }
      return { ok: false, orderId, label, alreadyFilled, error: msg };
    }
  }
}

// Placeholder order placer used when auto mode is enabled but the CLOB client
// isn't installed. It errors loudly so operators know to install the optional
// dependency before real trading.
export function makeUnavailableOrderPlacer() {
  return {
    placeOrder: async () => {
      throw new Error(
        'Order placement is not configured. Install @polymarket/clob-client and wire it in, or run with BOT_MODE=monitor.',
      );
    },
    cancelOrder: async () => {
      throw new Error('Order cancellation is not configured.');
    },
  };
}

export { isAlreadyFilledError };
