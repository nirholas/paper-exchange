import { $, toast, type Page } from '../ui.js';

const CONFIG = `{
  "mcpServers": {
    "paper-exchange": { "command": "npx", "args": ["-y", "paper-exchange"] }
  }
}`;

const page: Page = {
  mount(root) {
    root.innerHTML = `<div class="dash doc"><header class="dash-head"><div><h1>AI agents</h1><p class="muted">Paper Exchange is built for agents. Any MCP client can open a $10,000 account, read live Hyperliquid markets and trade with real order-book fills, funding and liquidations.</p></div></header>
    <section class="panel pad"><h2>Connect in one line</h2><p>Add the server to Claude Desktop, Cursor or any MCP client. It runs on your machine, keeps your agent's account in a local SQLite file and reads the same live Hyperliquid prices you see on this site.</p>
      <pre class="code" id="cfg">${CONFIG}</pre><button class="btn" id="copy-cfg">Copy config</button>
      <p class="muted small">Remote agents can use the streamable HTTP mode: <code>npx paper-exchange http</code> then POST to <code>/mcp</code> with a Bearer key.</p></section>
    <section class="panel pad"><h2>Tools</h2><div class="tools">
      ${[['list_markets', 'Every perp with price, funding, open interest and 24h change.'], ['get_price', 'Live mark price for one market.'], ['get_candles', 'OHLCV history on six timeframes.'], ['preview_order', 'Fill price, margin, fee and liquidation price before committing.'], ['place_order', 'Market or limit orders with leverage, stop loss and take profit.'], ['close_position', 'Close all or part of a position.'], ['set_protection', 'Move stop loss and take profit on an open position.'], ['get_account', 'Equity, margin, open positions with PnL and funding.'], ['get_trades', 'Full fill history with realized PnL.'], ['get_leaderboard', 'Rank paper accounts by return.'], ['list_orders / cancel_order', 'Manage resting limit orders.'], ['reset_account', 'Start over with a fresh balance.']].map(([n, d]) => `<div><code>${n}</code><span>${d}</span></div>`).join('')}
    </div></section>
    <section class="panel pad"><h2>How realistic is it?</h2><ul class="list">
      <li><b>Prices:</b> live Hyperliquid mark prices, no key needed.</li>
      <li><b>Fills:</b> market orders walk the real order book, with an impact model as the fallback.</li>
      <li><b>Fees:</b> 4.5 bps taker, 1.5 bps maker, the Hyperliquid base tier.</li>
      <li><b>Funding:</b> accrued hourly from the real funding rate on every open position.</li>
      <li><b>Liquidation:</b> isolated margin, margin-aware, with a maintenance requirement.</li>
      <li><b>Orders:</b> limit orders rest and reserve margin, stop loss and take profit trigger on the mark.</li>
    </ul></section>
    <section class="panel pad"><h2>What this site is, and is not</h2><p>This website runs the same engine in your browser. Your account lives in this browser's local storage, so there is no signup and nothing to leak, but it is also only evaluated while a tab is open: stops and liquidations are checked against the live price whenever you return. For an agent that trades around the clock, run the MCP server yourself. Paper Exchange never touches real funds.</p>
      <p class="row wrap gap"><a class="btn primary" href="https://github.com/nirholas/paper-exchange" target="_blank" rel="noopener noreferrer">View on GitHub</a><a class="btn" href="/llms.txt">llms.txt</a></p></section></div>`;
    $('#copy-cfg')!.onclick = async () => {
      try { await navigator.clipboard.writeText(CONFIG); toast('Config copied.', 'ok'); } catch { toast('Copy blocked by the browser. Select the text manually.', 'err'); }
    };
  },
};
export default page;
