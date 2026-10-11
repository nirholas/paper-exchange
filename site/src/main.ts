import { $, $$, toast } from './ui.js';
import { boot, onEvent, startTicking, stats, statsAt, feedError, onChange, reset } from './state.js';
import { socket } from './hl.js';
import { usd } from './fmt.js';
import { account } from './state.js';
import { confirmDialog } from './ui.js';
import type { Page } from './ui.js';

const routes: Record<string, () => Promise<{ default: Page }>> = {
  '': () => import('./pages/trade.js'),
  trade: () => import('./pages/trade.js'),
  markets: () => import('./pages/markets.js'),
  portfolio: () => import('./pages/portfolio.js'),
  cards: () => import('./pages/cards.js'),
  agents: () => import('./pages/agents.js'),
};

let current: Page | null = null;
let navToken = 0;

function parse(): { name: string; arg: string } {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name in routes ? name : '', arg: decodeURIComponent(arg) };
}

async function render() {
  const token = ++navToken;
  const { name } = parse();
  current?.unmount?.();
  current = null;
  $$('#nav a').forEach((a) => a.classList.toggle('active', (a.getAttribute('href') ?? '').replace('#/', '') === (name || 'trade')));
  const root = $('#view')!;
  root.innerHTML = '';
  const mod = await routes[name]!();
  if (token !== navToken) return;
  current = mod.default;
  await current.mount(root);
  document.title = `${name ? name[0]!.toUpperCase() + name.slice(1) : 'Trade'} | Paper Exchange`;
}

function chrome() {
  const bal = $('#hdr-equity')!;
  const feedEl = $('#hdr-feed')!;
  const paint = () => {
    bal.textContent = account ? usd(account.equity) : '$10,000.00';
    const fresh = statsAt && Date.now() - statsAt < 8_000;
    const live = fresh && !feedError;
    feedEl.className = `dot ${live ? 'live' : 'down'}`;
    feedEl.title = live ? `Live Hyperliquid data (${Object.keys(stats).length} markets)` : feedError ?? 'Connecting to Hyperliquid';
    $('#hdr-feed-label')!.textContent = live ? 'Live' : socket.status === 'down' ? 'Offline' : 'Connecting';
  };
  onChange(paint);
  setInterval(paint, 2_000);
  paint();

  $('#reset')!.addEventListener('click', async () => {
    if (await confirmDialog('Reset your paper account?', 'This closes every position, clears your journal and restores the $10,000 starting balance.', 'Reset account')) {
      reset();
      toast('Account reset to $10,000.', 'ok');
    }
  });
  $('#menu')!.addEventListener('click', () => $('#nav')!.classList.toggle('open'));
  $('#nav')!.addEventListener('click', () => $('#nav')!.classList.remove('open'));
}

onEvent((e) => {
  const labels: Record<string, string> = { liquidation: 'Liquidated', stop_loss: 'Stop loss hit', take_profit: 'Take profit hit', limit_fill: 'Limit order filled', order_cancelled: 'Order cancelled', funding: 'Funding' };
  toast(`${labels[e.kind] ?? e.kind}: ${e.market}. ${e.detail}`, e.kind === 'liquidation' ? 'err' : 'info');
});

boot();
chrome();
startTicking();
window.addEventListener('hashchange', render);
void render();
