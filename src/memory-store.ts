import type { Store } from './store.js';
import type { Account, Order, Position, Trade } from './types.js';

export interface MemorySnapshot {
  accounts: [Account, string][];
  positions: Position[];
  orders: Order[];
  trades: Trade[];
}

const MAX_TRADES_PER_ACCOUNT = 5_000;

/** In-process store. Serializable, so a browser can persist it to localStorage. */
export class MemoryStore implements Store {
  private accounts = new Map<string, { account: Account; keyHash: string }>();
  private positionMap = new Map<string, Position>();
  private orderMap = new Map<string, Order>();
  private tradeList: Trade[] = [];

  constructor(snapshot?: MemorySnapshot) {
    if (snapshot) this.load(snapshot);
  }

  private load(s: MemorySnapshot) {
    this.accounts = new Map(s.accounts.map(([account, keyHash]) => [account.id, { account, keyHash }]));
    this.positionMap = new Map(s.positions.map((p) => [`${p.accountId}:${p.market}`, p]));
    this.orderMap = new Map(s.orders.map((o) => [o.id, o]));
    this.tradeList = s.trades;
  }

  snapshot(): MemorySnapshot {
    return structuredClone({
      accounts: [...this.accounts.values()].map((e) => [e.account, e.keyHash] as [Account, string]),
      positions: [...this.positionMap.values()],
      orders: [...this.orderMap.values()],
      trades: this.tradeList,
    });
  }

  transaction<T>(fn: () => T): T {
    const before = this.snapshot();
    try {
      return fn();
    } catch (err) {
      this.load(before);
      throw err;
    }
  }

  close() {}

  insertAccount(a: Account, keyHash: string) { this.accounts.set(a.id, { account: { ...a }, keyHash }); }
  saveAccount(a: Account) {
    const e = this.accounts.get(a.id);
    if (e) e.account = { ...a };
  }
  accountByKeyHash(hash: string) {
    for (const e of this.accounts.values()) if (e.keyHash === hash) return { ...e.account };
    return null;
  }
  account(id: string) {
    const e = this.accounts.get(id);
    return e ? { ...e.account } : null;
  }
  allAccounts() { return [...this.accounts.values()].map((e) => ({ ...e.account })); }
  accountCount() { return this.accounts.size; }

  position(accountId: string, market: string) {
    const p = this.positionMap.get(`${accountId}:${market}`);
    return p ? { ...p } : null;
  }
  positions(accountId: string) {
    return [...this.positionMap.values()].filter((p) => p.accountId === accountId).sort((a, b) => a.openedAt - b.openedAt).map((p) => ({ ...p }));
  }
  allPositions() { return [...this.positionMap.values()].map((p) => ({ ...p })); }
  savePosition(p: Position) { this.positionMap.set(`${p.accountId}:${p.market}`, { ...p }); }
  deletePosition(accountId: string, market: string) { this.positionMap.delete(`${accountId}:${market}`); }

  saveOrder(o: Order) { this.orderMap.set(o.id, { ...o }); }
  order(id: string) {
    const o = this.orderMap.get(id);
    return o ? { ...o } : null;
  }
  openOrders(accountId?: string) {
    return [...this.orderMap.values()]
      .filter((o) => o.status === 'open' && (!accountId || o.accountId === accountId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => ({ ...o }));
  }

  insertTrade(t: Trade) {
    this.tradeList.push({ ...t });
    if (this.tradeList.length > MAX_TRADES_PER_ACCOUNT * Math.max(1, this.accounts.size)) this.tradeList.splice(0, 500);
  }
  trades(accountId: string, limit: number) {
    const out: Trade[] = [];
    for (let i = this.tradeList.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.tradeList[i]!;
      if (t.accountId === accountId) out.push({ ...t });
    }
    return out;
  }

  resetAccount(id: string, balance: number) {
    for (const k of [...this.positionMap.keys()]) if (k.startsWith(`${id}:`)) this.positionMap.delete(k);
    for (const [k, o] of this.orderMap) if (o.accountId === id) this.orderMap.delete(k);
    this.tradeList = this.tradeList.filter((t) => t.accountId !== id);
    const e = this.accounts.get(id);
    if (e) e.account = { ...e.account, balance, startingBalance: balance, realizedPnl: 0, feesPaid: 0, tradeCount: 0, liquidations: 0, fundingPaid: 0 };
  }
}
