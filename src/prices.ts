import { ExchangeError, type Candle, type Market, type PriceFeed } from './types.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
export const CANDLE_INTERVALS = Object.keys(INTERVAL_MS);

interface HlMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[];
}

/** Live prices from Hyperliquid's public info API. No key, no account. */
export class HyperliquidFeed implements PriceFeed {
  private marketCache: { at: number; value: Market[] } | null = null;
  private midCache: { at: number; value: Record<string, number> } | null = null;

  constructor(
    private readonly url = INFO_URL,
    private readonly midTtlMs = 1_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post<T>(body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
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

  async markets(): Promise<Market[]> {
    if (this.marketCache && Date.now() - this.marketCache.at < 300_000) return this.marketCache.value;
    const meta = await this.post<HlMeta>({ type: 'meta' });
    const value = meta.universe
      .filter((m) => !m.isDelisted)
      .map((m) => ({ name: m.name, maxLeverage: m.maxLeverage, sizeDecimals: m.szDecimals }));
    this.marketCache = { at: Date.now(), value };
    return value;
  }

  async mids(): Promise<Record<string, number>> {
    if (this.midCache && Date.now() - this.midCache.at < this.midTtlMs) return this.midCache.value;
    const [raw, markets] = await Promise.all([this.post<Record<string, string>>({ type: 'allMids' }), this.markets()]);
    const value: Record<string, number> = {};
    for (const m of markets) {
      const px = Number(raw[m.name]);
      if (Number.isFinite(px) && px > 0) value[m.name] = px;
    }
    this.midCache = { at: Date.now(), value };
    return value;
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
