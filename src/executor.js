// Parallel YES+NO order executor with rollback.
//
// Polymarket settles via CLOB; posting real orders requires signing EIP-712
// payloads with the wallet's private key via @polymarket/clob-client. That
// dependency is optional — this module accepts an injected `orderPlacer` so
// the bot can run in `monitor` mode without any chain libraries installed,
// and unit tests can exercise the rollback logic with an in-memory fake.

export class ParallelExecutor {
  /**
   * @param {object} opts
   * @param {(args: {tokenId: string, size: number, price: number, side: 'BUY'|'SELL'}) => Promise<{id: string}>} opts.placeOrder
   * @param {(orderId: string) => Promise<void>} opts.cancelOrder
   * @param {object} [opts.logger]
   */
  constructor({ placeOrder, cancelOrder, logger = console }) {
    if (typeof placeOrder !== 'function' || typeof cancelOrder !== 'function') {
      throw new Error('ParallelExecutor requires placeOrder and cancelOrder functions');
    }
    this.placeOrder = placeOrder;
    this.cancelOrder = cancelOrder;
    this.logger = logger;
  }

  /**
   * Buy YES and NO of the same market in parallel, for an equal notional
   * capped at maxBetUsdc. If either order fails we attempt to cancel the
   * other; any cancellation error is logged but not rethrown so the caller
   * still sees the original failure.
   */
  async executeArbitrage({ market, maxBetUsdc }) {
    const yes = market.yes;
    const no = market.no;
    if (!yes?.tokenId || !no?.tokenId) {
      throw new Error('Market is missing CLOB token ids for YES/NO');
    }

    const sum = yes.price + no.price;
    if (!(sum > 0 && sum < 1)) {
      throw new Error(`Arbitrage preconditions not met; sum=${sum}`);
    }

    // Split capital proportionally so the YES and NO share settles to the
    // same number of pair-tokens ($1 payoff each) at maxBetUsdc total.
    const pairs = maxBetUsdc / sum;
    const yesSize = pairs;
    const noSize = pairs;

    const results = await Promise.allSettled([
      this.placeOrder({ tokenId: yes.tokenId, size: yesSize, price: yes.price, side: 'BUY' }),
      this.placeOrder({ tokenId: no.tokenId, size: noSize, price: no.price, side: 'BUY' }),
    ]);

    const [yesRes, noRes] = results;

    if (yesRes.status === 'fulfilled' && noRes.status === 'fulfilled') {
      return {
        ok: true,
        yesOrderId: yesRes.value.id,
        noOrderId: noRes.value.id,
        pairs,
      };
    }

    // One leg failed — roll back the other so we don't end up naked on a side.
    const rollback = [];
    if (yesRes.status === 'fulfilled') {
      rollback.push(
        this.safeCancel(yesRes.value.id, 'YES'),
      );
    }
    if (noRes.status === 'fulfilled') {
      rollback.push(
        this.safeCancel(noRes.value.id, 'NO'),
      );
    }
    await Promise.all(rollback);

    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message || String(r.reason));
    return { ok: false, errors };
  }

  async safeCancel(orderId, label) {
    try {
      await this.cancelOrder(orderId);
      this.logger.warn?.(`[executor] rolled back ${label} order ${orderId}`);
    } catch (err) {
      this.logger.error?.(`[executor] failed to cancel ${label} order ${orderId}: ${err?.message || err}`);
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
