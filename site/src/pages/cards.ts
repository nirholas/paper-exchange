import type { Trade } from '../../../src/types.js';
import { copyCard, downloadCard, drawCard, THEMES, type CardData } from '../cardrender.js';
import { dateTime, esc, positionSide, px, signedUsd, usd } from '../fmt.js';
import { stats, account, exchange, id, onChange } from '../state.js';
import { $, empty, toast, type Page } from '../ui.js';

let off: (() => void)[] = [];
const st = { source: '', theme: 'midnight', hide: false, name: 'Paper Trader', w: { market: 'SOL', side: 'long' as 'long' | 'short', lev: 10, entry: '', exit: '', margin: '1000' } };
const CLOSING = new Set(['close', 'reduce', 'liquidation', 'stop_loss', 'take_profit']);

const page: Page = {
  mount(root) {
    const arg = decodeURIComponent(location.hash.split('/')[2] ?? '');
    st.source = arg || st.source;
    try { st.name = localStorage.getItem('paper-exchange:trader-name') || st.name; } catch { /* storage blocked */ }
    root.innerHTML = `<div class="dash"><header class="dash-head"><div><h1>PnL cards</h1><p class="muted">Turn a real paper trade, or a what-if scenario, into a shareable card. Every card carries a PAPER watermark so nobody mistakes it for live results.</p></div></header>
      <div class="cards-grid"><section class="panel pad col" id="c-ctl"></section><section class="panel pad"><canvas id="c-canvas" class="card-canvas" aria-label="PnL card preview"></canvas>
      <div class="row wrap gap"><button class="btn primary" id="c-dl">Download PNG</button><button class="btn" id="c-cp">Copy image</button><a class="btn" id="c-x" target="_blank" rel="noopener noreferrer">Share on X</a></div><p class="muted small" id="c-note"></p></section></div></div>`;
    buildControls();
    off.push(onChange(() => { refreshSources(); draw(); }));
    refreshSources();
    draw();
    $('#c-dl')!.onclick = () => void downloadCard($<HTMLCanvasElement>('#c-canvas')!, `paper-pnl-${Date.now()}.png`).catch(() => toast('Could not save the card.', 'err'));
    $('#c-cp')!.onclick = async () => {
      try { await copyCard($<HTMLCanvasElement>('#c-canvas')!); toast('Card copied to the clipboard.', 'ok'); }
      catch { toast('Your browser blocked image copy. Use Download PNG instead.', 'err'); }
    };
  },
  unmount() { off.forEach((f) => f()); off = []; },
};
export default page;

function buildControls() {
  $('#c-ctl')!.innerHTML = `
    <label class="fld"><span>Source</span><select id="c-src"></select></label>
    <div id="c-whatif" class="col" hidden>
      <div class="tpsl"><label class="fld"><span>Market</span><input id="w-market" value="${st.w.market}" autocomplete="off"></label><label class="fld"><span>Side</span><select id="w-side"><option value="long">Long</option><option value="short">Short</option></select></label></div>
      <div class="tpsl"><label class="fld"><span>Entry price</span><input id="w-entry" inputmode="decimal"></label><label class="fld"><span>Exit price</span><input id="w-exit" inputmode="decimal"></label></div>
      <div class="tpsl"><label class="fld"><span>Margin (USD)</span><input id="w-margin" inputmode="decimal" value="${st.w.margin}"></label><label class="fld"><span>Leverage</span><input id="w-lev" inputmode="decimal" value="${st.w.lev}"></label></div>
      <p class="muted small">What-if scenarios use the same fee model as the exchange: taker fees on entry and exit.</p></div>
    <div class="fld"><span>Theme</span><div class="themes" id="c-themes">${THEMES.map((t) => `<button data-t="${t.id}" class="${t.id === st.theme ? 'on' : ''}" style="background:linear-gradient(135deg,${t.bg[0]},${t.bg[1]});--a:${t.accent}" aria-label="${t.name}" title="${t.name}"><i></i></button>`).join('')}</div></div>
    <label class="fld"><span>Trader name</span><input id="c-name" maxlength="24" value="${esc(st.name)}"></label>
    <label class="chk"><input type="checkbox" id="c-hide"> Hide dollar amounts (show percentages only)</label>`;
  const bind = (sel: string, ev: string, fn: (el: any) => void) => $(sel)!.addEventListener(ev, (e) => { fn(e.target); draw(); });
  bind('#c-src', 'change', (el) => { st.source = el.value; });
  bind('#c-name', 'input', (el) => { st.name = el.value || 'Paper Trader'; try { localStorage.setItem('paper-exchange:trader-name', st.name); } catch { /* storage blocked */ } });
  bind('#c-hide', 'change', (el) => { st.hide = el.checked; });
  bind('#w-market', 'input', (el) => { st.w.market = el.value.toUpperCase().trim(); });
  bind('#w-side', 'change', (el) => { st.w.side = el.value; });
  bind('#w-entry', 'input', (el) => { st.w.entry = el.value; });
  bind('#w-exit', 'input', (el) => { st.w.exit = el.value; });
  bind('#w-margin', 'input', (el) => { st.w.margin = el.value; });
  bind('#w-lev', 'input', (el) => { st.w.lev = Number(el.value); });
  $('#c-themes')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    st.theme = b.dataset.t!;
    document.querySelectorAll('#c-themes button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  });
}

function closedTrades(): Trade[] { return exchange.trades(id(), 200).filter((t) => CLOSING.has(t.kind)); }

function refreshSources() {
  const sel = $<HTMLSelectElement>('#c-src');
  if (!sel) return;
  const opts: string[] = [];
  for (const p of account?.positions ?? []) opts.push(`<option value="open:${esc(p.market)}">Open: ${esc(p.market)} ${p.side} ${p.leverage}x (${signedUsd(p.unrealizedPnl)})</option>`);
  for (const t of closedTrades().slice(0, 40)) opts.push(`<option value="trade:${esc(t.id)}">Closed: ${esc(t.market)} ${positionSide(t)} ${signedUsd(t.realizedPnl)} (${dateTime(t.createdAt)})</option>`);
  opts.push('<option value="whatif">What-if scenario</option>');
  if (!st.source || !opts.some((o) => o.includes(`value="${st.source}"`))) st.source = opts[0]!.includes('whatif') ? 'whatif' : (/value="([^"]+)"/.exec(opts[0]!)?.[1] ?? 'whatif');
  sel.innerHTML = opts.join('');
  sel.value = st.source;
  ($('#c-whatif') as HTMLElement).hidden = st.source !== 'whatif';
}

function currentCard(): CardData | null {
  const trader = st.name;
  if (st.source.startsWith('open:')) {
    const p = account?.positions.find((x) => x.market === st.source.slice(5));
    if (!p) return null;
    return { market: p.market, side: p.side, leverage: p.leverage, entry: p.entryPrice, exit: p.markPrice, open: true, pnl: p.unrealizedPnl, roePct: p.returnOnMarginPct, notional: p.notional, trader, time: Date.now() };
  }
  if (st.source.startsWith('trade:')) {
    const t = closedTrades().find((x) => x.id === st.source.slice(6));
    if (!t) return null;
    const margin = (t.size * t.entryPrice) / t.leverage;
    return { market: t.market, side: positionSide(t), leverage: t.leverage, entry: t.entryPrice, exit: t.price, open: false, pnl: t.realizedPnl, roePct: (t.realizedPnl / margin) * 100, notional: t.size * t.entryPrice, trader, time: t.createdAt };
  }
  const entry = Number(st.w.entry) || stats[st.w.market]?.markPx || 0;
  const exit = Number(st.w.exit) || entry;
  const margin = Number(st.w.margin), lev = st.w.lev;
  if (!(entry > 0) || !(margin > 0) || !(lev >= 1)) return null;
  const notional = margin * lev, qty = notional / entry;
  const gross = (st.w.side === 'long' ? exit - entry : entry - exit) * qty;
  const fees = (notional + qty * exit) * (exchange.cfg.takerFeeBps / 10_000);
  const pnl = gross - fees;
  return { market: st.w.market || 'SOL', side: st.w.side, leverage: lev, entry, exit, open: false, pnl, roePct: (pnl / margin) * 100, notional, trader, time: Date.now() };
}

function draw() {
  const canvas = $<HTMLCanvasElement>('#c-canvas');
  if (!canvas) return;
  ($('#c-whatif') as HTMLElement).hidden = st.source !== 'whatif';
  const d = currentCard();
  if (!d) {
    canvas.width = 1200; canvas.height = 630;
    canvas.getContext('2d')!.clearRect(0, 0, 1200, 630);
    $('#c-note')!.innerHTML = empty('Nothing to render yet', 'Open a position or close a trade in the terminal, or pick What-if scenario and fill in an entry price.', '<a class="btn primary" href="#/trade">Open the terminal</a>');
    return;
  }
  drawCard(canvas, d, THEMES.find((t) => t.id === st.theme)!, st.hide);
  $('#c-note')!.textContent = `${d.market} ${d.side} ${d.leverage}x: ${d.open ? 'unrealized' : 'net of fees'} ${st.hide ? '' : signedUsd(d.pnl)} on ${st.hide ? 'hidden size' : usd(d.notional, 0)}. Entry ${px(d.entry)}, ${d.open ? 'mark' : 'exit'} ${px(d.exit)}.`.replace('  ', ' ');
  const text = `${d.market}-PERP ${d.side} ${d.leverage}x: ${d.roePct >= 0 ? '+' : ''}${d.roePct.toFixed(2)}% (paper trade, live Hyperliquid prices). Practice trading with simulated funds:`;
  ($('#c-x') as HTMLAnchorElement).href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://paper-exchange.pages.dev')}`;
}
