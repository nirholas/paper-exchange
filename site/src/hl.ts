import { HyperliquidFeed } from '../../src/prices.js';
import type { Book } from '../../src/types.js';

export const feed = new HyperliquidFeed();
const INFO = 'https://api.hyperliquid.xyz/info';
const WS = 'wss://api.hyperliquid.xyz/ws';

async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid responded ${res.status}`);
  return res.json() as Promise<T>;
}

export interface VenueFunding {
  venue: 'HlPerp' | 'BinPerp' | 'BybitPerp';
  /** Rate per hour, normalised from the venue's own funding interval. */
  hourly: number;
  intervalHours: number;
  next: number;
}

export async function predictedFundings(): Promise<Record<string, VenueFunding[]>> {
  const rows = await info<[string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null][]][]>({ type: 'predictedFundings' });
  const out: Record<string, VenueFunding[]> = {};
  for (const [coin, venues] of rows) {
    out[coin] = venues.filter((x): x is [string, NonNullable<typeof x[1]>] => x[1] != null).map(([venue, v]) => {
      const intervalHours = v.fundingIntervalHours ?? (venue === 'HlPerp' ? 1 : 8);
      return { venue: venue as VenueFunding['venue'], hourly: Number(v.fundingRate) / intervalHours, intervalHours, next: v.nextFundingTime };
    });
  }
  return out;
}

export interface FundingPoint { time: number; rate: number; premium: number }

export async function fundingHistory(coin: string, days = 7): Promise<FundingPoint[]> {
  const rows = await info<{ time: number; fundingRate: string; premium: string }[]>({ type: 'fundingHistory', coin, startTime: Date.now() - days * 86_400_000 });
  return rows.map((r) => ({ time: r.time, rate: Number(r.fundingRate), premium: Number(r.premium) }));
}

export interface PublicTrade { px: number; sz: number; side: 'B' | 'A'; time: number; tid: number }

export async function recentTrades(coin: string): Promise<PublicTrade[]> {
  const rows = await info<{ px: string; sz: string; side: 'B' | 'A'; time: number; tid: number }[]>({ type: 'recentTrades', coin });
  return rows.map((r) => ({ px: +r.px, sz: +r.sz, side: r.side, time: r.time, tid: r.tid })).reverse();
}

export async function l2Book(coin: string): Promise<Book> {
  return feed.book!(coin);
}

type Handler = (data: any) => void;

/** One shared socket with automatic reconnect and resubscribe. */
class Socket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: unknown; handlers: Set<Handler> }>();
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  status: 'connecting' | 'live' | 'down' = 'connecting';
  onStatus: (s: Socket['status']) => void = () => {};

  private connect() {
    this.ws = new WebSocket(WS);
    this.ws.onopen = () => {
      this.retry = 0;
      this.setStatus('live');
      for (const { sub } of this.subs.values()) this.send({ method: 'subscribe', subscription: sub });
      this.ping = setInterval(() => this.send({ method: 'ping' }), 30_000);
    };
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (!msg.channel || msg.channel === 'pong' || msg.channel === 'subscriptionResponse') return;
      for (const [key, entry] of this.subs) if (key.startsWith(`${msg.channel}:`) && this.matches(key, msg)) entry.handlers.forEach((h) => h(msg.data));
    };
    this.ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.setStatus('down');
      setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** this.retry++));
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private matches(key: string, msg: { channel: string; data: any }): boolean {
    const want = key.slice(msg.channel.length + 1);
    const d = msg.data;
    if (msg.channel === 'trades') return Array.isArray(d) && d[0]?.coin === want.split('|')[0];
    if (msg.channel === 'l2Book') return d.coin === want.split('|')[0];
    if (msg.channel === 'candle') return `${d.s}|${d.i}` === want;
    return true;
  }

  private setStatus(s: Socket['status']) { this.status = s; this.onStatus(s); }

  private send(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  start() { if (!this.ws) this.connect(); }

  subscribe(sub: { type: string; coin: string; interval?: string }, handler: Handler): () => void {
    this.start();
    const key = `${sub.type}:${sub.coin}${sub.interval ? `|${sub.interval}` : ''}`;
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.subs.set(key, entry);
      this.send({ method: 'subscribe', subscription: sub });
    }
    entry.handlers.add(handler);
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (!e.handlers.size) {
        this.subs.delete(key);
        this.send({ method: 'unsubscribe', subscription: sub });
      }
    };
  }
}

export const socket = new Socket();
