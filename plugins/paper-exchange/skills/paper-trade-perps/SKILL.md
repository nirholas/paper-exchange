---
name: paper-trade-perps
description: Run the paper-exchange MCP server from a clone and paper-trade perpetuals with live Hyperliquid prices and fake money. Use to test a trading strategy, prompt or agent with no real funds.
---

# Paper-trade perps with paper-exchange

paper-exchange is a Node (>=22.13) MCP server. It simulates a perps exchange: real Hyperliquid mid prices, $10,000 of fake USD per account, leverage, limit orders, stop-loss, take-profit, liquidation and a leaderboard. Nothing touches a wallet. It is not published to npm and has no hosted MCP URL, so run it from a clone.

## Install

```bash
git clone https://github.com/nirholas/paper-exchange
cd paper-exchange
npm install && npm run build
claude mcp add paper-exchange -- node "$PWD/dist/cli.js" stdio
```

Stdio mode auto-creates one local account (data in `~/.paper-exchange`, override with `PAPER_EXCHANGE_DATA`). Other env: `PAPER_EXCHANGE_BALANCE` (default 10000), `PAPER_EXCHANGE_API_KEY` to act as an existing account.

Many agents on one server: `node dist/cli.js http --port 8787` serves MCP at `http://127.0.0.1:8787/mcp`. Anonymous callers get market tools and `create_account` (returns an API key once); reconnect with `Authorization: Bearer <key>` to trade. Public JSON: `GET /v1/leaderboard`, `GET /v1/markets`.

## Tools

- Market data: `list_markets`, `get_price`, `get_candles`.
- Orders: `preview_order` (fill price, fee, margin, liquidation price, places nothing), `place_order` (market or limit, leverage, reduce-only, stop-loss, take-profit), `close_position`, `set_protection`, `list_orders`, `cancel_order`, `get_trades`.
- Account: `get_account`, `reset_account`, `get_leaderboard`, `create_account` (HTTP mode only).

## Workflow

1. `list_markets` and `get_price` for the market.
2. Always `preview_order` first and check the liquidation price distance.
3. `place_order` with a stop-loss. Re-read with `get_account`.
4. Errors are readable and say how to fix the order (for example `insufficient_balance`); adjust and retry.
5. `reset_account` to start over after a liquidation.

## Model limits

Fills are mid plus 2 bps slippage plus 1 bp per $50,000 notional. Taker fee 4.5 bps, maker 1.5 bps. Isolated margin, one position per market. Funding payments, cross margin and partial limit fills are not modeled. If the price source is down, orders fail rather than fill stale.

## Worked example

Ask: "Preview a $2,000 SOL long at 10x with a 5% stop." Call `preview_order` with `{market: "SOL", side: "long", sizeUsd: 2000, leverage: 10}`, then `place_order` with the same fields plus `stopLoss` set 5% below `fillPrice`.
