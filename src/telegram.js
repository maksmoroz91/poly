import { retry, HttpError } from './retry.js';

export class TelegramNotifier {
  constructor({
    botToken,
    chatId,
    fetchImpl = globalThis.fetch,
    logger = console,
    retryOptions,
    sendTimeoutMs = 8000,
  } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.retryOptions = retryOptions;
    this.sendTimeoutMs = sendTimeoutMs;
    this.queue = new TelegramQueue({ logger });
  }

  get enabled() {
    return Boolean(this.botToken && this.chatId);
  }

  async send(text) {
    if (!this.enabled) {
      this.logger.warn?.('[telegram] disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
      return { skipped: true };
    }
    return retry(
      () => this.#sendOnce(text),
      {
        ...this.retryOptions,
        onRetry: (err, attempt, delay) => {
          this.logger.warn?.(`[telegram] retrying send (attempt ${attempt}, in ${delay}ms): ${err?.message || err}`);
        },
      },
    );
  }

  // Fire-and-forget: enqueue the message, return immediately so the scan
  // loop never blocks on Telegram lag. Failures are logged, not thrown.
  enqueue(text) {
    if (!this.enabled) {
      this.logger.warn?.('[telegram] disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
      return;
    }
    this.queue.push(() => this.send(text));
  }

  async drain() {
    return this.queue.drain();
  }

  async #sendOnce(text) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.sendTimeoutMs);
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HttpError(`Telegram sendMessage failed: ${res.status} ${body}`, {
          status: res.status,
          body,
        });
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// Sequential async queue so concurrent enqueues don't fan out hundreds of
// in-flight Telegram requests. Each task is awaited in order; failures are
// logged via the supplied logger so callers don't have to try/catch.
export class TelegramQueue {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  push(taskFn) {
    this.pending += 1;
    this.tail = this.tail
      .then(() => taskFn())
      .catch((err) => {
        this.logger.error?.(`[telegram] queued send failed: ${err?.message || err}`);
      })
      .finally(() => {
        this.pending -= 1;
      });
    return this.tail;
  }

  async drain() {
    return this.tail;
  }
}

export function formatSignal(signal) {
  const { market, profitPercent, sum, daysToClose, category } = signal;
  const slugUrl = market.slug ? `https://polymarket.com/event/${market.slug}` : '';
  const lines = [
    `<b>Arb signal</b> [${category}]`,
    market.question ? `<i>${escape(market.question)}</i>` : '',
    `YES ask: ${fmt(market.yes.price)}  NO ask: ${fmt(market.no.price)}  Sum: ${fmt(sum)}`,
    `Profit: <b>${profitPercent.toFixed(2)}%</b>  Closes in: ${daysToClose.toFixed(2)}d`,
    `Liquidity: $${Math.round(market.liquidity).toLocaleString()}  Vol24h: $${Math.round(market.volume24h).toLocaleString()}`,
    slugUrl,
  ];
  return lines.filter(Boolean).join('\n');
}

function fmt(n) {
  return Number(n).toFixed(3);
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
