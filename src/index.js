#!/usr/bin/env node
import { loadConfig } from './config.js';
import { PolymarketClient } from './polymarket/client.js';
import { scan } from './scanner.js';
import { TelegramNotifier, formatSignal } from './telegram.js';
import { ParallelExecutor, makeUnavailableOrderPlacer } from './executor.js';
import { logger } from './logger.js';

async function runOnce({ client, cfg, telegram, executor, seen }) {
  const markets = await client.fetchActiveMarkets();
  logger.info(`fetched ${markets.length} markets`);

  const signals = scan(markets, cfg);
  logger.info(`found ${signals.length} arbitrage signals`);

  for (const signal of signals) {
    const key = signal.market.conditionId || signal.market.id;
    if (seen.has(key)) continue;
    seen.add(key);

    const msg = formatSignal(signal);
    logger.info('signal', {
      q: signal.market.question,
      category: signal.category,
      profitPercent: signal.profitPercent,
      sum: signal.sum,
    });

    if (telegram.enabled) {
      try {
        await telegram.send(msg);
      } catch (err) {
        logger.error('telegram send failed', err?.message || err);
      }
    }

    if (cfg.mode === 'auto' && executor) {
      try {
        const result = await executor.executeArbitrage({
          market: signal.market,
          maxBetUsdc: cfg.maxBetUsdc,
        });
        if (result.ok) {
          logger.info('executed pair', result);
          if (telegram.enabled) {
            await telegram.send(
              `✅ Executed pair for <code>${signal.market.slug || signal.market.id}</code>\nYES order: ${result.yesOrderId}\nNO order: ${result.noOrderId}`,
            ).catch(() => {});
          }
        } else {
          logger.error('execution failed, rolled back', result.errors);
          if (telegram.enabled) {
            await telegram.send(
              `❌ Execution failed for <code>${signal.market.slug || signal.market.id}</code>:\n${(result.errors || []).join('\n')}`,
            ).catch(() => {});
          }
        }
      } catch (err) {
        logger.error('executor threw', err?.message || err);
      }
    }
  }
}

async function main() {
  const cfg = loadConfig();
  logger.info('config', {
    mode: cfg.mode,
    minProfitPercent: cfg.minProfitPercent,
    maxBetUsdc: cfg.maxBetUsdc,
    daysToClose: cfg.daysToClose,
    scanIntervalSec: cfg.scanIntervalSec,
    minLiquidityUsdc: cfg.minLiquidityUsdc,
    minVolume24hUsdc: cfg.minVolume24hUsdc,
    feePercent: cfg.feePercent,
    telegram: cfg.telegram.botToken ? 'enabled' : 'disabled',
  });

  const client = new PolymarketClient({ gammaUrl: cfg.polymarket.gammaUrl });
  const telegram = new TelegramNotifier({
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
    logger,
  });

  let executor = null;
  if (cfg.mode === 'auto') {
    const placer = makeUnavailableOrderPlacer();
    executor = new ParallelExecutor({
      placeOrder: placer.placeOrder,
      cancelOrder: placer.cancelOrder,
      logger,
    });
    logger.warn('auto mode: using placeholder order placer. Install @polymarket/clob-client and wire it in src/index.js before trading real funds.');
  }

  const seen = new Set();
  let stopping = false;
  const shutdown = (sig) => {
    logger.info(`received ${sig}, stopping...`);
    stopping = true;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!stopping) {
    try {
      await runOnce({ client, cfg, telegram, executor, seen });
    } catch (err) {
      logger.error('scan cycle failed', err?.message || err);
    }
    await sleep(cfg.scanIntervalSec * 1000, () => stopping);
    // Prune seen set periodically so a resolved-then-reopened market isn't
    // muted forever (defensive: the bot is meant to run for short bursts).
    if (seen.size > 10_000) seen.clear();
  }
}

function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const step = 100;
    let elapsed = 0;
    const iv = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || shouldStop?.()) {
        clearInterval(iv);
        resolve();
      }
    }, step);
  });
}

main().catch((err) => {
  logger.error('fatal', err?.stack || err);
  process.exit(1);
});
