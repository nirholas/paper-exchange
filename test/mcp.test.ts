import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.js';
import { createMcpServer } from '../src/mcp.js';
import { setup } from './helpers.js';

const parse = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!.text));

async function connect(ctx: Parameters<typeof createMcpServer>[0]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return client;
}

describe('MCP tools', () => {
  it('exposes the trading toolset', async () => {
    const { ex, account } = setup();
    const client = await connect({ exchange: ex, account, allowSignup: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_markets', 'preview_order', 'place_order', 'close_position', 'set_protection', 'get_account', 'get_leaderboard', 'reset_account']));
    expect(names).not.toContain('create_account');
  });

  it('previews, trades and reports through the protocol', async () => {
    const { ex, account } = setup();
    const client = await connect({ exchange: ex, account, allowSignup: false });
    const preview = parse(await client.callTool({ name: 'preview_order', arguments: { market: 'BTC', side: 'long', sizeUsd: 5000, leverage: 10 } }));
    expect(preview.marginRequired).toBeCloseTo(500, 3);
    const placed = parse(await client.callTool({ name: 'place_order', arguments: { market: 'BTC', side: 'long', sizeUsd: 5000, leverage: 10 } }));
    expect(placed.position.market).toBe('BTC');
    const acct = parse(await client.callTool({ name: 'get_account', arguments: {} }));
    expect(acct.positions).toHaveLength(1);
  });

  it('returns exchange errors as tool errors the model can act on', async () => {
    const { ex, account } = setup();
    const client = await connect({ exchange: ex, account, allowSignup: false });
    const res = await client.callTool({ name: 'place_order', arguments: { market: 'BTC', side: 'long', sizeUsd: 9e9, leverage: 5 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/insufficient_balance.*Lower sizeUsd/);
  });

  it('keeps account tools behind sign-up for anonymous connections', async () => {
    const { ex } = setup();
    const client = await connect({ exchange: ex, account: null, allowSignup: true });
    const denied = await client.callTool({ name: 'get_account', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toMatch(/create_account/);
    const created = parse(await client.callTool({ name: 'create_account', arguments: { name: 'newbie' } }));
    expect(created.apiKey).toMatch(/^pe_/);
    expect((await client.callTool({ name: 'list_markets', arguments: {} })).isError).toBeFalsy();
  });
});

describe('HTTP transport', () => {
  it('authenticates by bearer key and serves the public leaderboard', async () => {
    const { ex, apiKey } = setup();
    const server = createHttpServer({ exchange: ex, allowSignup: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer pe_nope', 'content-type': 'application/json' }, body: '{}' });
      expect(bad.status).toBe(401);

      const client = new Client({ name: 'http', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
      const acct = parse(await client.callTool({ name: 'get_account', arguments: {} }));
      expect(acct.name).toBe('tester');
      await client.close();

      const board = await (await fetch(`${base}/v1/leaderboard`)).json();
      expect(board[0].name).toBe('tester');
    } finally {
      server.close();
    }
  });
});
