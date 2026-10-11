import { Exchange } from '../src/exchange.js';
import { Store } from '../src/store.js';
import type { Candle, Market, PriceFeed } from '../src/types.js';

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

export function setup(cfg = {}) {
  const feed = new ControlledFeed();
  const ex = new Exchange(new Store(':memory:'), feed, { slippageBps: 0, impactUsdPerBp: 1e12, takerFeeBps: 5, makerFeeBps: 1, ...cfg });
  const { account, apiKey } = ex.createAccount('tester');
  return { feed, ex, account, apiKey, id: account.id };
}
