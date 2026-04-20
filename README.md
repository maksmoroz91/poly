# poly

Polymarket same-market arbitrage bot (Node.js).

## Idea

On Polymarket, `YES + NO` of the same market settle to exactly `$1.00`.
If the sum of the best ask prices is below `$1.00` (minus platform fees), buying both legs at the same time locks in the spread as profit at resolution.

The bot:

1. Fetches active markets from the public Polymarket Gamma API.
2. Filters them by `DAYS_TO_CLOSE`, liquidity and 24h volume.
3. Computes `ask(YES) + ask(NO)` and compares with `1 - FEE_PERCENT%`.
4. When `MIN_PROFIT_PERCENT` is cleared, it sends a Telegram alert.
5. In `BOT_MODE=auto` it fires both buys in parallel and rolls back if one fails.

## Market priorities (highest first)

1. **Esports** — CS2, Dota 2, LoL, Valorant finals/playoffs. Arb windows typically last 2–10 minutes.
2. **Politics** — elections, votes, nominations. Windows last 30–90 seconds after news.
3. **Crypto** — BTC/ETH price targets. Windows appear after sharp moves.

The scanner categorises each market (see `src/categorize.js`) and sorts signals by category first, then by profit percent.

## Configuration

Copy `.env.example` to `.env` and fill in values, or export them in your shell.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIN_PROFIT_PERCENT` | `3` | Minimum profit as % of capital deployed |
| `MAX_BET_USDC` | `10` | Max USDC per arb pair (sum of both legs) |
| `DAYS_TO_CLOSE` | `7` | Ignore markets closing further out than this |
| `BOT_MODE` | `monitor` | `monitor` = signals only; `auto` = place orders |
| `SCAN_INTERVAL_SEC` | `5` | Delay between scans |
| `MIN_LIQUIDITY_USDC` | `5000` | Filter thin markets |
| `MIN_VOLUME_24H_USDC` | `500` | Filter inactive markets |
| `FEE_PERCENT` | `2` | Platform fee used in the threshold calc |
| `TELEGRAM_BOT_TOKEN` | – | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | – | Target chat id |
| `WALLET_PRIVATE_KEY` | – | Required only in `auto` mode |
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` | |
| `POLYMARKET_CLOB_URL` | `https://clob.polymarket.com` | |

## Run

Requires Node.js 20+.

```bash
# monitor only (Telegram signals, no trades)
npm run scan

# auto mode (places parallel YES+NO buys; see note below)
npm run auto
```

### Auto-mode note

Placing real orders requires signing EIP-712 payloads for the Polymarket CLOB.
`src/executor.js` exposes a `ParallelExecutor` that takes injected `placeOrder`
and `cancelOrder` functions. To trade real funds, install
[`@polymarket/clob-client`](https://github.com/Polymarket/clob-client) and wire
it into `src/index.js` in place of `makeUnavailableOrderPlacer`. This keeps
the default build dependency-free and avoids shipping a one-size-fits-all
trading stack.

## Tests

```bash
npm test
```

Uses Node's built-in test runner — no test dependencies to install.

## Project layout

```
src/
  config.js            env/.env parsing + validation
  logger.js            timestamped console logger
  polymarket/
    client.js          Gamma API fetch + market normalization
  scanner.js           filters + arb math
  categorize.js        esports / politics / crypto classifier
  telegram.js          Bot API notifier + signal formatter
  executor.js          parallel YES+NO buyer with rollback
  index.js             main loop
test/                  unit tests for every module above
```

## Safety

- The arbitrage math assumes both legs fill at the quoted ask. In auto mode
  the executor should re-check the real top-of-book just before firing; the
  injected `placeOrder` hook is the right place to add that.
- Rollback is best-effort: if one leg fills and the cancel of the other
  fails, the operator must reconcile manually.
- Start with `BOT_MODE=monitor` until you trust the signal quality.
