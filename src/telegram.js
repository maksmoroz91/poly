export class TelegramNotifier {
  constructor({ botToken, chatId, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.botToken && this.chatId);
  }

  async send(text) {
    if (!this.enabled) {
      this.logger.warn?.('[telegram] disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
      return { skipped: true };
    }
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
    return res.json();
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
