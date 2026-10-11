import { Exchange } from '../../src/exchange.js';
import type { AccountView, SweepEvent } from '../../src/exchange.js';
import { MemoryStore } from '../../src/memory-store.js';
import type { MemorySnapshot } from '../../src/memory-store.js';
import type { MarketStats } from '../../src/types.js';
import { feed } from './hl.js';

const KEY = 'paper-exchange:v1';
const SECRET = 'paper-exchange:local-key';

function load(): MemorySnapshot | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MemorySnapshot) : undefined;
  } catch {
    return undefined;
  }
}

const store = new MemoryStore(load());
export const exchange = new Exchange(store, feed);

let accountId: string | null = null;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store.snapshot()));
  } catch {
    /* storage full or blocked: the session still works, it just will not survive a reload */
  }
}

/** Sign in with the key stored in this browser, or open a fresh $10,000 account. */
export function boot(): string {
  const key = localStorage.getItem(SECRET);
  if (key) {
    try {
      accountId = exchange.authenticate(key).id;
      return accountId;
    } catch {
      /* stored key no longer matches the stored data: start clean below */
    }
  }
  const { account, apiKey } = exchange.createAccount('Paper Trader');
  localStorage.setItem(SECRET, apiKey);
  accountId = account.id;
  persist();
  return account.id;
}

export const id = () => accountId ?? boot();

export function reset() {
  exchange.resetAccount(id());
  persist();
  emit();
}

export function exportBackup(): string {
  return JSON.stringify({ app: 'paper-exchange', version: 1, key: localStorage.getItem(SECRET), data: store.snapshot() });
}

export function importBackup(text: string) {
  const parsed = JSON.parse(text);
  if (parsed?.app !== 'paper-exchange' || !parsed.key || !parsed.data) throw new Error('This file is not a Paper Exchange backup.');
  localStorage.setItem(KEY, JSON.stringify(parsed.data));
  localStorage.setItem(SECRET, parsed.key);
  location.reload();
}

type Listener = () => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };
export function emit() { listeners.forEach((fn) => fn()); }

/** Run a mutating action, persist, and refresh every subscriber. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    persist();
    try { account = await exchange.accountView(id()); } catch { /* the next tick refreshes it */ }
    emit();
  }
}

export const events: (SweepEvent & { at: number })[] = [];
const toastSinks = new Set<(e: SweepEvent) => void>();
export const onEvent = (fn: (e: SweepEvent) => void) => { toastSinks.add(fn); return () => toastSinks.delete(fn); };

export let stats: Record<string, MarketStats> = {};
export let statsAt = 0;
export let account: AccountView | null = null;
export let feedError: string | null = null;

/** Poll market data, sweep triggers for this account and refresh the account view. */
export async function tick() {
  try {
    stats = await feed.stats!();
    statsAt = Date.now();
    const swept = (await exchange.sweep()).filter((e) => e.accountId === id());
    for (const e of swept) {
      events.unshift({ ...e, at: Date.now() });
      toastSinks.forEach((fn) => fn(e));
    }
    account = await exchange.accountView(id());
    feedError = null;
    if (swept.length) persist();
  } catch (err) {
    feedError = err instanceof Error ? err.message : 'Market data unavailable.';
  }
  emit();
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startTicking() {
  if (timer) return;
  void tick();
  timer = setInterval(() => { if (!document.hidden) void tick(); }, 2_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void tick(); });
}

/** Recent funding payments are folded into account.fundingPaid; the journal lives in trades. */
export const trades = (limit = 500) => exchange.trades(id(), limit);
