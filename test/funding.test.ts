import { describe, expect, it } from 'vitest';
import { bookFillPrice, fundingPayment } from '../src/math.js';
import { RichFeed, setup, storeKinds } from './helpers.js';

describe('math', () => {
  it('walks a book to a volume-weighted price and reports thin books', () => {
    const asks: [number, number][] = [[100, 1], [101, 2], [105, 10]];
    expect(bookFillPrice(asks, 0.5)).toBe(100);
    expect(bookFillPrice(asks, 3)).toBeCloseTo((100 + 202) / 3, 8);
    expect(bookFillPrice(asks.slice(0, 2), 4)).toBeNull();
  });

  it('charges longs and pays shorts when funding is positive', () => {
    expect(fundingPayment('long', 2, 100, 0.0001, 3_600_000)).toBeCloseTo(0.02, 10);
    expect(fundingPayment('short', 2, 100, 0.0001, 3_600_000)).toBeCloseTo(-0.02, 10);
    expect(fundingPayment('long', 2, 100, -0.0001, 1_800_000)).toBeCloseTo(-0.01, 10);
  });
});

describe.each(storeKinds)('%s store: funding and book fills', (kind) => {
  it('accrues real funding hour by hour into margin and realized PnL', async () => {
    let t = 1_000_000;
    const feed = new RichFeed();
    const { ex, id } = setup({}, kind, feed, () => t);
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    const before = await ex.accountView(id);
    t += 3_600_000;
    await ex.sweep();
    const after = await ex.accountView(id);
    expect(after.fundingPaid).toBeCloseTo(1, 4);
    expect(after.positions[0]!.fundingPaid).toBeCloseTo(1, 4);
    expect(after.positions[0]!.margin).toBeCloseTo(before.positions[0]!.margin - 1, 4);
    expect(after.equity).toBeCloseTo(before.equity - 1, 4);
    expect(after.equity).toBeCloseTo(after.startingBalance + after.realizedPnl + after.unrealizedPnl, 4);
  });

  it('pays a short that sits on the paying side and receives when the rate is negative', async () => {
    let t = 0;
    const feed = new RichFeed();
    const { ex, id } = setup({}, kind, feed, () => t);
    await ex.placeOrder(id, { market: 'SOL', side: 'long', sizeUsd: 2_000, leverage: 5 });
    t += 7_200_000;
    await ex.sweep();
    const v = await ex.accountView(id);
    expect(v.fundingPaid).toBeCloseTo(-2000 * 0.0002 * 2, 3);
    expect(v.positions[0]!.fundingRate).toBe(-0.0002);
  });

  it('liquidates a position whose margin funding has eaten', async () => {
    let t = 0;
    const feed = new RichFeed();
    feed.funding.BTC = 0.05;
    const { ex, id } = setup({}, kind, feed, () => t);
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    t += 3_600_000 * 2;
    const events = await ex.sweep();
    expect(events.some((e) => e.kind === 'liquidation')).toBe(true);
  });

  it('fills market orders by walking the live book and says so', async () => {
    const feed = new RichFeed();
    feed.books.BTC = { bids: [[99_990, 1], [99_900, 5]], asks: [[100_010, 0.05], [100_100, 5]] };
    const { ex, id } = setup({}, kind, feed);
    const q = await ex.quote(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    expect(q.priceSource).toBe('order_book');
    const size = q.size;
    expect(q.fillPrice).toBeCloseTo((0.05 * 100_010 + (size - 0.05) * 100_100) / size, 3);
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    expect(r.trade!.price).toBeCloseTo(q.fillPrice, 8);
    const closeQ = await ex.quote(id, { market: 'BTC', side: 'short', sizeUsd: 10_000 });
    expect(closeQ.fillPrice).toBeLessThan(100_000);
  });

  it('falls back to the impact model when the book cannot fill the order', async () => {
    const feed = new RichFeed();
    feed.books.BTC = { bids: [[99_990, 0.001]], asks: [[100_010, 0.001]] };
    const { ex, id } = setup({}, kind, feed);
    expect((await ex.quote(id, { market: 'BTC', side: 'long', sizeUsd: 5_000 })).priceSource).toBe('model');
  });
});
