import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Account, Order, Position, Trade } from './types.js';

type Row = Record<string, unknown>;

// Loaded at runtime because bundlers strip the `node:` prefix from `node:sqlite`, which then fails to resolve.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  balance REAL NOT NULL, starting_balance REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0,
  fees_paid REAL NOT NULL DEFAULT 0, trade_count INTEGER NOT NULL DEFAULT 0,
  liquidations INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  account_id TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL,
  entry_price REAL NOT NULL, margin REAL NOT NULL, leverage REAL NOT NULL,
  stop_loss REAL, take_profit REAL, opened_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, market)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL,
  type TEXT NOT NULL, size REAL NOT NULL, limit_price REAL NOT NULL, leverage REAL NOT NULL,
  reduce_only INTEGER NOT NULL, stop_loss REAL, take_profit REAL, reserved_margin REAL NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_open ON orders (status, market);
CREATE INDEX IF NOT EXISTS orders_account ON orders (account_id, status);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL,
  kind TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL,
  realized_pnl REAL NOT NULL, liquidity TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_account ON trades (account_id, created_at DESC);
`;

const toAccount = (r: Row): Account => ({
  id: r.id as string, name: r.name as string, balance: r.balance as number,
  startingBalance: r.starting_balance as number, realizedPnl: r.realized_pnl as number,
  feesPaid: r.fees_paid as number, tradeCount: r.trade_count as number,
  liquidations: r.liquidations as number, createdAt: r.created_at as number,
});
const toPosition = (r: Row): Position => ({
  accountId: r.account_id as string, market: r.market as string, side: r.side as Position['side'],
  size: r.size as number, entryPrice: r.entry_price as number, margin: r.margin as number,
  leverage: r.leverage as number, stopLoss: r.stop_loss as number | null,
  takeProfit: r.take_profit as number | null, openedAt: r.opened_at as number,
});
const toOrder = (r: Row): Order => ({
  id: r.id as string, accountId: r.account_id as string, market: r.market as string,
  side: r.side as Order['side'], type: r.type as Order['type'], size: r.size as number,
  limitPrice: r.limit_price as number, leverage: r.leverage as number, reduceOnly: !!r.reduce_only,
  stopLoss: r.stop_loss as number | null, takeProfit: r.take_profit as number | null,
  reservedMargin: r.reserved_margin as number, status: r.status as Order['status'],
  createdAt: r.created_at as number,
});
const toTrade = (r: Row): Trade => ({
  id: r.id as string, accountId: r.account_id as string, market: r.market as string,
  side: r.side as Trade['side'], kind: r.kind as Trade['kind'], size: r.size as number,
  price: r.price as number, fee: r.fee as number, realizedPnl: r.realized_pnl as number,
  liquidity: r.liquidity as Trade['liquidity'], createdAt: r.created_at as number,
});

/** SQLite persistence on Node's built-in `node:sqlite`. Single process, synchronous, transactional. */
export class Store {
  readonly db: DatabaseSyncType;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  /** Run `fn` atomically. Any throw rolls every write back. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() { this.db.close(); }

  insertAccount(a: Account, keyHash: string) {
    this.db.prepare(`INSERT INTO accounts (id,name,key_hash,balance,starting_balance,realized_pnl,fees_paid,trade_count,liquidations,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(a.id, a.name, keyHash, a.balance, a.startingBalance, a.realizedPnl, a.feesPaid, a.tradeCount, a.liquidations, a.createdAt);
  }
  saveAccount(a: Account) {
    this.db.prepare(`UPDATE accounts SET name=?,balance=?,realized_pnl=?,fees_paid=?,trade_count=?,liquidations=? WHERE id=?`)
      .run(a.name, a.balance, a.realizedPnl, a.feesPaid, a.tradeCount, a.liquidations, a.id);
  }
  accountByKeyHash(h: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE key_hash=?').get(h) as Row | undefined;
    return r ? toAccount(r) : null;
  }
  account(id: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }
  allAccounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts').all() as Row[]).map(toAccount);
  }
  accountCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  }

  position(accountId: string, market: string): Position | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE account_id=? AND market=?').get(accountId, market) as Row | undefined;
    return r ? toPosition(r) : null;
  }
  positions(accountId: string): Position[] {
    return (this.db.prepare('SELECT * FROM positions WHERE account_id=? ORDER BY opened_at').all(accountId) as Row[]).map(toPosition);
  }
  allPositions(): Position[] {
    return (this.db.prepare('SELECT * FROM positions').all() as Row[]).map(toPosition);
  }
  savePosition(p: Position) {
    this.db.prepare(`INSERT INTO positions (account_id,market,side,size,entry_price,margin,leverage,stop_loss,take_profit,opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,market) DO UPDATE SET side=excluded.side,size=excluded.size,entry_price=excluded.entry_price,
        margin=excluded.margin,leverage=excluded.leverage,stop_loss=excluded.stop_loss,take_profit=excluded.take_profit`)
      .run(p.accountId, p.market, p.side, p.size, p.entryPrice, p.margin, p.leverage, p.stopLoss, p.takeProfit, p.openedAt);
  }
  deletePosition(accountId: string, market: string) {
    this.db.prepare('DELETE FROM positions WHERE account_id=? AND market=?').run(accountId, market);
  }

  saveOrder(o: Order) {
    this.db.prepare(`INSERT INTO orders (id,account_id,market,side,type,size,limit_price,leverage,reduce_only,stop_loss,take_profit,reserved_margin,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,reserved_margin=excluded.reserved_margin`)
      .run(o.id, o.accountId, o.market, o.side, o.type, o.size, o.limitPrice, o.leverage, o.reduceOnly ? 1 : 0, o.stopLoss, o.takeProfit, o.reservedMargin, o.status, o.createdAt);
  }
  order(id: string): Order | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Row | undefined;
    return r ? toOrder(r) : null;
  }
  openOrders(accountId?: string): Order[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM orders WHERE status='open' AND account_id=? ORDER BY created_at").all(accountId)
      : this.db.prepare("SELECT * FROM orders WHERE status='open' ORDER BY created_at").all();
    return (rows as Row[]).map(toOrder);
  }

  insertTrade(t: Trade) {
    this.db.prepare(`INSERT INTO trades (id,account_id,market,side,kind,size,price,fee,realized_pnl,liquidity,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(t.id, t.accountId, t.market, t.side, t.kind, t.size, t.price, t.fee, t.realizedPnl, t.liquidity, t.createdAt);
  }
  trades(accountId: string, limit: number): Trade[] {
    return (this.db.prepare('SELECT * FROM trades WHERE account_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(accountId, limit) as Row[]).map(toTrade);
  }

  /** Wipe an account back to its starting state, keeping its identity and key. */
  resetAccount(id: string, balance: number) {
    this.db.prepare('DELETE FROM positions WHERE account_id=?').run(id);
    this.db.prepare('DELETE FROM orders WHERE account_id=?').run(id);
    this.db.prepare('DELETE FROM trades WHERE account_id=?').run(id);
    this.db.prepare('UPDATE accounts SET balance=?,starting_balance=?,realized_pnl=0,fees_paid=0,trade_count=0,liquidations=0 WHERE id=?').run(balance, balance, id);
  }
}
