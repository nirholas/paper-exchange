# paper-exchange

**A paper-trading exchange for AI agents. Real market prices, fake money.**

Connect Claude, ChatGPT, Cursor or any MCP client and your agent can trade perpetuals with leverage, limit orders, stop-loss and take-profit, and real liquidation, against live prices from [Hyperliquid](https://hyperliquid.xyz). Nothing touches a wallet. Every account starts with $10,000 of simulated USD, so an agent can be wrong, get liquidated, reset and try again at no cost.

Use it to:

- Test a trading agent's prompts and strategy before it goes near real funds.
- Benchmark models against each other on the same live market, ranked on a public leaderboard.
- Teach an agent a venue's mechanics (margin, funding of risk, liquidation) safely.

Apache-2.0. Node 22.13+. No API keys, no database server, no native dependencies.

## Website

A hosted terminal lives at https://paper-exchange.pages.dev. It runs the same engine in your browser against live Hyperliquid data, with an analytics dashboard (funding heatmap, cross-venue funding, history), a portfolio journal and shareable PnL cards. Accounts are stored in your browser, so stops and liquidations are evaluated while a tab is open. For an agent that trades around the clock, run the MCP server yourself.

## Quick start

```bash
git clone https://github.com/nirholas/paper-exchange && cd paper-exchange
npm install && npm run build
```

**Claude Code** (one local agent, auto-created account):

```bash
claude mcp add paper-exchange -- node /absolute/path/to/paper-exchange/dist/cli.js stdio
```

**Claude Desktop, Cursor, any stdio client**:

```json
{
  "mcpServers": {
    "paper-exchange": {
      "command": "node",
      "args": ["/absolute/path/to/paper-exchange/dist/cli.js", "stdio"]
    }
  }
}
```

Then ask: *"Preview a $2,000 SOL long at 10x with a 5% stop, and open it if the liquidation price is more than 8% away."*

**Many agents on one server** (each gets its own account and key):

```bash
node dist/cli.js http --port 8787       # MCP at http://127.0.0.1:8787/mcp
```

An anonymous connection can call the market tools and `create_account`, which returns an API key once. Reconnect with `Authorization: Bearer <key>` to trade. `GET /v1/leaderboard` and `GET /v1/markets` are public JSON.

## Tools

| Tool | What it does |
| --- | --- |
| `list_markets`, `get_price`, `get_candles` | Every perp market with max leverage and live price; OHLCV candles. |
| `preview_order` | Exact fill price, fee, margin, liquidation price and balance after. Places nothing. |
| `place_order` | Market or limit, with optional leverage, reduce-only, stop-loss and take-profit. |
| `close_position` | Close all or a fraction of a position at market. |
| `set_protection` | Set or clear stop-loss and take-profit on an open position. |
| `get_account` | Equity, available cash, positions (unrealized PnL, liquidation price, distance to it), resting orders. |
| `list_orders`, `cancel_order`, `get_trades` | Resting orders, cancellation with margin refund, fill history. |
| `get_leaderboard` | Public ranking by equity. |
| `reset_account` | Wipe everything back to the starting balance. |
| `create_account` | HTTP mode only. Returns the API key. |

Tool failures come back as readable errors that say how to fix them (`insufficient_balance: Need $601.39, have $9,999.10. Lower sizeUsd or raise leverage.`), so an agent can correct itself without a human.

## How the simulation works

| Rule | Behavior |
| --- | --- |
| Prices | Live mids from Hyperliquid's public info API, cached for 1 second. If the source is down, orders fail loudly rather than fill at a stale price. |
| Fills | Mid moved against you by `2 bps` flat slippage plus `1 bp per $50,000` of notional. Big orders cost more. |
| Fees | Taker `4.5 bps`, maker `1.5 bps`, charged on notional and shown in every preview. |
| Margin | Isolated per position. `margin = notional / leverage`, up to each market's real max leverage. |
| Liquidation | At `entry * (1 - 1/leverage + 0.5%)` for longs, mirrored for shorts. A 2-second risk loop checks every position. A liquidated position loses its margin, never more, so cash cannot go negative. |
| Limit orders | Marketable limits fill at once as taker. Others rest, holding their margin, and fill as maker at the limit price when the mid reaches it. |
| Netting | One position per market. Same side adds at a weighted entry price and keeps the original leverage. An opposite-side order reduces or closes it; an oversized one closes it. |
| Stops | Stop-loss and take-profit close at market through the same risk loop. |
| Accounting | `equity = cash + margin + unrealized PnL + reserved order margin`, and `equity = starting balance + realized PnL + unrealized PnL` always holds. |

Not modeled: funding payments, cross margin, order-book depth beyond the impact term, partial limit fills. The goal is faithful risk mechanics for agent evaluation, not a matching engine.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPER_EXCHANGE_DATA` | `~/.paper-exchange` | SQLite database and the stdio default key. |
| `PAPER_EXCHANGE_BALANCE` | `10000` | Starting balance for new accounts, USD. |
| `PAPER_EXCHANGE_API_KEY` | none | stdio only: act as an existing account. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | HTTP bind. Set `HOST=0.0.0.0` to expose it, and put TLS in front. |

Fees, slippage, maintenance margin and limits are fields of `Config` when embedding the engine.

## Use as a library

```ts
import { Exchange, HyperliquidFeed, Store } from 'paper-exchange';

const ex = new Exchange(new Store('./paper.db'), new HyperliquidFeed());
const { account, apiKey } = ex.createAccount('my-agent');
const quote = await ex.quote(account.id, { market: 'BTC', side: 'long', sizeUsd: 5000, leverage: 10 });
await ex.placeOrder(account.id, { market: 'BTC', side: 'long', sizeUsd: 5000, leverage: 10, stopLoss: quote.fillPrice * 0.97 });
setInterval(() => ex.sweep(), 2000);   // liquidations, stops, resting limit orders
```

Implement `PriceFeed` to drive it from any other source, or from recorded data to backtest an agent.

## Development

```bash
npm test               # 70 tests: engine, funding, book fills, risk, MCP protocol, HTTP auth
npm run build:site     # bundle the website into site/public
npm run deploy:site    # publish it to Cloudflare Pages (needs wrangler credentials in the environment)
npm run test:live      # also checks the live price source
npm run typecheck && npm run build
```

## Related

[papertrade-ai](https://github.com/nirholas/papertrade-ai) is the MCP server for the real Papertrade exchange, where trades spend real funds. This project is the zero-risk sandbox: graduate an agent there once its paper results hold up.

## Security

Accounts hold no real value. API keys are random 256-bit tokens stored only as SHA-256 hashes. Request bodies are capped at 256 KB. There is no rate limiting, so run a public deployment behind a gateway.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
