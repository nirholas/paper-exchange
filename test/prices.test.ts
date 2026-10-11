import { describe, expect, it } from 'vitest';
import { HyperliquidFeed } from '../src/index.js';

/** Browsers throw "Illegal invocation" when fetch is called as a method of another object. */
function browserLikeFetch(this: unknown, _url: unknown, _init?: unknown): Promise<Response> {
  if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  return Promise.resolve(new Response(JSON.stringify([{ universe: [{ name: 'SOL', szDecimals: 2, maxLeverage: 20 }] }, [{ markPx: '100', oraclePx: '100', funding: '0.00001', openInterest: '10', dayNtlVlm: '1000', prevDayPx: '99' }]])));
}

describe('HyperliquidFeed', () => {
  it('calls an injected fetch without binding it to the feed, so it works in browsers', async () => {
    const feed = new HyperliquidFeed(undefined, 1_000, browserLikeFetch as unknown as typeof fetch);
    const mids = await feed.mids();
    expect(mids.SOL).toBe(100);
  });
});
