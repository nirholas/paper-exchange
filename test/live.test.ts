import { describe, expect, it } from 'vitest';
import { HyperliquidFeed } from '../src/prices.js';

describe.skipIf(!process.env.PAPER_LIVE)('live Hyperliquid feed', () => {
  const feed = new HyperliquidFeed();
  it('serves markets, prices and candles', async () => {
    const markets = await feed.markets();
    const mids = await feed.mids();
    expect(markets.some((m) => m.name === 'BTC' && m.maxLeverage > 1)).toBe(true);
    expect(mids.BTC).toBeGreaterThan(1_000);
    expect(mids.SOL).toBeGreaterThan(1);
    const candles = await feed.candles('SOL', '1h', 24);
    expect(candles.length).toBeGreaterThan(10);
    expect(candles[0]!.high).toBeGreaterThanOrEqual(candles[0]!.low);
  });
});
