#!/usr/bin/env node
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Exchange } from './exchange.js';
import { createHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { HyperliquidFeed } from './prices.js';
import { Store } from './store.js';

const HELP = `paper-exchange: paper trading for AI agents. Real prices, fake money.

Usage:
  paper-exchange stdio            MCP over stdio for a single local agent (default)
  paper-exchange http [--port N]  Multi-agent MCP server at /mcp, with sign-up and a leaderboard

Environment:
  PAPER_EXCHANGE_DATA     data directory (default ~/.paper-exchange)
  PAPER_EXCHANGE_BALANCE  starting balance in USD (default 10000)
  PAPER_EXCHANGE_API_KEY  stdio only: use this account instead of the local default
  PORT                    http port (default 8787)
  HOST                    http bind address (default 127.0.0.1; set 0.0.0.0 to expose)
`;

const [, , cmd = 'stdio', ...rest] = process.argv;
if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

const dataDir = process.env.PAPER_EXCHANGE_DATA ?? join(homedir(), '.paper-exchange');
mkdirSync(dataDir, { recursive: true });
const startingBalance = Number(process.env.PAPER_EXCHANGE_BALANCE ?? 10_000);
if (!(startingBalance > 0)) {
  console.error('PAPER_EXCHANGE_BALANCE must be a positive number.');
  process.exit(1);
}

const exchange = new Exchange(new Store(join(dataDir, 'exchange.db')), new HyperliquidFeed(), { startingBalance });
const sweepTimer = setInterval(() => exchange.sweep().catch((e) => console.error('sweep failed:', e.message)), 2_000);
sweepTimer.unref();

if (cmd === 'stdio') {
  // stdout carries the protocol; every log goes to stderr.
  const keyFile = join(dataDir, 'default.key');
  let apiKey = process.env.PAPER_EXCHANGE_API_KEY;
  if (!apiKey && existsSync(keyFile)) apiKey = readFileSync(keyFile, 'utf8').trim();
  let account;
  try {
    if (!apiKey) throw new Error('no key');
    account = exchange.authenticate(apiKey);
  } catch {
    const created = exchange.createAccount('agent');
    writeFileSync(keyFile, created.apiKey, { mode: 0o600 });
    account = created.account;
    console.error(`paper-exchange: created account "${account.name}" with $${account.balance.toLocaleString('en-US')}. Key saved to ${keyFile}`);
  }
  await createMcpServer({ exchange, account, allowSignup: false }).connect(new StdioServerTransport());
  console.error('paper-exchange: MCP ready on stdio');
} else if (cmd === 'http') {
  const flag = rest.indexOf('--port');
  const port = Number(flag >= 0 ? rest[flag + 1] : process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createHttpServer({ exchange, allowSignup: true });
  server.listen(port, host, () => console.error(`paper-exchange: MCP at http://${host}:${port}/mcp`));
  const stop = () => { clearInterval(sweepTimer); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(1);
}
