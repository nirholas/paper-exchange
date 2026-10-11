import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fee, isLiquidated, liquidationPrice, marketFillPrice, roundSize, unrealizedPnl, usd, wouldTriggerStop } from './math.js';
import { Store } from './store.js';
import {
  DEFAULT_CONFIG, ExchangeError,
  type Account, type Candle, type Config, type Market, type Order, type OrderType, type Position, type PriceFeed, type Side, type Trade, type TradeKind,
} from './types.js';

export interface OrderRequest {
  market: string;
  /** Direction of exposure. `long` buys, `short` sells. An order opposite an open position reduces it. */
  side: Side;
  /** Order size as notional in USD. */
  sizeUsd: number;
  leverage?: number;
  type?: OrderType;
  limitPrice?: number;
  reduceOnly?: boolean;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface Quote {
  market: string;
  side: Side;
  type: OrderType;
  action: 'open' | 'add' | 'reduce' | 'close';
  /** True when a limit order is not marketable and would sit on the book. */
  rests: boolean;
  midPrice: number;
  fillPrice: number;
  size: number;
  notional: number;
  leverage: number;
  marginRequired: number;
  fee: number;
  liquidationPrice: number | null;
  balanceAfter: number;
}

export interface PositionView {
  market: string;
  side: Side;
  size: number;
  entryPrice: number;
  markPrice: number;
  notional: number;
  margin: number;
  leverage: number;
  unrealizedPnl: number;
  returnOnMarginPct: number;
  liquidationPrice: number;
  distanceToLiquidationPct: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
}

export interface AccountView {
  id: string;
  name: string;
  /** Cash free to open new positions. */
  available: number;
  marginInPositions: number;
  reservedInOrders: number;
  unrealizedPnl: number;
  equity: number;
  startingBalance: number;
  totalReturnPct: number;
  realizedPnl: number;
  feesPaid: number;
  tradeCount: number;
  liquidations: number;
  positions: PositionView[];
  openOrders: Order[];
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  equity: number;
  totalReturnPct: number;
  tradeCount: number;
  liquidations: number;
}

export interface SweepEvent {
  accountId: string;
  kind: TradeKind | 'limit_fill' | 'order_cancelled';
  market: string;
  detail: string;
}

interface Plan extends Quote {
  closing: boolean;
  position: Position | null;
  reserve: number;
}

const EPS = 1e-9;
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const fail = (code: ConstructorParameters<typeof ExchangeError>[0], msg: string): never => {
  throw new ExchangeError(code, msg);
};

export class Exchange {
  readonly cfg: Config;

  constructor(
    readonly store: Store,
    readonly feed: PriceFeed,
    cfg: Partial<Config> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  // ---------- accounts ----------

  createAccount(name: string): { account: Account; apiKey: string } {
    const clean = name.trim().slice(0, 40);
    if (!clean) fail('invalid_request', 'name is required');
    const apiKey = `pe_${randomBytes(32).toString('base64url')}`;
    const account: Account = {
      id: randomUUID(), name: clean, balance: this.cfg.startingBalance, startingBalance: this.cfg.startingBalance,
      realizedPnl: 0, feesPaid: 0, tradeCount: 0, liquidations: 0, createdAt: this.now(),
    };
    this.store.insertAccount(account, hashKey(apiKey));
    return { account, apiKey };
  }

  authenticate(apiKey: string): Account {
    return this.store.accountByKeyHash(hashKey(apiKey)) ?? fail('unauthorized', 'Unknown API key.');
  }

  resetAccount(accountId: string): Account {
    return this.store.transaction(() => {
      this.requireAccount(accountId);
      this.store.resetAccount(accountId, this.cfg.startingBalance);
      return this.requireAccount(accountId);
    });
  }

  private requireAccount(id: string): Account {
    return this.store.account(id) ?? fail('not_found', 'Account not found.');
  }

  // ---------- market data ----------

  markets(): Promise<Market[]> { return this.feed.markets(); }
  candles(market: string, interval: string, count: number): Promise<Candle[]> { return this.feed.candles(market, interval, count); }

  async price(market: string): Promise<number> {
    const m = await this.requireMarket(market);
    const px = (await this.feed.mids())[m.name];
    return px ?? fail('price_unavailable', `No live price for ${m.name} right now.`);
  }

  private async requireMarket(name: string): Promise<Market> {
    const wanted = name.trim().toUpperCase();
    const markets = await this.feed.markets();
    return markets.find((m) => m.name.toUpperCase() === wanted) ?? fail('unknown_market', `Unknown market "${name}". Call list_markets for valid names.`);
  }

  // ---------- planning ----------

  private async plan(account: Account, req: OrderRequest): Promise<Plan> {
    const market = await this.requireMarket(req.market);
    const mid = await this.price(market.name);
    const type = req.type ?? 'market';
    if (!(req.sizeUsd > 0) || !Number.isFinite(req.sizeUsd)) fail('invalid_request', 'sizeUsd must be a positive number.');
    if (type === 'limit' && !(req.limitPrice && req.limitPrice > 0)) fail('invalid_request', 'limit orders need a positive limitPrice.');

    const position = this.store.position(account.id, market.name);
    const closing = !!position && position.side !== req.side;
    if (req.reduceOnly && !closing) fail('no_position', `reduceOnly needs an open ${req.side === 'long' ? 'short' : 'long'} position in ${market.name}.`);

    const leverage = position ? position.leverage : (req.leverage ?? Math.min(5, market.maxLeverage));
    if (!(leverage >= 1) || leverage > market.maxLeverage) fail('invalid_request', `leverage must be between 1 and ${market.maxLeverage} for ${market.name}.`);

    const refPrice = type === 'limit' ? req.limitPrice! : mid;
    let size = roundSize(req.sizeUsd / refPrice, market.sizeDecimals);
    if (closing && position) {
      if (size > position.size + EPS) size = position.size;
      if (position.size - size < 10 ** -market.sizeDecimals) size = position.size;
    }
    if (!(size > 0)) fail('invalid_request', `sizeUsd is too small for ${market.name}: minimum order is about $${(refPrice * 10 ** -market.sizeDecimals).toFixed(2)}.`);

    const takerPrice = marketFillPrice(mid, req.side, closing, size * mid, this.cfg);
    const marketable = type === 'market' || (req.side === 'long' ? takerPrice <= req.limitPrice! : takerPrice >= req.limitPrice!);
    const fillPrice = marketable ? takerPrice : req.limitPrice!;
    const notional = usd(size * fillPrice);
    const bps = marketable ? this.cfg.takerFeeBps : this.cfg.makerFeeBps;
    const orderFee = fee(notional, bps);
    const marginRequired = closing ? 0 : usd(notional / leverage);

    let newLiq: number | null = null;
    if (!closing) {
      const entry = position ? (position.size * position.entryPrice + size * fillPrice) / (position.size + size) : fillPrice;
      newLiq = liquidationPrice(req.side, entry, leverage, this.cfg.maintenanceMarginRate);
    } else if (position && size < position.size - EPS) {
      newLiq = liquidationPrice(position.side, position.entryPrice, position.leverage, this.cfg.maintenanceMarginRate);
    }

    const reserve = !marketable && !closing ? marginRequired : 0;
    const cashOut = marketable ? marginRequired + orderFee : reserve;
    let balanceAfter = account.balance - cashOut;
    if (closing && position) {
      const pnl = unrealizedPnl(position.side, position.entryPrice, fillPrice, size);
      balanceAfter = account.balance + Math.max(0, position.margin * (size / position.size) + pnl - orderFee);
    }
    if (!closing && cashOut > account.balance + EPS) {
      fail('insufficient_balance', `Need $${cashOut.toFixed(2)} (margin $${marginRequired.toFixed(2)} + fee $${orderFee.toFixed(2)}), have $${account.balance.toFixed(2)} available. Lower sizeUsd or raise leverage.`);
    }

    this.validateProtection(req.side, closing ? null : fillPrice, req.stopLoss ?? null, req.takeProfit ?? null);

    const action = closing ? (position && size >= position.size - EPS ? 'close' : 'reduce') : position ? 'add' : 'open';
    return {
      market: market.name, side: req.side, type, action, rests: !marketable, midPrice: mid, fillPrice, size, notional, leverage,
      marginRequired, fee: orderFee, liquidationPrice: newLiq, balanceAfter: usd(balanceAfter), closing, position, reserve,
    };
  }

  private validateProtection(side: Side, ref: number | null, stopLoss: number | null, takeProfit: number | null) {
    if (ref === null) return;
    if (stopLoss !== null && (side === 'long' ? stopLoss >= ref : stopLoss <= ref)) fail('invalid_request', `stopLoss must be ${side === 'long' ? 'below' : 'above'} the entry price ${ref.toFixed(4)} for a ${side}.`);
    if (takeProfit !== null && (side === 'long' ? takeProfit <= ref : takeProfit >= ref)) fail('invalid_request', `takeProfit must be ${side === 'long' ? 'above' : 'below'} the entry price ${ref.toFixed(4)} for a ${side}.`);
  }

  /** Price an order exactly as placeOrder would, without touching any state. */
  async quote(accountId: string, req: OrderRequest): Promise<Quote> {
    const { closing: _c, position: _p, reserve: _r, ...quote } = await this.plan(this.requireAccount(accountId), req);
    return quote;
  }

  // ---------- trading ----------

  async placeOrder(accountId: string, req: OrderRequest): Promise<{ order: Order | null; trade: Trade | null; position: PositionView | null; quote: Quote }> {
    const account0 = this.requireAccount(accountId);
    const plan = await this.plan(account0, req);
    const mids = await this.feed.mids();
    const { closing: _c, position: _p, reserve: _r, ...quote } = plan;

    return this.store.transaction(() => {
      const account = this.requireAccount(accountId);
      if (plan.rests) {
        if (this.store.openOrders(accountId).length >= this.cfg.maxOpenOrders) fail('limit_exceeded', `At most ${this.cfg.maxOpenOrders} open orders per account.`);
        if (account.balance + EPS < plan.reserve) fail('insufficient_balance', `Need $${plan.reserve.toFixed(2)} of margin to rest this order, have $${account.balance.toFixed(2)}.`);
        const order: Order = {
          id: randomUUID(), accountId, market: plan.market, side: plan.side, type: 'limit', size: plan.size, limitPrice: plan.fillPrice,
          leverage: plan.leverage, reduceOnly: !!req.reduceOnly, stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null,
          reservedMargin: plan.reserve, status: 'open', createdAt: this.now(),
        };
        account.balance = usd(account.balance - plan.reserve);
        this.store.saveAccount(account);
        this.store.saveOrder(order);
        return { order, trade: null, position: null, quote };
      }
      if (!plan.closing && !plan.position && this.store.positions(accountId).length >= this.cfg.maxOpenPositions) {
        fail('limit_exceeded', `At most ${this.cfg.maxOpenPositions} open positions per account.`);
      }
      const trade = this.applyFill(account, plan.market, plan.side, plan.size, plan.fillPrice, plan.leverage, 'taker', 0, req.stopLoss ?? null, req.takeProfit ?? null);
      const pos = this.store.position(accountId, plan.market);
      return { order: null, trade, position: pos ? this.positionView(pos, mids[plan.market] ?? plan.midPrice) : null, quote };
    });
  }

  async closePosition(accountId: string, market: string, fraction = 1): Promise<{ trade: Trade; position: PositionView | null }> {
    if (!(fraction > 0 && fraction <= 1)) fail('invalid_request', 'fraction must be greater than 0 and at most 1.');
    const m = await this.requireMarket(market);
    const pos = this.store.position(accountId, m.name) ?? fail('no_position', `No open ${m.name} position.`);
    const mid = await this.price(m.name);
    const sizeUsd = pos.size * fraction * mid;
    const res = await this.placeOrder(accountId, { market: m.name, side: pos.side === 'long' ? 'short' : 'long', sizeUsd, reduceOnly: true });
    return { trade: res.trade!, position: res.position };
  }

  async setProtection(accountId: string, market: string, p: { stopLoss?: number | null; takeProfit?: number | null }): Promise<PositionView> {
    const m = await this.requireMarket(market);
    const mid = await this.price(m.name);
    return this.store.transaction(() => {
      const pos = this.store.position(accountId, m.name) ?? fail('no_position', `No open ${m.name} position.`);
      const stopLoss = p.stopLoss === undefined ? pos.stopLoss : p.stopLoss;
      const takeProfit = p.takeProfit === undefined ? pos.takeProfit : p.takeProfit;
      this.validateProtection(pos.side, mid, stopLoss, takeProfit);
      const next = { ...pos, stopLoss, takeProfit };
      this.store.savePosition(next);
      return this.positionView(next, mid);
    });
  }

  cancelOrder(accountId: string, orderId: string): Order {
    return this.store.transaction(() => {
      const order = this.store.order(orderId);
      if (!order || order.accountId !== accountId) fail('not_found', 'Order not found.');
      if (order!.status !== 'open') fail('invalid_request', `Order is already ${order!.status}.`);
      return this.cancel(order!);
    });
  }

  private cancel(order: Order): Order {
    const account = this.requireAccount(order.accountId);
    account.balance = usd(account.balance + order.reservedMargin);
    this.store.saveAccount(account);
    const cancelled: Order = { ...order, status: 'cancelled', reservedMargin: 0 };
    this.store.saveOrder(cancelled);
    return cancelled;
  }

  /** Apply one fill to the books. Caller owns the transaction. */
  private applyFill(
    account: Account, market: string, side: Side, size: number, price: number, leverage: number,
    liquidity: 'taker' | 'maker', preReserved: number, stopLoss: number | null, takeProfit: number | null, kindOverride?: TradeKind,
  ): Trade {
    const pos = this.store.position(account.id, market);
    const notional = usd(size * price);
    const orderFee = fee(notional, liquidity === 'taker' ? this.cfg.takerFeeBps : this.cfg.makerFeeBps);
    let kind: TradeKind;
    let realized: number;

    if (pos && pos.side !== side) {
      if (size > pos.size + EPS) fail('invalid_request', 'Order is larger than the open position. Close it first, then open the other side.');
      const full = size >= pos.size - EPS;
      const used = full ? pos.size : size;
      const pnl = unrealizedPnl(pos.side, pos.entryPrice, price, used);
      const released = full ? pos.margin : pos.margin * (used / pos.size);
      account.balance = usd(account.balance + preReserved + Math.max(0, released + pnl - orderFee));
      realized = usd(pnl - orderFee);
      if (full) this.store.deletePosition(account.id, market);
      else this.store.savePosition({ ...pos, size: pos.size - used, margin: pos.margin - released });
      kind = kindOverride ?? (full ? 'close' : 'reduce');
    } else {
      const lev = pos ? pos.leverage : leverage;
      const margin = usd(notional / lev);
      if (margin + orderFee > account.balance + preReserved + EPS) {
        fail('insufficient_balance', `Need $${(margin + orderFee).toFixed(2)}, have $${(account.balance + preReserved).toFixed(2)}.`);
      }
      account.balance = usd(account.balance + preReserved - margin - orderFee);
      const total = (pos?.size ?? 0) + size;
      const entry = pos ? (pos.size * pos.entryPrice + size * price) / total : price;
      this.store.savePosition({
        accountId: account.id, market, side, size: total, entryPrice: entry, margin: (pos?.margin ?? 0) + margin, leverage: lev,
        stopLoss: stopLoss ?? pos?.stopLoss ?? null, takeProfit: takeProfit ?? pos?.takeProfit ?? null, openedAt: pos?.openedAt ?? this.now(),
      });
      realized = usd(-orderFee);
      kind = pos ? 'add' : 'open';
    }

    account.realizedPnl = usd(account.realizedPnl + realized);
    account.feesPaid = usd(account.feesPaid + orderFee);
    account.tradeCount += 1;
    this.store.saveAccount(account);
    const trade: Trade = { id: randomUUID(), accountId: account.id, market, side, kind, size, price, fee: orderFee, realizedPnl: realized, liquidity, createdAt: this.now() };
    this.store.insertTrade(trade);
    return trade;
  }

  // ---------- risk engine ----------

  /** Check every position and resting order against live prices. Call on a timer. */
  async sweep(): Promise<SweepEvent[]> {
    const mids = await this.feed.mids();
    const events: SweepEvent[] = [];

    for (const p of this.store.allPositions()) {
      const mark = mids[p.market];
      if (!mark) continue;
      try {
        this.store.transaction(() => {
          const pos = this.store.position(p.accountId, p.market);
          if (!pos) return;
          const account = this.requireAccount(pos.accountId);
          if (isLiquidated(pos, mark, this.cfg.maintenanceMarginRate)) {
            const pnl = unrealizedPnl(pos.side, pos.entryPrice, mark, pos.size);
            const liqFee = Math.min(usd(pos.size * mark * this.cfg.maintenanceMarginRate), Math.max(0, pos.margin + pnl));
            const proceeds = usd(Math.max(0, pos.margin + pnl - liqFee));
            account.balance = usd(account.balance + proceeds);
            account.realizedPnl = usd(account.realizedPnl + proceeds - pos.margin);
            account.feesPaid = usd(account.feesPaid + liqFee);
            account.liquidations += 1;
            account.tradeCount += 1;
            this.store.saveAccount(account);
            this.store.deletePosition(pos.accountId, pos.market);
            this.store.insertTrade({
              id: randomUUID(), accountId: pos.accountId, market: pos.market, side: pos.side === 'long' ? 'short' : 'long', kind: 'liquidation',
              size: pos.size, price: mark, fee: liqFee, realizedPnl: usd(proceeds - pos.margin), liquidity: 'taker', createdAt: this.now(),
            });
            events.push({ accountId: pos.accountId, kind: 'liquidation', market: pos.market, detail: `${pos.side} ${pos.market} liquidated at ${mark}` });
            return;
          }
          const trigger = wouldTriggerStop(pos.side, pos.stopLoss, pos.takeProfit, mark);
          if (trigger) {
            const closeSide: Side = pos.side === 'long' ? 'short' : 'long';
            const px = marketFillPrice(mark, closeSide, true, pos.size * mark, this.cfg);
            this.applyFill(account, pos.market, closeSide, pos.size, px, pos.leverage, 'taker', 0, null, null, trigger);
            events.push({ accountId: pos.accountId, kind: trigger, market: pos.market, detail: `${pos.side} ${pos.market} closed by ${trigger} at ${px}` });
          }
        });
      } catch (err) {
        events.push({ accountId: p.accountId, kind: 'order_cancelled', market: p.market, detail: `sweep error: ${(err as Error).message}` });
      }
    }

    for (const o of this.store.openOrders()) {
      const mark = mids[o.market];
      if (!mark) continue;
      const hit = o.side === 'long' ? mark <= o.limitPrice : mark >= o.limitPrice;
      if (!hit) continue;
      this.store.transaction(() => {
        const order = this.store.order(o.id);
        if (!order || order.status !== 'open') return;
        const account = this.requireAccount(order.accountId);
        try {
          this.applyFill(account, order.market, order.side, order.size, order.limitPrice, order.leverage, 'maker', order.reservedMargin, order.stopLoss, order.takeProfit);
          this.store.saveOrder({ ...order, status: 'filled', reservedMargin: 0 });
          events.push({ accountId: order.accountId, kind: 'limit_fill', market: order.market, detail: `${order.side} ${order.size} ${order.market} limit filled at ${order.limitPrice}` });
        } catch (err) {
          this.cancel(order);
          events.push({ accountId: order.accountId, kind: 'order_cancelled', market: order.market, detail: `limit order cancelled: ${(err as Error).message}` });
        }
      });
    }
    return events;
  }

  // ---------- views ----------

  positionView(p: Position, mark: number): PositionView {
    const pnl = unrealizedPnl(p.side, p.entryPrice, mark, p.size);
    const liq = liquidationPrice(p.side, p.entryPrice, p.leverage, this.cfg.maintenanceMarginRate);
    return {
      market: p.market, side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: mark, notional: usd(p.size * mark),
      margin: usd(p.margin), leverage: p.leverage, unrealizedPnl: usd(pnl), returnOnMarginPct: usd((pnl / p.margin) * 100),
      liquidationPrice: liq, distanceToLiquidationPct: usd((Math.abs(mark - liq) / mark) * 100),
      stopLoss: p.stopLoss, takeProfit: p.takeProfit, openedAt: p.openedAt,
    };
  }

  async accountView(accountId: string): Promise<AccountView> {
    const account = this.requireAccount(accountId);
    const mids = await this.feed.mids();
    return this.buildView(account, mids);
  }

  private buildView(account: Account, mids: Record<string, number>): AccountView {
    const positions = this.store.positions(account.id).map((p) => this.positionView(p, mids[p.market] ?? p.entryPrice));
    const openOrders = this.store.openOrders(account.id);
    const margin = positions.reduce((s, p) => s + p.margin, 0);
    const upnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const reserved = openOrders.reduce((s, o) => s + o.reservedMargin, 0);
    const equity = usd(account.balance + margin + upnl + reserved);
    return {
      id: account.id, name: account.name, available: usd(account.balance), marginInPositions: usd(margin), reservedInOrders: usd(reserved),
      unrealizedPnl: usd(upnl), equity, startingBalance: account.startingBalance,
      totalReturnPct: usd(((equity - account.startingBalance) / account.startingBalance) * 100),
      realizedPnl: account.realizedPnl, feesPaid: account.feesPaid, tradeCount: account.tradeCount, liquidations: account.liquidations,
      positions, openOrders,
    };
  }

  trades(accountId: string, limit = 50): Trade[] {
    return this.store.trades(accountId, Math.min(Math.max(1, limit), 500));
  }

  orders(accountId: string): Order[] { return this.store.openOrders(accountId); }

  async leaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const mids = await this.feed.mids();
    return this.store.allAccounts()
      .map((a) => this.buildView(a, mids))
      .sort((a, b) => b.equity - a.equity)
      .slice(0, Math.min(Math.max(1, limit), 100))
      .map((v, i) => ({ rank: i + 1, name: v.name, equity: v.equity, totalReturnPct: v.totalReturnPct, tradeCount: v.tradeCount, liquidations: v.liquidations }));
  }
}
