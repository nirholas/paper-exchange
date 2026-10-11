import { describe, expect, it } from 'vitest';
import { ExchangeError } from '../src/types.js';
import { setup } from './helpers.js';

describe('accounts', () => {
  it('starts with the configured balance and authenticates by key', () => {
    const { ex, apiKey, id } = setup();
    expect(ex.authenticate(apiKey).id).toBe(id);
    expect(() => ex.authenticate('pe_wrong')).toThrow(ExchangeError);
  });

  it('never stores the raw key', () => {
    const { ex, apiKey } = setup();
    const rows = ex.store.db.prepare('SELECT key_hash FROM accounts').all() as { key_hash: string }[];
    expect(rows[0]!.key_hash).not.toContain(apiKey);
    expect(rows[0]!.key_hash).toHaveLength(64);
  });
});

describe('market orders', () => {
  it('opens a long with exact margin, fee and liquidation price', async () => {
    const { ex, id } = setup();
    const res = await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    expect(res.trade?.kind).toBe('open');
    expect(res.position?.margin).toBeCloseTo(1_000, 4);
    expect(res.trade?.fee).toBeCloseTo(5, 4);
    expect(res.position?.liquidationPrice).toBeCloseTo(100_000 * (1 - 0.1 + 0.005), 2);
    const view = await ex.accountView(id);
    expect(view.available).toBeCloseTo(10_000 - 1_000 - 5, 4);
    expect(view.equity).toBeCloseTo(10_000 - 5, 4);
  });

  it('quote matches the fill that follows', async () => {
    const { ex, id } = setup({ slippageBps: 3, impactUsdPerBp: 100_000 });
    const q = await ex.quote(id, { market: 'SOL', side: 'short', sizeUsd: 2_000, leverage: 5 });
    const r = await ex.placeOrder(id, { market: 'SOL', side: 'short', sizeUsd: 2_000, leverage: 5 });
    expect(r.trade?.price).toBeCloseTo(q.fillPrice, 8);
    expect(r.trade?.fee).toBeCloseTo(q.fee, 6);
    expect(q.fillPrice).toBeLessThan(200);
  });

  it('realizes profit on close and conserves equity', async () => {
    const { ex, feed, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    feed.prices.BTC = 110_000;
    const mid = await ex.accountView(id);
    expect(mid.unrealizedPnl).toBeCloseTo(1_000, 2);
    const { trade } = await ex.closePosition(id, 'BTC');
    expect(trade.kind).toBe('close');
    const after = await ex.accountView(id);
    expect(after.positions).toHaveLength(0);
    expect(after.available).toBeCloseTo(10_000 + 1_000 - 5 - 5.5, 2);
    expect(after.equity).toBeCloseTo(after.startingBalance + after.realizedPnl, 4);
  });

  it('realizes a loss on a short that goes against it', async () => {
    const { ex, feed, id } = setup();
    await ex.placeOrder(id, { market: 'SOL', side: 'short', sizeUsd: 4_000, leverage: 4 });
    feed.prices.SOL = 210;
    await ex.closePosition(id, 'SOL');
    const v = await ex.accountView(id);
    expect(v.realizedPnl).toBeLessThan(-200);
    expect(v.available).toBeCloseTo(10_000 + v.realizedPnl, 4);
  });

  it('partially closes and keeps the remainder', async () => {
    const { ex, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    const { trade, position } = await ex.closePosition(id, 'BTC', 0.25);
    expect(trade.kind).toBe('reduce');
    expect(position?.size).toBeCloseTo(0.075, 5);
    expect(position?.margin).toBeCloseTo(750, 3);
  });

  it('adds to a position at a weighted entry using the original leverage', async () => {
    const { ex, feed, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 10 });
    feed.prices.BTC = 120_000;
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 12_000, leverage: 2 });
    expect(r.trade?.kind).toBe('add');
    expect(r.position?.leverage).toBe(10);
    expect(r.position?.entryPrice).toBeCloseTo((0.1 * 100_000 + 0.1 * 120_000) / 0.2, 2);
  });

  it('closes rather than flips when a reverse order exceeds the position', async () => {
    const { ex, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 1_000, leverage: 5 });
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'short', sizeUsd: 5_000 });
    expect(r.trade?.kind).toBe('close');
    expect(r.position).toBeNull();
  });

  it('rejects orders the balance cannot cover, naming the shortfall', async () => {
    const { ex, id } = setup();
    await expect(ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 500_000, leverage: 5 })).rejects.toThrow(/insufficient|Need \$/i);
    expect((await ex.accountView(id)).available).toBe(10_000);
  });

  it('rejects unknown markets, bad leverage and reduce-only without a position', async () => {
    const { ex, id } = setup();
    await expect(ex.placeOrder(id, { market: 'NOPE', side: 'long', sizeUsd: 100 })).rejects.toMatchObject({ code: 'unknown_market' });
    await expect(ex.placeOrder(id, { market: 'SOL', side: 'long', sizeUsd: 100, leverage: 21 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(ex.placeOrder(id, { market: 'SOL', side: 'long', sizeUsd: 100, reduceOnly: true })).rejects.toMatchObject({ code: 'no_position' });
  });

  it('applies slippage and size impact against the taker', async () => {
    const { ex, id } = setup({ slippageBps: 10, impactUsdPerBp: 10_000 });
    const q = await ex.quote(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 5 });
    expect(q.fillPrice).toBeCloseTo(100_000 * (1 + 11 / 10_000), 2);
  });
});

describe('risk engine', () => {
  it('liquidates a long when mark crosses the liquidation price and loses the margin', async () => {
    const { ex, feed, id } = setup();
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 20 });
    feed.prices.BTC = r.position!.liquidationPrice - 1;
    const events = await ex.sweep();
    expect(events.map((e) => e.kind)).toContain('liquidation');
    const v = await ex.accountView(id);
    expect(v.positions).toHaveLength(0);
    expect(v.liquidations).toBe(1);
    expect(v.equity).toBeLessThan(10_000 - 400);
    expect(v.equity).toBeGreaterThan(10_000 - 500 - 10);
  });

  it('liquidates shorts on the way up', async () => {
    const { ex, feed, id } = setup();
    const r = await ex.placeOrder(id, { market: 'SOL', side: 'short', sizeUsd: 1_000, leverage: 10 });
    feed.prices.SOL = r.position!.liquidationPrice + 0.5;
    expect((await ex.sweep()).some((e) => e.kind === 'liquidation')).toBe(true);
  });

  it('never leaves equity negative after a gap through liquidation', async () => {
    const { ex, feed, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 50_000, leverage: 50 });
    feed.prices.BTC = 10_000;
    await ex.sweep();
    expect((await ex.accountView(id)).available).toBeGreaterThanOrEqual(0);
  });

  it('closes on stop loss and take profit', async () => {
    const { ex, feed, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 5, stopLoss: 95_000, takeProfit: 108_000 });
    feed.prices.BTC = 94_000;
    expect((await ex.sweep())[0]?.kind).toBe('stop_loss');
    expect((await ex.trades(id, 1))[0]?.kind).toBe('stop_loss');

    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 5, takeProfit: 99_000 });
    feed.prices.BTC = 99_500;
    expect((await ex.sweep())[0]?.kind).toBe('take_profit');
    expect((await ex.accountView(id)).positions).toHaveLength(0);
  });

  it('rejects a stop on the wrong side of entry', async () => {
    const { ex, id } = setup();
    await expect(ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 1_000, stopLoss: 120_000 })).rejects.toThrow(/stopLoss must be below/);
  });

  it('sets and clears protection on an open position', async () => {
    const { ex, id } = setup();
    await ex.placeOrder(id, { market: 'SOL', side: 'short', sizeUsd: 1_000, leverage: 3 });
    const set = await ex.setProtection(id, 'SOL', { stopLoss: 220, takeProfit: 180 });
    expect(set.stopLoss).toBe(220);
    const cleared = await ex.setProtection(id, 'SOL', { stopLoss: null });
    expect(cleared.stopLoss).toBeNull();
    expect(cleared.takeProfit).toBe(180);
  });
});

describe('limit orders', () => {
  it('rests, reserves margin, then fills as maker when price arrives', async () => {
    const { ex, feed, id } = setup();
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'long', type: 'limit', limitPrice: 95_000, sizeUsd: 9_500, leverage: 10 });
    expect(r.order?.status).toBe('open');
    let v = await ex.accountView(id);
    expect(v.available).toBeCloseTo(9_050, 2);
    expect(v.equity).toBeCloseTo(10_000, 2);
    expect(await ex.sweep()).toHaveLength(0);

    feed.prices.BTC = 94_900;
    const events = await ex.sweep();
    expect(events[0]?.kind).toBe('limit_fill');
    v = await ex.accountView(id);
    expect(v.positions[0]?.entryPrice).toBe(95_000);
    expect(v.openOrders).toHaveLength(0);
    expect((await ex.trades(id, 1))[0]?.liquidity).toBe('maker');
    expect(v.equity).toBeLessThan(10_000);
  });

  it('refunds reserved margin on cancel', async () => {
    const { ex, id } = setup();
    const r = await ex.placeOrder(id, { market: 'SOL', side: 'short', type: 'limit', limitPrice: 250, sizeUsd: 2_500, leverage: 5 });
    expect((await ex.accountView(id)).available).toBeCloseTo(9_500, 2);
    ex.cancelOrder(id, r.order!.id);
    expect((await ex.accountView(id)).available).toBe(10_000);
    expect(() => ex.cancelOrder(id, r.order!.id)).toThrow(/already cancelled/);
  });

  it('fills a marketable limit immediately as taker', async () => {
    const { ex, id } = setup();
    const r = await ex.placeOrder(id, { market: 'BTC', side: 'long', type: 'limit', limitPrice: 101_000, sizeUsd: 1_000, leverage: 5 });
    expect(r.order).toBeNull();
    expect(r.trade?.liquidity).toBe('taker');
  });

  it("cannot cancel another account's order", async () => {
    const { ex, id } = setup();
    const other = ex.createAccount('other').account;
    const r = await ex.placeOrder(id, { market: 'SOL', side: 'long', type: 'limit', limitPrice: 150, sizeUsd: 500 });
    expect(() => ex.cancelOrder(other.id, r.order!.id)).toThrow(/not found/i);
  });
});

describe('integrity', () => {
  it('rolls back a failed order without partial writes', async () => {
    const { ex, id } = setup({ maxOpenPositions: 1 });
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 1_000 });
    const before = await ex.accountView(id);
    await expect(ex.placeOrder(id, { market: 'SOL', side: 'long', sizeUsd: 500 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(await ex.accountView(id)).toEqual(before);
  });

  it('reset restores the starting state', async () => {
    const { ex, id } = setup();
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 5_000 });
    ex.resetAccount(id);
    const v = await ex.accountView(id);
    expect(v.available).toBe(10_000);
    expect(v.positions).toHaveLength(0);
    expect(ex.trades(id)).toHaveLength(0);
  });

  it('ranks the leaderboard by equity', async () => {
    const { ex, feed, id } = setup();
    const b = ex.createAccount('bear').account;
    await ex.placeOrder(id, { market: 'BTC', side: 'long', sizeUsd: 10_000, leverage: 5 });
    await ex.placeOrder(b.id, { market: 'BTC', side: 'short', sizeUsd: 10_000, leverage: 5 });
    feed.prices.BTC = 105_000;
    const lb = await ex.leaderboard();
    expect(lb.map((e) => e.name)).toEqual(['tester', 'bear']);
    expect(lb[0]!.rank).toBe(1);
    expect(lb[0]).not.toHaveProperty('id');
  });
});
