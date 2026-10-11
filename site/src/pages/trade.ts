import { CandlestickSeries, HistogramSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { ExchangeError } from '../../../src/types.js';
import type { OrderRequest, PositionView, Quote } from '../../../src/exchange.js';
import { baseChart, COLORS } from '../charts.js';
import { clock, cls, positionSide, compactUsd, dateTime, duration, esc, fundingApr, fundingPct, pct, px, signedUsd, size as fmtSize, usd } from '../fmt.js';
import { feed, l2Book, recentTrades, socket, type PublicTrade } from '../hl.js';
import { account, act, exchange, id, onChange, stats } from '../state.js';
import { $, $$, empty, skeleton, toast, type Page } from '../ui.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const LAST = 'paper-exchange:last-market';

interface Ctx {
  market: string;
  interval: string;
  side: 'long' | 'short';
  type: 'market' | 'limit';
  unit: 'usd' | 'base';
  tab: 'positions' | 'orders' | 'history' | 'balances';
  bookTab: 'book' | 'trades';
  chart: IChartApi | null;
  candles: ISeriesApi<'Candlestick'> | null;
  volume: ISeriesApi<'Histogram'> | null;
  lines: IPriceLine[];
  cleanup: (() => void)[];
  trades: PublicTrade[];
  quoteSeq: number;
  quoteTimer: ReturnType<typeof setTimeout> | null;
}

let ctx: Ctx | null = null;

const SHELL = `
<div class="terminal">
  <section class="bar panel" id="bar"></section>
  <section class="chart panel">
    <div class="panel-head"><div class="seg" id="intervals"></div><span class="muted" id="chart-note"></span></div>
    <div class="chart-host" id="chart"><div class="skel-fill">${skeleton(1)}</div></div>
  </section>
  <section class="book panel">
    <div class="panel-head"><div class="seg" id="book-tabs"><button data-b="book" class="on">Order book</button><button data-b="trades">Trades</button></div></div>
    <div id="book-body" class="book-body">${skeleton(10)}</div>
  </section>
  <section class="form panel" id="form"></section>
  <section class="bottom panel">
    <div class="panel-head"><div class="seg" id="tabs"></div></div>
    <div class="tbl-wrap" id="bottom-body"></div>
  </section>
</div>`;

const page: Page = {
  async mount(root) {
    root.innerHTML = SHELL;
    const arg = decodeURIComponent(location.hash.split('/')[2] ?? '');
    const saved = (() => { try { return localStorage.getItem(LAST); } catch { return null; } })();
    ctx = { market: (arg || saved || 'SOL').toUpperCase(), interval: '15m', side: 'long', type: 'market', unit: 'usd', tab: 'positions', bookTab: 'book', chart: null, candles: null, volume: null, lines: [], cleanup: [], trades: [], quoteSeq: 0, quoteTimer: null };
    const c = ctx;

    $('#intervals')!.innerHTML = INTERVALS.map((i) => `<button data-i="${i}" class="${i === c.interval ? 'on' : ''}">${i}</button>`).join('');
    $('#intervals')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      c.interval = b.dataset.i!;
      $$('#intervals button').forEach((x) => x.classList.toggle('on', x === b));
      void loadChart();
    });
    $('#book-tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      c.bookTab = b.dataset.b as Ctx['bookTab'];
      $$('#book-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      paintBook();
    });
    $('#tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      c.tab = b.dataset.t as Ctx['tab'];
      paintBottom();
    });

    buildForm();
    c.cleanup.push(onChange(() => { paintBar(); paintBottom(); paintAccount(); paintLines(); scheduleQuote(); }));
    await selectMarket(c.market, false);
  },
  unmount() {
    if (!ctx) return;
    ctx.cleanup.forEach((fn) => fn());
    ctx.chart?.remove();
    if (ctx.quoteTimer) clearTimeout(ctx.quoteTimer);
    ctx = null;
  },
};
export default page;

// ---------- market selection ----------

let book: { bids: [number, number][]; asks: [number, number][] } = { bids: [], asks: [] };
let streams: (() => void)[] = [];

async function selectMarket(name: string, push = true) {
  const c = ctx!;
  streams.forEach((fn) => fn());
  streams = [];
  c.market = name;
  try { localStorage.setItem(LAST, name); } catch { /* storage blocked */ }
  if (push) history.replaceState(null, '', `#/trade/${encodeURIComponent(name)}`);
  book = { bids: [], asks: [] };
  c.trades = [];
  paintBar();
  paintBottom();
  paintBook();
  resetFormForMarket();
  void loadChart();

  streams.push(socket.subscribe({ type: 'l2Book', coin: name }, (d) => {
    const lv = (a: { px: string; sz: string }[]) => a.map((x) => [+x.px, +x.sz] as [number, number]);
    book = { bids: lv(d.levels[0]), asks: lv(d.levels[1]) };
    if (c.bookTab === 'book') paintBook();
  }));
  streams.push(socket.subscribe({ type: 'trades', coin: name }, (d: { px: string; sz: string; side: 'B' | 'A'; time: number; tid: number }[]) => {
    c.trades = [...d.map((t) => ({ px: +t.px, sz: +t.sz, side: t.side, time: t.time, tid: t.tid })).reverse(), ...c.trades].slice(0, 60);
    if (c.bookTab === 'trades') paintBook();
  }));
  l2Book(name).then((b) => { if (ctx?.market === name && !book.bids.length) { book = b; paintBook(); } }).catch(() => {});
  recentTrades(name).then((t) => { if (ctx?.market === name && !c.trades.length) { c.trades = t.slice(0, 60); if (c.bookTab === 'trades') paintBook(); } }).catch(() => {});
}

// ---------- market bar ----------

function paintBar() {
  const c = ctx;
  const el = $('#bar');
  if (!c || !el) return;
  const s = stats[c.market];
  if (!s) {
    el.innerHTML = `<button class="mkt-btn" id="mkt-btn"><strong>${esc(c.market)}-PERP</strong><span class="caret"></span></button><div class="muted pad">Loading market data</div>`;
    $('#mkt-btn')!.onclick = openPicker;
    return;
  }
  const change = s.prevDayPx ? ((s.markPx - s.prevDayPx) / s.prevDayPx) * 100 : 0;
  const nextHour = 3_600_000 - (Date.now() % 3_600_000);
  const oiUsd = s.openInterest * s.markPx;
  el.innerHTML = `
    <button class="mkt-btn" id="mkt-btn" aria-haspopup="dialog"><strong>${esc(s.market)}-PERP</strong><span class="lev">${s.maxLeverage}x</span><span class="caret"></span></button>
    <div class="stat big ${cls(change)}"><label>Mark</label><b>${px(s.markPx)}</b></div>
    <div class="stat"><label>Oracle</label><b>${px(s.oraclePx)}</b></div>
    <div class="stat"><label>24h change</label><b class="${cls(change)}">${px(s.markPx - s.prevDayPx)} / ${pct(change)}</b></div>
    <div class="stat"><label>24h volume</label><b>${compactUsd(s.dayNtlVlm)}</b></div>
    <div class="stat"><label>Open interest</label><b>${compactUsd(oiUsd)}</b></div>
    <div class="stat"><label>Funding / countdown</label><b><span class="${cls(s.funding)}">${fundingPct(s.funding)}</span> <span class="muted">${duration(nextHour)}</span></b></div>
    <div class="stat hide-sm"><label>Funding APR</label><b class="${cls(s.funding)}">${pct(fundingApr(s.funding), 1)}</b></div>`;
  $('#mkt-btn')!.onclick = openPicker;
}

function openPicker() {
  const d = document.createElement('dialog');
  d.className = 'dlg picker';
  const rows = (q: string) => Object.values(stats)
    .filter((s) => s.market.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm)
    .slice(0, 80)
    .map((s) => {
      const ch = s.prevDayPx ? ((s.markPx - s.prevDayPx) / s.prevDayPx) * 100 : 0;
      return `<button class="pick-row" data-m="${esc(s.market)}"><b>${esc(s.market)}</b><span class="muted">${s.maxLeverage}x</span><span>${px(s.markPx)}</span><span class="${cls(ch)}">${pct(ch)}</span><span class="${cls(s.funding)}">${fundingPct(s.funding)}</span><span class="muted">${compactUsd(s.dayNtlVlm)}</span></button>`;
    }).join('') || empty('No match', 'Try another ticker.');
  d.innerHTML = `<div class="picker-head"><input id="pick-q" placeholder="Search markets" autocomplete="off" aria-label="Search markets"><button class="btn" id="pick-x">Close</button></div>
    <div class="pick-cols"><span>Market</span><span></span><span>Price</span><span>24h</span><span>Funding</span><span>Volume</span></div><div class="pick-list" id="pick-list">${rows('')}</div>`;
  document.body.append(d);
  d.showModal();
  const list = $('#pick-list', d)!;
  $('#pick-q', d)!.addEventListener('input', (e) => { list.innerHTML = rows((e.target as HTMLInputElement).value); });
  $('#pick-x', d)!.onclick = () => d.close();
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.pick-row');
    if (b) { d.close(); void selectMarket(b.dataset.m!); }
  });
  d.addEventListener('close', () => d.remove());
  ($('#pick-q', d) as HTMLInputElement).focus();
}

// ---------- chart ----------

async function loadChart() {
  const c = ctx!;
  const host = $('#chart')!;
  const market = c.market, interval = c.interval;
  $('#chart-note')!.textContent = '';
  try {
    const data = await feed.candles(market, interval, 400);
    if (!ctx || ctx.market !== market || ctx.interval !== interval) return;
    if (!c.chart) {
      host.innerHTML = '';
      c.chart = baseChart(host);
      c.candles = c.chart.addSeries(CandlestickSeries, { upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false });
      c.volume = c.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      c.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    c.candles!.setData(data.map((k) => ({ time: (k.time / 1000) as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    c.volume!.setData(data.map((k) => ({ time: (k.time / 1000) as UTCTimestamp, value: k.volume, color: k.close >= k.open ? 'rgba(47,227,194,0.28)' : 'rgba(237,112,136,0.28)' })));
    c.chart.timeScale().fitContent();
    paintLines();
    const unsub = socket.subscribe({ type: 'candle', coin: market, interval }, (k: { t: number; o: string; h: string; l: string; c: string; v: string }) => {
      if (!ctx || ctx.market !== market || ctx.interval !== interval) return;
      const time = (k.t / 1000) as UTCTimestamp;
      c.candles!.update({ time, open: +k.o, high: +k.h, low: +k.l, close: +k.c });
      c.volume!.update({ time, value: +k.v, color: +k.c >= +k.o ? 'rgba(47,227,194,0.28)' : 'rgba(237,112,136,0.28)' });
    });
    streams.push(unsub);
  } catch (err) {
    host.innerHTML = `<div class="empty err"><strong>Chart unavailable</strong><span>${esc(err instanceof Error ? err.message : 'Candle request failed.')}</span><button class="btn" id="chart-retry">Retry</button></div>`;
    c.chart = null; c.candles = null; c.volume = null;
    $('#chart-retry')!.onclick = () => { host.innerHTML = skeleton(1); void loadChart(); };
  }
}

/** Entry, liquidation and protective-order levels for the open position, drawn on the chart. */
function paintLines() {
  const c = ctx;
  if (!c?.candles) return;
  c.lines.forEach((l) => c.candles!.removePriceLine(l));
  c.lines = [];
  const p = account?.positions.find((x) => x.market === c.market);
  if (p) {
    const add = (price: number, title: string, color: string, style = LineStyle.Dashed) => c.lines.push(c.candles!.createPriceLine({ price, title, color, lineStyle: style, lineWidth: 1, axisLabelVisible: true }));
    add(p.entryPrice, `${p.side === 'long' ? 'Long' : 'Short'} entry`, '#e6edf3', LineStyle.Solid);
    add(p.liquidationPrice, 'Liq', COLORS.down);
    if (p.stopLoss) add(p.stopLoss, 'SL', COLORS.down, LineStyle.Dotted);
    if (p.takeProfit) add(p.takeProfit, 'TP', COLORS.up, LineStyle.Dotted);
  }
  for (const o of account?.openOrders ?? []) if (o.market === c.market) c.lines.push(c.candles.createPriceLine({ price: o.limitPrice, title: `${o.side === 'long' ? 'Buy' : 'Sell'} limit`, color: COLORS.accent, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true }));
}

// ---------- book and trades ----------

function paintBook() {
  const c = ctx;
  const el = $('#book-body');
  if (!c || !el) return;
  const s = stats[c.market];
  if (c.bookTab === 'trades') {
    el.innerHTML = c.trades.length
      ? `<div class="bk-head"><span>Price</span><span>Size</span><span>Time</span></div>${c.trades.map((t) => `<div class="bk-row"><span class="${t.side === 'B' ? 'up' : 'down'}">${px(t.px)}</span><span>${t.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span><span class="muted">${clock(t.time)}</span></div>`).join('')}`
      : skeleton(10);
    return;
  }
  if (!book.bids.length) { el.innerHTML = skeleton(12); return; }
  const rows = 11;
  const asks = book.asks.slice(0, rows);
  const bids = book.bids.slice(0, rows);
  const cum = (lv: [number, number][]) => { let t = 0; return lv.map(([p, z]) => [p, z, (t += z)] as [number, number, number]); };
  const A = cum(asks), B = cum(bids);
  const max = Math.max(A.at(-1)?.[2] ?? 1, B.at(-1)?.[2] ?? 1);
  const row = (lv: [number, number, number], side: 'ask' | 'bid') =>
    `<div class="bk-row ${side}" data-px="${lv[0]}" style="--d:${((lv[2] / max) * 100).toFixed(1)}%"><span class="${side === 'ask' ? 'down' : 'up'}">${px(lv[0])}</span><span>${lv[1].toLocaleString('en-US', { maximumFractionDigits: 3 })}</span><span class="muted">${lv[2].toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>`;
  const bestA = asks[0]?.[0], bestB = bids[0]?.[0];
  const spread = bestA && bestB ? bestA - bestB : 0;
  el.innerHTML = `<div class="bk-head"><span>Price</span><span>Size (${esc(c.market)})</span><span>Total</span></div>
    ${[...A].reverse().map((l) => row(l, 'ask')).join('')}
    <div class="bk-mid"><b class="${cls(s ? s.markPx - s.prevDayPx : 0)}">${px(s?.markPx)}</b><span class="muted">Spread ${px(spread)} (${bestB ? ((spread / bestB) * 100).toFixed(3) : '0'}%)</span></div>
    ${B.map((l) => row(l, 'bid')).join('')}`;
  el.onclick = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('.bk-row[data-px]');
    const input = $<HTMLInputElement>('#f-limit');
    if (r && input) { setType('limit'); input.value = r.dataset.px!; scheduleQuote(); }
  };
}

// ---------- order form ----------

function buildForm() {
  $('#form')!.innerHTML = `
    <div class="seg wide" id="f-type"><button data-t="market" class="on">Market</button><button data-t="limit">Limit</button></div>
    <div class="side-toggle" id="f-side"><button data-s="long" class="long on">Buy / Long</button><button data-s="short" class="short">Sell / Short</button></div>
    <div class="acct" id="f-acct"></div>
    <label class="fld" id="f-limit-wrap" hidden><span>Limit price</span><input id="f-limit" inputmode="decimal" autocomplete="off" placeholder="0.00"></label>
    <div class="fld"><span class="row between"><span>Size</span><span class="seg mini" id="f-unit"><button data-u="usd" class="on">USD</button><button data-u="base" id="f-base-unit">BASE</button></span></span>
      <input id="f-size" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Order size"></div>
    <div class="pcts" id="f-pcts">${[25, 50, 75, 100].map((p) => `<button data-p="${p}">${p}%</button>`).join('')}</div>
    <div class="fld"><span class="row between"><span>Leverage</span><b id="f-lev-v">5x</b></span><input type="range" id="f-lev" min="1" max="20" step="1" value="5" aria-label="Leverage"></div>
    <div class="tpsl"><label class="fld"><span>Take profit</span><input id="f-tp" inputmode="decimal" autocomplete="off" placeholder="Price"></label><label class="fld"><span>Stop loss</span><input id="f-sl" inputmode="decimal" autocomplete="off" placeholder="Price"></label></div>
    <label class="chk"><input type="checkbox" id="f-ro"> Reduce only</label>
    <details class="risk"><summary>Position size calculator</summary>
      <div class="tpsl"><label class="fld"><span>Risk % of equity</span><input id="r-pct" inputmode="decimal" value="1"></label><label class="fld"><span>Stop price</span><input id="r-stop" inputmode="decimal" placeholder="Price"></label></div>
      <button class="btn block" id="r-apply">Size order to this risk</button><p class="muted small" id="r-note">Sizes the order so a stop-out loses about this share of your equity, fees included.</p></details>
    <button class="submit long" id="f-submit">Buy / Long</button>
    <div class="summary" id="f-sum"></div>`;

  $('#f-type')!.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) setType(b.dataset.t as Ctx['type']); });
  $('#f-side')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    ctx!.side = b.dataset.s as Ctx['side'];
    $$('#f-side button').forEach((x) => x.classList.toggle('on', x === b));
    const sub = $('#f-submit')!;
    sub.className = `submit ${ctx!.side}`;
    sub.textContent = ctx!.side === 'long' ? 'Buy / Long' : 'Sell / Short';
    scheduleQuote();
  });
  $('#f-unit')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.dataset.u === ctx!.unit) return;
    const input = $<HTMLInputElement>('#f-size')!;
    const mark = stats[ctx!.market]?.markPx;
    const v = Number(input.value);
    if (mark && v > 0) input.value = b.dataset.u === 'base' ? String(+(v / mark).toPrecision(6)) : String(+(v * mark).toFixed(2));
    ctx!.unit = b.dataset.u as Ctx['unit'];
    $$('#f-unit button').forEach((x) => x.classList.toggle('on', x === b));
    scheduleQuote();
  });
  $('#f-pcts')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || !account) return;
    const lev = Number($<HTMLInputElement>('#f-lev')!.value);
    const buying = account.available * lev * 0.985;
    const usdSize = (buying * Number(b.dataset.p)) / 100;
    const mark = stats[ctx!.market]?.markPx ?? 0;
    $<HTMLInputElement>('#f-size')!.value = ctx!.unit === 'usd' ? usdSize.toFixed(2) : mark ? String(+(usdSize / mark).toPrecision(6)) : '';
    scheduleQuote();
  });
  $('#f-lev')!.addEventListener('input', () => { $('#f-lev-v')!.textContent = `${$<HTMLInputElement>('#f-lev')!.value}x`; scheduleQuote(); });
  ['f-size', 'f-limit', 'f-tp', 'f-sl', 'f-ro'].forEach((i) => $(`#${i}`)!.addEventListener('input', scheduleQuote));
  $('#r-apply')!.addEventListener('click', applyRisk);
  $('#f-submit')!.addEventListener('click', submit);
  paintAccount();
}

function setType(t: Ctx['type']) {
  ctx!.type = t;
  $$('#f-type button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
  ($('#f-limit-wrap') as HTMLElement).hidden = t !== 'limit';
  scheduleQuote();
}

function resetFormForMarket() {
  const s = stats[ctx!.market];
  const lev = $<HTMLInputElement>('#f-lev');
  if (lev && s) {
    lev.max = String(s.maxLeverage);
    if (Number(lev.value) > s.maxLeverage) lev.value = String(s.maxLeverage);
    $('#f-lev-v')!.textContent = `${lev.value}x`;
  }
  const bu = $('#f-base-unit');
  if (bu) bu.textContent = ctx!.market;
  for (const i of ['f-size', 'f-limit', 'f-tp', 'f-sl']) { const el = $<HTMLInputElement>(`#${i}`); if (el) el.value = ''; }
  $('#f-sum')!.innerHTML = '';
}

function paintAccount() {
  const el = $('#f-acct');
  if (!el || !account) return;
  el.innerHTML = `<div><label>Equity</label><b>${usd(account.equity)}</b></div><div><label>Available</label><b>${usd(account.available)}</b></div><div><label>Unrealized PnL</label><b class="${cls(account.unrealizedPnl)}">${signedUsd(account.unrealizedPnl)}</b></div>`;
}

function readRequest(): OrderRequest | null {
  const c = ctx!;
  const mark = stats[c.market]?.markPx;
  const raw = Number($<HTMLInputElement>('#f-size')!.value);
  if (!(raw > 0) || !mark) return null;
  const num = (i: string) => { const v = $<HTMLInputElement>(`#${i}`)!.value.trim(); return v === '' ? null : Number(v); };
  const req: OrderRequest = {
    market: c.market, side: c.side, type: c.type,
    sizeUsd: c.unit === 'usd' ? raw : raw * (c.type === 'limit' && num('f-limit') ? num('f-limit')! : mark),
    leverage: Number($<HTMLInputElement>('#f-lev')!.value),
    reduceOnly: $<HTMLInputElement>('#f-ro')!.checked,
    stopLoss: num('f-sl'), takeProfit: num('f-tp'),
  };
  if (c.type === 'limit') { const lp = num('f-limit'); if (!lp || lp <= 0) return null; req.limitPrice = lp; }
  return req;
}

function scheduleQuote() {
  const c = ctx;
  if (!c) return;
  if (c.quoteTimer) clearTimeout(c.quoteTimer);
  c.quoteTimer = setTimeout(runQuote, 160);
}

async function runQuote() {
  const c = ctx;
  const el = $('#f-sum');
  if (!c || !el) return;
  const req = readRequest();
  if (!req) { el.innerHTML = '<p class="muted small">Enter a size to see margin, fees, slippage and liquidation price before you trade.</p>'; return; }
  const seq = ++c.quoteSeq;
  try {
    const q = await exchange.quote(id(), req);
    if (seq !== c.quoteSeq || !ctx) return;
    el.innerHTML = summary(q, req);
  } catch (err) {
    if (seq !== c.quoteSeq) return;
    el.innerHTML = `<p class="warn small" role="alert">${esc(err instanceof ExchangeError ? err.message : 'Could not price this order.')}</p>`;
  }
}

function summary(q: Quote, req: OrderRequest): string {
  const s = stats[q.market];
  const slip = q.midPrice ? ((q.fillPrice - q.midPrice) / q.midPrice) * 100 * (q.side === 'long' ? 1 : -1) : 0;
  const perDay = s ? q.notional * s.funding * 24 * (q.side === 'long' ? 1 : -1) : null;
  const rr = req.stopLoss && req.takeProfit ? Math.abs(req.takeProfit - q.fillPrice) / Math.abs(q.fillPrice - req.stopLoss) : null;
  const row = (k: string, v: string, tone = '') => `<div><span>${k}</span><b class="${tone}">${v}</b></div>`;
  return [
    row(q.rests ? 'Rests on book at' : 'Est. fill price', px(q.fillPrice)),
    row('Size', `${fmtSize(q.size, 4)} ${esc(q.market)}`),
    row('Order value', usd(q.notional)),
    row('Margin required', usd(q.marginRequired)),
    q.liquidationPrice != null ? row('Liquidation price', px(q.liquidationPrice), 'down') : '',
    row('Slippage', `${slip.toFixed(3)}%${q.priceSource === 'order_book' ? ' (live book)' : ' (model)'}`),
    row('Fee', usd(q.fee)),
    perDay != null ? row('Est. funding / day', `${signedUsd(-perDay)}`, perDay > 0 ? 'down' : 'up') : '',
    rr != null ? row('Reward : risk', `${rr.toFixed(2)} : 1`) : '',
  ].join('');
}

function applyRisk() {
  const c = ctx!;
  const note = $('#r-note')!;
  const mark = stats[c.market]?.markPx;
  const stop = Number($<HTMLInputElement>('#r-stop')!.value);
  const riskPct = Number($<HTMLInputElement>('#r-pct')!.value);
  if (!account || !mark || !(stop > 0) || !(riskPct > 0)) { note.textContent = 'Enter a risk percentage and a stop price.'; return; }
  const entry = c.type === 'limit' ? Number($<HTMLInputElement>('#f-limit')!.value) || mark : mark;
  const dist = c.side === 'long' ? entry - stop : stop - entry;
  if (dist <= 0) { note.textContent = `A ${c.side} stop must sit ${c.side === 'long' ? 'below' : 'above'} the entry price.`; return; }
  const riskUsd = (account.equity * riskPct) / 100;
  const feeRate = (exchange.cfg.takerFeeBps * 2) / 10_000;
  const notional = riskUsd / (dist / entry + feeRate);
  const lev = Number($<HTMLInputElement>('#f-lev')!.value);
  const need = notional / lev;
  $<HTMLInputElement>('#f-size')!.value = c.unit === 'usd' ? notional.toFixed(2) : String(+(notional / entry).toPrecision(6));
  $<HTMLInputElement>('#f-sl')!.value = String(stop);
  note.textContent = `Risking ${usd(riskUsd)} (${riskPct}% of equity) over a ${((dist / entry) * 100).toFixed(2)}% stop. Needs ${usd(need)} margin at ${lev}x${need > account.available ? ', more than you have free: raise leverage or lower the risk.' : '.'}`;
  scheduleQuote();
}

async function submit() {
  const btn = $<HTMLButtonElement>('#f-submit')!;
  const req = readRequest();
  if (!req) { toast('Enter a valid size first.', 'err'); return; }
  btn.disabled = true;
  try {
    const res = await act(() => exchange.placeOrder(id(), req));
    toast(res.trade ? `${res.trade.kind === 'close' ? 'Closed' : 'Filled'} ${fmtSize(res.trade.size, 4)} ${res.trade.market} at ${px(res.trade.price)}` : `Limit order placed at ${px(req.limitPrice)}`, 'ok');
    $<HTMLInputElement>('#f-size')!.value = '';
    $('#f-sum')!.innerHTML = '';
  } catch (err) {
    toast(err instanceof ExchangeError ? err.message : 'Order failed. Check your connection and try again.', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- bottom tabs ----------

function paintBottom() {
  const c = ctx;
  const el = $('#bottom-body');
  if (!c || !el) return;
  const a = account;
  const tabs: [Ctx['tab'], string][] = [['positions', `Positions${a ? ` (${a.positions.length})` : ''}`], ['orders', `Open orders${a ? ` (${a.openOrders.length})` : ''}`], ['history', 'Trade history'], ['balances', 'Balances']];
  $('#tabs')!.innerHTML = tabs.map(([k, l]) => `<button data-t="${k}" class="${k === c.tab ? 'on' : ''}">${l}</button>`).join('');
  if (!a) { el.innerHTML = skeleton(4); return; }
  if (c.tab === 'positions') el.innerHTML = positionsTable(a.positions);
  else if (c.tab === 'orders') el.innerHTML = ordersTable(a.openOrders);
  else if (c.tab === 'history') el.innerHTML = historyTable();
  else el.innerHTML = `<table class="tbl"><thead><tr><th>Asset</th><th>Total</th><th>Available</th><th>In positions</th><th>In orders</th><th>Net funding</th><th>Fees paid</th></tr></thead><tbody><tr><td>USDC (paper)</td><td>${usd(a.equity)}</td><td>${usd(a.available)}</td><td>${usd(a.marginInPositions)}</td><td>${usd(a.reservedInOrders)}</td><td class="${cls(-a.fundingPaid)}">${signedUsd(-a.fundingPaid)}</td><td>${usd(a.feesPaid)}</td></tr></tbody></table>`;
}

function positionsTable(ps: PositionView[]): string {
  if (!ps.length) return empty('No open positions', 'Pick a side, size an order and your position shows up here with live PnL, ROE and liquidation price.');
  return `<table class="tbl"><thead><tr><th>Market</th><th>Size</th><th>Value</th><th>Entry</th><th>Mark</th><th>PnL (ROE)</th><th>Liq. price</th><th>Margin</th><th>Funding</th><th>TP / SL</th><th></th></tr></thead><tbody>${ps.map((p) => `
    <tr><td><button class="link" data-go="${esc(p.market)}"><b>${esc(p.market)}</b></button> <span class="tag ${p.side}">${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}x</span></td>
    <td>${fmtSize(p.size, 4)}</td><td>${usd(p.notional)}</td><td>${px(p.entryPrice)}</td><td>${px(p.markPrice)}</td>
    <td class="${cls(p.unrealizedPnl)}">${signedUsd(p.unrealizedPnl)} (${pct(p.returnOnMarginPct)})</td>
    <td>${px(p.liquidationPrice)} <span class="muted small">${p.distanceToLiquidationPct.toFixed(1)}%</span></td><td>${usd(p.margin)}</td>
    <td class="${cls(-p.fundingPaid)}">${signedUsd(-p.fundingPaid)}</td>
    <td><button class="link" data-prot="${esc(p.market)}">${p.takeProfit ? px(p.takeProfit) : '-'} / ${p.stopLoss ? px(p.stopLoss) : '-'}</button></td>
    <td class="acts"><button class="btn sm" data-close="${esc(p.market)}" data-f="1">Close</button><button class="btn sm" data-close="${esc(p.market)}" data-f="0.5">50%</button><a class="btn sm" href="#/cards/open:${encodeURIComponent(p.market)}">Share</a></td></tr>`).join('')}</tbody></table>`;
}

function ordersTable(os: NonNullable<typeof account>['openOrders']): string {
  if (!os.length) return empty('No open orders', 'Limit orders that do not fill immediately rest here and reserve margin until they trigger or you cancel them.');
  return `<table class="tbl"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Type</th><th>Size</th><th>Price</th><th>Reserved</th><th>Flags</th><th></th></tr></thead><tbody>${os.map((o) => `
    <tr><td class="muted">${dateTime(o.createdAt)}</td><td><b>${esc(o.market)}</b></td><td class="${o.side === 'long' ? 'up' : 'down'}">${o.side === 'long' ? 'Buy' : 'Sell'}</td><td>${o.type}</td><td>${fmtSize(o.size, 4)}</td><td>${px(o.limitPrice)}</td><td>${usd(o.reservedMargin)}</td><td class="muted">${o.reduceOnly ? 'Reduce only' : ''}</td><td class="acts"><button class="btn sm" data-cancel="${esc(o.id)}">Cancel</button></td></tr>`).join('')}</tbody></table>`;
}

function historyTable(): string {
  const ts = exchange.trades(id(), 100);
  if (!ts.length) return empty('No trades yet', 'Every fill, stop-out and liquidation is recorded here with fees and realized PnL.');
  const label: Record<string, string> = { open: 'Open', add: 'Add', reduce: 'Reduce', close: 'Close', liquidation: 'Liquidation', stop_loss: 'Stop loss', take_profit: 'Take profit' };
  return `<table class="tbl"><thead><tr><th>Time</th><th>Market</th><th>Action</th><th>Size</th><th>Price</th><th>Fee</th><th>Realized PnL</th><th></th></tr></thead><tbody>${ts.map((t) => `
    <tr><td class="muted">${dateTime(t.createdAt)}</td><td><b>${esc(t.market)}</b></td><td><span class="tag ${positionSide(t)}">${label[t.kind] ?? t.kind} ${positionSide(t)}</span></td><td>${fmtSize(t.size, 4)}</td><td>${px(t.price)}</td><td>${usd(t.fee, 4)}</td>
    <td class="${t.kind === 'open' || t.kind === 'add' ? 'muted' : cls(t.realizedPnl)}">${t.kind === 'open' || t.kind === 'add' ? '-' : signedUsd(t.realizedPnl)}</td>
    <td class="acts">${t.kind === 'open' || t.kind === 'add' ? '' : `<a class="btn sm" href="#/cards/trade:${encodeURIComponent(t.id)}">Share</a>`}</td></tr>`).join('')}</tbody></table>`;
}

document.addEventListener('click', async (e) => {
  if (!ctx) return;
  const t = e.target as HTMLElement;
  const go = t.closest<HTMLElement>('[data-go]');
  if (go) { void selectMarket(go.dataset.go!); return; }
  const cl = t.closest<HTMLElement>('[data-close]');
  if (cl) {
    try {
      const r = await act(() => exchange.closePosition(id(), cl.dataset.close!, Number(cl.dataset.f)));
      toast(`Closed ${fmtSize(r.trade.size, 4)} ${r.trade.market} for ${signedUsd(r.trade.realizedPnl)}`, r.trade.realizedPnl >= 0 ? 'ok' : 'info');
    } catch (err) { toast(err instanceof ExchangeError ? err.message : 'Could not close the position.', 'err'); }
    return;
  }
  const ca = t.closest<HTMLElement>('[data-cancel]');
  if (ca) {
    try { await act(async () => exchange.cancelOrder(id(), ca.dataset.cancel!)); toast('Order cancelled.', 'ok'); }
    catch (err) { toast(err instanceof ExchangeError ? err.message : 'Could not cancel the order.', 'err'); }
    return;
  }
  const pr = t.closest<HTMLElement>('[data-prot]');
  if (pr) editProtection(pr.dataset.prot!);
});

function editProtection(market: string) {
  const p = account?.positions.find((x) => x.market === market);
  if (!p) return;
  const d = document.createElement('dialog');
  d.className = 'dlg';
  d.innerHTML = `<form method="dialog"><h3>${esc(market)} take profit and stop loss</h3><p class="muted small">Leave a field empty to remove it. Entry ${px(p.entryPrice)}, liquidation ${px(p.liquidationPrice)}.</p>
    <label class="fld"><span>Take profit</span><input name="tp" inputmode="decimal" value="${p.takeProfit ?? ''}"></label>
    <label class="fld"><span>Stop loss</span><input name="sl" inputmode="decimal" value="${p.stopLoss ?? ''}"></label>
    <div class="row end"><button class="btn" value="no">Cancel</button><button class="btn primary" value="yes">Save</button></div></form>`;
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', async () => {
    const yes = d.returnValue === 'yes';
    const tp = (d.querySelector('[name=tp]') as HTMLInputElement).value.trim();
    const sl = (d.querySelector('[name=sl]') as HTMLInputElement).value.trim();
    d.remove();
    if (!yes) return;
    try {
      await act(() => exchange.setProtection(id(), market, { takeProfit: tp ? Number(tp) : null, stopLoss: sl ? Number(sl) : null }));
      toast('Take profit and stop loss updated.', 'ok');
    } catch (err) { toast(err instanceof ExchangeError ? err.message : 'Could not update protection.', 'err'); }
  });
}

