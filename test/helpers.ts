import { Exchange } from '../src/exchange.js';
import { MemoryStore } from '../src/memory-store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import type { Store } from '../src/store.js';
import type { Book, Candle, Market, MarketStats, PriceFeed } from '../src/types.js';

/** A feed whose prices the test controls, standing in for the live venue. */
export class ControlledFeed implements PriceFeed {
  constructor(public prices: Record<string, number> = { BTC: 100_000, SOL: 200 }) {}
  async markets(): Promise<Market[]> {
    return [
      { name: 'BTC', maxLeverage: 50, sizeDecimals: 5 },
      { name: 'SOL', maxLeverage: 20, sizeDecimals: 2 },
    ];
  }
  async mids() { return { ...this.prices }; }
  async candles(): Promise<Candle[]> { return []; }
}

/** Adds funding rates and an order book to the controlled feed. */
export class RichFeed extends ControlledFeed {
  funding: Record<string, number> = { BTC: 0.0001, SOL: -0.0002 };
  books: Record<string, Book> = {};
  async stats(): Promise<Record<string, MarketStats>> {
    return Object.fromEntries(Object.entries(this.prices).map(([market, px]) => [market, {
      market, markPx: px, oraclePx: px, funding: this.funding[market] ?? 0, premium: 0, openInterest: 1000, dayNtlVlm: 1e6, prevDayPx: px, maxLeverage: 50,
    }]));
  }
  async book(market: string): Promise<Book> {
    const b = this.books[market];
    if (!b) throw new Error('no book');
    return b;
  }
}

export const storeKinds = ['sqlite', 'memory'] as const;
export type StoreKind = (typeof storeKinds)[number];
export const makeStore = (kind: StoreKind): Store => (kind === 'sqlite' ? new SqliteStore(':memory:') : new MemoryStore());

export function setup(cfg = {}, kind: StoreKind = 'sqlite', feed = new ControlledFeed(), clock?: () => number) {
  const ex = new Exchange(makeStore(kind), feed, { slippageBps: 0, impactUsdPerBp: 1e12, takerFeeBps: 5, makerFeeBps: 1, ...cfg }, clock);
  const { account, apiKey } = ex.createAccount('tester');
  return { feed, ex, account, apiKey, id: account.id };
}
