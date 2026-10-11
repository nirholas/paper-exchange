import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Exchange } from './exchange.js';
import { CANDLE_INTERVALS } from './prices.js';
import { ExchangeError, type Account } from './types.js';

export const SERVER_INFO = { name: 'paper-exchange', version: '0.1.0' };

const INSTRUCTIONS = `Paper-trading exchange: real market prices, simulated money. Nothing here touches a real wallet or real funds.
Workflow: list_markets / get_price to look, preview_order to see exact fill, fee, margin and liquidation price, place_order to trade, get_account to review, set_protection for stop-loss / take-profit, close_position to exit.
Leverage is isolated margin per position. Positions liquidate automatically when mark price reaches the liquidation price. Prices are live mid prices; fills include slippage and size impact. Money is USD.`;

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: message }] });

async function run<T>(fn: () => Promise<T> | T) {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof ExchangeError) return failure(`${err.code}: ${err.message}`);
    throw err;
  }
}

const orderShape = {
  market: z.string().describe('Market name, e.g. BTC, ETH, SOL. See list_markets.'),
  side: z.enum(['long', 'short']).describe('long buys, short sells. Opposite an open position, it reduces or closes it.'),
  sizeUsd: z.number().positive().describe('Order size as notional USD (margin x leverage), not margin.'),
  leverage: z.number().min(1).optional().describe('Leverage for a new position. Defaults to 5x. Ignored when adding to an existing position, which keeps its leverage.'),
  type: z.enum(['market', 'limit']).optional().describe('Defaults to market.'),
  limitPrice: z.number().positive().optional().describe('Required for limit orders.'),
  reduceOnly: z.boolean().optional().describe('Only ever reduce an existing position.'),
  stopLoss: z.number().positive().nullable().optional().describe('Attach a stop-loss price. Long: below entry. Short: above entry.'),
  takeProfit: z.number().positive().nullable().optional().describe('Attach a take-profit price. Long: above entry. Short: below entry.'),
};

export interface McpContext {
  exchange: Exchange;
  /** The authenticated account, or null for an anonymous connection. */
  account: Account | null;
  /** Lets an anonymous connection create an account. Disable for single-user deployments. */
  allowSignup: boolean;
}

export function createMcpServer({ exchange, account, allowSignup }: McpContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const need = (): string => account?.id ?? (() => { throw new ExchangeError('unauthorized', 'This tool needs an account. Call create_account, then reconnect with the returned key as "Authorization: Bearer <key>".'); })();

  server.registerTool('list_markets', {
    description: 'List every tradable perpetual market with price, maximum leverage and, when the feed provides it, hourly funding rate, funding APR, open interest (USD), 24h volume (USD) and 24h change. Longs pay shorts when funding is positive.',
    annotations: readOnly,
  }, () => run(async () => {
    const [markets, mids, stats] = await Promise.all([exchange.markets(), exchange.feed.mids(), exchange.feed.stats ? exchange.feed.stats().catch(() => null) : null]);
    return markets.filter((m) => mids[m.name]).map((m) => {
      const s = stats?.[m.name];
      const base = { market: m.name, price: mids[m.name], maxLeverage: m.maxLeverage };
      if (!s) return base;
      return {
        ...base,
        fundingRateHourly: s.funding,
        fundingAprPct: Number((s.funding * 24 * 365 * 100).toFixed(2)),
        openInterestUsd: Math.round(s.openInterest * s.markPx),
        volume24hUsd: Math.round(s.dayNtlVlm),
        change24hPct: s.prevDayPx ? Number((((s.markPx - s.prevDayPx) / s.prevDayPx) * 100).toFixed(2)) : null,
      };
    });
  }));

  server.registerTool('get_price', {
    description: 'Current mid price of one market.',
    inputSchema: { market: z.string() },
    annotations: readOnly,
  }, ({ market }) => run(async () => ({ market: market.toUpperCase(), price: await exchange.price(market) })));

  server.registerTool('get_candles', {
    description: 'Recent OHLCV candles for one market, oldest first.',
    inputSchema: { market: z.string(), interval: z.enum(CANDLE_INTERVALS as [string, ...string[]]).default('1h'), count: z.number().int().min(1).max(500).default(100) },
    annotations: readOnly,
  }, ({ market, interval, count }) => run(() => exchange.candles(market.toUpperCase(), interval, count)));

  server.registerTool('get_leaderboard', {
    description: 'Public ranking of paper accounts by equity.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: readOnly,
  }, ({ limit }) => run(() => exchange.leaderboard(limit)));

  if (allowSignup) {
    server.registerTool('create_account', {
      description: `Create a paper account funded with $${exchange.cfg.startingBalance.toLocaleString('en-US')} of simulated USD. Returns an API key shown once. Send it as "Authorization: Bearer <key>" on later connections.`,
      inputSchema: { name: z.string().min(1).max(40).describe('Display name for the leaderboard, e.g. your agent name.') },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, ({ name }) => run(() => {
      const { account: a, apiKey } = exchange.createAccount(name);
      return { accountId: a.id, name: a.name, startingBalance: a.balance, apiKey, note: 'Store this key now. It cannot be shown again.' };
    }));
  }

  server.registerTool('get_account', {
    description: 'Your equity, available cash, open positions (with unrealized PnL and liquidation price) and resting orders.',
    annotations: readOnly,
  }, () => run(() => exchange.accountView(need())));

  server.registerTool('preview_order', {
    description: 'Dry run of place_order. Returns the exact fill price, fee, margin required, liquidation price and balance after, without placing anything. Always preview first.',
    inputSchema: orderShape,
    annotations: readOnly,
  }, (req) => run(() => exchange.quote(need(), req)));

  server.registerTool('place_order', {
    description: 'Place a paper order. Market orders fill immediately at live price plus slippage. Limit orders fill immediately if marketable, otherwise rest until price reaches them, holding the margin meanwhile.',
    inputSchema: orderShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (req) => run(() => exchange.placeOrder(need(), req)));

  server.registerTool('close_position', {
    description: 'Close all or part of an open position at market.',
    inputSchema: { market: z.string(), fraction: z.number().gt(0).max(1).default(1).describe('Share of the position to close. 1 closes it all.') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ market, fraction }) => run(() => exchange.closePosition(need(), market, fraction)));

  server.registerTool('set_protection', {
    description: 'Set or clear stop-loss and take-profit on an open position. Omit a field to leave it unchanged, pass null to clear it.',
    inputSchema: { market: z.string(), stopLoss: z.number().positive().nullable().optional(), takeProfit: z.number().positive().nullable().optional() },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ market, stopLoss, takeProfit }) => run(() => exchange.setProtection(need(), market, { stopLoss, takeProfit })));

  server.registerTool('list_orders', {
    description: 'Your resting limit orders.',
    annotations: readOnly,
  }, () => run(() => exchange.orders(need())));

  server.registerTool('cancel_order', {
    description: 'Cancel a resting limit order and release its reserved margin.',
    inputSchema: { orderId: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ orderId }) => run(() => exchange.cancelOrder(need(), orderId)));

  server.registerTool('get_trades', {
    description: 'Your fill history, newest first, including liquidations and stop-loss / take-profit exits.',
    inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
    annotations: readOnly,
  }, ({ limit }) => run(() => exchange.trades(need(), limit)));

  server.registerTool('reset_account', {
    description: 'Wipe all positions, orders and history and restore the starting balance. Cannot be undone.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, () => run(() => { const a = exchange.resetAccount(need()); return { balance: a.balance }; }));

  return server;
}
