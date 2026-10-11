import { createServer, type IncomingMessage, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Exchange } from './exchange.js';
import { createMcpServer } from './mcp.js';
import { ExchangeError, type Account } from './types.js';

const MAX_BODY = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ExchangeError('invalid_request', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export interface HttpOptions {
  exchange: Exchange;
  allowSignup: boolean;
}

/** Streamable-HTTP MCP at /mcp plus a public JSON leaderboard and health check. */
export function createHttpServer({ exchange, allowSignup }: HttpOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        });
        return void res.end();
      }
      if (url.pathname === '/healthz') return json(200, { ok: true, accounts: exchange.store.accountCount() });
      if (url.pathname === '/v1/leaderboard') return json(200, await exchange.leaderboard(Number(url.searchParams.get('limit') ?? 20) || 20));
      if (url.pathname === '/v1/markets') {
        const [markets, mids] = await Promise.all([exchange.markets(), exchange.feed.mids()]);
        return json(200, markets.filter((m) => mids[m.name]).map((m) => ({ market: m.name, price: mids[m.name], maxLeverage: m.maxLeverage })));
      }
      if (url.pathname !== '/mcp') return json(404, { error: 'not_found', hint: 'MCP endpoint is /mcp' });
      if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', hint: 'This server is stateless: POST JSON-RPC to /mcp.' });

      let account: Account | null = null;
      const auth = req.headers.authorization;
      if (auth) {
        const key = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
        if (!key) return json(401, { error: 'unauthorized', message: 'Use "Authorization: Bearer <api key>".' });
        try { account = exchange.authenticate(key.trim()); }
        catch { return json(401, { error: 'unauthorized', message: 'Unknown API key.' }); }
      }

      const body = await readJson(req);
      const mcp = createMcpServer({ exchange, account, allowSignup });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof ExchangeError) return json(400, { error: err.code, message: err.message });
      if (err instanceof SyntaxError) return json(400, { error: 'invalid_request', message: 'Body is not valid JSON.' });
      console.error(err);
      json(500, { error: 'internal_error' });
    }
  });
}
