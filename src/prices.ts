import { ExchangeError, type Book, type Candle, type Market, type MarketStats, type PriceFeed } from './types.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
export const CANDLE_INTERVALS = Object.keys(INTERVAL_MS);

interface HlCtx {
  markPx: string; oraclePx: string; funding: string; premium?: string | null;
  openInterest: string; dayNtlVlm: string; prevDayPx: string;
}

interface HlMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[];
}

/** Live prices from Hyperliquid's public info API. No key, no account. */
export class HyperliquidFeed implements PriceFeed {
  private ctxCache: { at: number; value: { markets: Market[]; stats: Record<string, MarketStats> } } | null = null;

  constructor(
    private readonly url = INFO_URL,
    private readonly midTtlMs = 1_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post<T>(body: unknown): Promise<T> {
    let lastError: unknown;
    const doFetch = this.fetchImpl;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await doFetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) return (await res.json()) as T;
        lastError = new Error(`price source returned HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    throw new ExchangeError('price_unavailable', `Price source unreachable: ${(lastError as Error).message}`);
  }

  private async snapshot(): Promise<{ markets: Market[]; stats: Record<string, MarketStats> }> {
    if (this.ctxCache && Date.now() - this.ctxCache.at < this.midTtlMs) return this.ctxCache.value;
    const [meta, ctxs] = await this.post<[HlMeta, HlCtx[]]>({ type: 'metaAndAssetCtxs' });
    const markets: Market[] = [];
    const stats: Record<string, MarketStats> = {};
    meta.universe.forEach((u, i) => {
      const c = ctxs[i];
      if (!c || u.isDelisted) return;
      const markPx = Number(c.markPx);
      if (!(markPx > 0)) return;
      markets.push({ name: u.name, maxLeverage: u.maxLeverage, sizeDecimals: u.szDecimals });
      stats[u.name] = {
        market: u.name, markPx, oraclePx: Number(c.oraclePx), funding: Number(c.funding), premium: Number(c.premium ?? 0),
        openInterest: Number(c.openInterest), dayNtlVlm: Number(c.dayNtlVlm), prevDayPx: Number(c.prevDayPx), maxLeverage: u.maxLeverage,
      };
    });
    const value = { markets, stats };
    this.ctxCache = { at: Date.now(), value };
    return value;
  }

  async markets(): Promise<Market[]> { return (await this.snapshot()).markets; }

  async stats(): Promise<Record<string, MarketStats>> { return (await this.snapshot()).stats; }

  async mids(): Promise<Record<string, number>> {
    const { stats } = await this.snapshot();
    return Object.fromEntries(Object.values(stats).map((s) => [s.market, s.markPx]));
  }

  async book(market: string): Promise<Book> {
    const res = await this.post<{ levels: { px: string; sz: string }[][] }>({ type: 'l2Book', coin: market });
    const side = (l: { px: string; sz: string }[] = []) => l.map((x) => [Number(x.px), Number(x.sz)] as [number, number]);
    return { bids: side(res.levels[0]), asks: side(res.levels[1]) };
  }

  async candles(market: string, interval: string, count: number): Promise<Candle[]> {
    const step = INTERVAL_MS[interval];
    if (!step) throw new ExchangeError('invalid_request', `interval must be one of ${CANDLE_INTERVALS.join(', ')}`);
    const endTime = Date.now();
    const rows = await this.post<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({
      type: 'candleSnapshot',
      req: { coin: market, interval, startTime: endTime - step * count, endTime },
    });
    return rows.map((r) => ({ time: r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  }
}
