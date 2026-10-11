# Changelog

## 0.2.0

- Website (Cloudflare Pages): Hyperliquid-style trading terminal with live candles, order book and trades over WebSocket, an order ticket with margin, fee, slippage, liquidation and funding-per-day preview, a risk-based position sizer, and take-profit and stop-loss editing.
- Markets analytics dashboard: funding and open-interest heatmap, funding opportunities, cross-venue funding (Hyperliquid, Binance, Bybit), funding history and a sortable table of every perpetual.
- Portfolio journal with win rate, profit factor, equity curve and backup export and import.
- PnL cards: shareable PNG cards for open positions, closed trades and what-if scenarios, always watermarked as paper trades.
- Engine: hourly funding accrual from real rates, order-book-walking fills, margin-aware liquidation, platform-neutral stores so the same engine runs in a browser.
- Trades now record entry price and leverage.
- MCP `list_markets` now returns funding, open interest, volume and 24h change.
- Fix: the price feed no longer throws "Illegal invocation" when run in a browser.

## 0.1.0

- Paper-trading exchange engine: market and limit orders, isolated-margin leverage, slippage and size impact, maker and taker fees, stop-loss and take-profit, liquidation, leaderboard.
- Live prices and candles from Hyperliquid's public info API.
- MCP server over stdio (single agent) and streamable HTTP (many agents, API-key accounts).
- SQLite persistence on the built-in `node:sqlite`.
