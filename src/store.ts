import type { Account, Order, Position, Trade } from './types.js';

/** Persistence the exchange engine runs on. SqliteStore backs servers, MemoryStore backs browsers and tests. */
export interface Store {
  /** Run `fn` atomically. Any throw rolls every write back. */
  transaction<T>(fn: () => T): T;
  close(): void;

  insertAccount(a: Account, keyHash: string): void;
  saveAccount(a: Account): void;
  accountByKeyHash(hash: string): Account | null;
  account(id: string): Account | null;
  allAccounts(): Account[];
  accountCount(): number;

  position(accountId: string, market: string): Position | null;
  positions(accountId: string): Position[];
  allPositions(): Position[];
  savePosition(p: Position): void;
  deletePosition(accountId: string, market: string): void;

  saveOrder(o: Order): void;
  order(id: string): Order | null;
  openOrders(accountId?: string): Order[];

  insertTrade(t: Trade): void;
  trades(accountId: string, limit: number): Trade[];

  /** Wipe an account back to its starting state, keeping its identity and key. */
  resetAccount(id: string, balance: number): void;
}
