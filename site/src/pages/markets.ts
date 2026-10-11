import { LineSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import type { MarketStats } from '../../../src/types.js';
import { baseChart, COLORS } from '../charts.js';
import { cls, compactUsd, esc, fundingApr, fundingPct, pct, px } from '../fmt.js';
import { fundingHistory, predictedFundings, type VenueFunding } from '../hl.js';
import { onChange, stats } from '../state.js';
import { $, empty, errorBox, skeleton, type Page } from '../ui.js';

type SortKey = 'market' | 'markPx' | 'change' | 'funding' | 'oi' | 'vol' | 'turnover' | 'premium';
type HeatMetric = 'funding' | 'change' | 'turnover';

const st = { sort: 'oi' as SortKey, dir: -1, q: '', heat: 'funding' as HeatMetric, fundMarket: 'BTC', venues: null as Record<string, VenueFunding[]> | null, venueErr: '' };
let chart: IChartApi | null = null;
let off: (() => void)[] = [];
let venueTimer: ReturnType<typeof setInterval> | null = null;

interface Row extends MarketStats { change: number; oi: number; vol: number; turnover: number; apr: number }

const rows = (): Row[] => Object.values(stats).filter((s) => s.openInterest * s.markPx > 0).map((s) => ({
  ...s, change: s.prevDayPx ? ((s.markPx - s.prevDayPx) / s.prevDayPx) * 100 : 0, oi: s.openInterest * s.markPx, vol: s.dayNtlVlm,
  turnover: s.openInterest * s.markPx ? s.dayNtlVlm / (s.openInterest * s.markPx) : 0, apr: fundingApr(s.funding),
}));

const SHELL = `
<div class="dash">
  <header class="dash-head"><div><h1>Markets</h1><p class="muted">Every Hyperliquid perpetual with live funding, open interest and cross-venue rates. Click a row to paper trade it.</p></div></header>
  <section class="kpis" id="kpis">${skeleton(1)}</section>
  <div class="grid2">
    <section class="panel"><div class="panel-head"><h2>Heatmap</h2><div class="seg" id="heat-seg"><button data-h="funding" class="on">Funding</button><button data-h="change">24h change</button><button data-h="turnover">Volume / OI</button></div></div><div class="heat" id="heat">${skeleton(1)}</div><p class="muted small pad">Tile area is open interest. Colour is the selected metric: green positive, red negative.</p></section>
    <section class="panel"><div class="panel-head"><h2>Funding opportunities</h2></div><div id="opps" class="opps">${skeleton(6)}</div></section>
  </div>
  <div class="grid2">
    <section class="panel"><div class="panel-head"><h2>Funding history</h2><div class="row"><select id="fh-market" aria-label="Market"></select></div></div><div class="chart-host short" id="fh-chart">${skeleton(1)}</div><p class="muted small pad" id="fh-note"></p></section>
    <section class="panel"><div class="panel-head"><h2>Cross-venue funding</h2><span class="muted small">Hourly rate, annualised</span></div><div class="tbl-wrap" id="venues">${skeleton(8)}</div></section>
  </div>
  <section class="panel"><div class="panel-head"><h2>All markets</h2><input id="mq" class="search" placeholder="Search markets" aria-label="Search markets"></div><div class="tbl-wrap tall" id="all">${skeleton(10)}</div></section>
</div>`;

const page: Page = {
  async mount(root) {
    root.innerHTML = SHELL;
    $('#heat-seg')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      st.heat = b.dataset.h as HeatMetric;
      document.querySelectorAll('#heat-seg button').forEach((x) => x.classList.toggle('on', x === b));
      paintHeat();
    });
    $('#mq')!.addEventListener('input', (e) => { st.q = (e.target as HTMLInputElement).value; paintAll(); });
    $('#all')!.addEventListener('click', (e) => {
      const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-k]');
      if (th) { const k = th.dataset.k as SortKey; st.dir = st.sort === k ? -st.dir : -1; st.sort = k; paintAll(); return; }
      const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-m]');
      if (tr) location.hash = `#/trade/${encodeURIComponent(tr.dataset.m!)}`;
    });
    $('#fh-market')!.addEventListener('change', (e) => { st.fundMarket = (e.target as HTMLSelectElement).value; void loadHistory(); });
    $('#heat')!.addEventListener('click', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-m]'); if (t) location.hash = `#/trade/${encodeURIComponent(t.dataset.m!)}`; });
    $('#venues')!.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('tr[data-fm]');
      if (t) { st.fundMarket = t.dataset.fm!; ($('#fh-market') as HTMLSelectElement).value = st.fundMarket; void loadHistory(); }
    });
    off.push(onChange(paint));
    paint();
    void loadVenues();
    venueTimer = setInterval(() => void loadVenues(), 60_000);
    void loadHistory();
  },
  unmount() {
    off.forEach((fn) => fn());
    off = [];
    if (venueTimer) clearInterval(venueTimer);
    chart?.remove();
    chart = null;
  },
};
export default page;

let lastPaint = 0;
function paint() {
  if (!$('#kpis') || !Object.keys(stats).length) return;
  const now = Date.now();
  if (now - lastPaint < 2_500 && $('#all')!.querySelector('table')) return;
  lastPaint = now;
  paintKpis(); paintHeat(); paintOpps(); paintAll(); fillSelect(); paintVenues();
}

function fillSelect() {
  const sel = $<HTMLSelectElement>('#fh-market')!;
  if (sel.options.length) return;
  sel.innerHTML = rows().sort((a, b) => b.oi - a.oi).slice(0, 100).map((r) => `<option ${r.market === st.fundMarket ? 'selected' : ''}>${esc(r.market)}</option>`).join('');
}

function paintKpis() {
  const r = rows();
  const totalOi = r.reduce((a, x) => a + x.oi, 0);
  const totalVol = r.reduce((a, x) => a + x.vol, 0);
  const wFund = totalOi ? r.reduce((a, x) => a + x.funding * x.oi, 0) / totalOi : 0;
  const hi = [...r].sort((a, b) => b.funding - a.funding)[0];
  const lo = [...r].sort((a, b) => a.funding - b.funding)[0];
  const pos = r.filter((x) => x.funding > 0).length;
  const kpi = (l: string, v: string, sub = '', tone = '') => `<div class="kpi"><label>${l}</label><b class="${tone}">${v}</b><span class="muted small">${sub}</span></div>`;
  $('#kpis')!.innerHTML = [
    kpi('24h volume', compactUsd(totalVol), `${r.length} perpetuals`),
    kpi('Open interest', compactUsd(totalOi), `${(totalVol / (totalOi || 1)).toFixed(2)}x daily turnover`),
    kpi('OI-weighted funding', fundingPct(wFund), `${pct(fundingApr(wFund), 1)} APR`, cls(wFund)),
    kpi('Funding skew', `${pos} / ${r.length - pos}`, 'markets paying longs / shorts'),
    hi ? kpi('Highest funding', `${esc(hi.market)} ${pct(hi.apr, 0)}`, 'longs pay shorts', 'up') : '',
    lo ? kpi('Lowest funding', `${esc(lo.market)} ${pct(lo.apr, 0)}`, 'shorts pay longs', 'down') : '',
  ].join('');
}

// Squarified treemap (Bruls, Huizing, van Wijk).
interface Tile { r: Row; x: number; y: number; w: number; h: number }
function treemap(items: Row[], w: number, h: number): Tile[] {
  const total = items.reduce((a, r) => a + r.oi, 0);
  const scale = (w * h) / total;
  const out: Tile[] = [];
  let x = 0, y = 0, rw = w, rh = h;
  let i = 0;
  const worst = (areas: number[], side: number) => {
    const s = areas.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...areas)) / (s * s), (s * s) / (side * side * Math.min(...areas)));
  };
  while (i < items.length) {
    const side = Math.min(rw, rh);
    const row: Row[] = [];
    let areas: number[] = [];
    while (i < items.length) {
      const a = items[i]!.oi * scale;
      if (areas.length && worst([...areas, a], side) > worst(areas, side)) break;
      row.push(items[i]!); areas.push(a); i++;
    }
    const sum = areas.reduce((a, b) => a + b, 0);
    if (rw >= rh) {
      const cw = sum / rh; let cy = y;
      row.forEach((r, k) => { const th = areas[k]! / cw; out.push({ r, x, y: cy, w: cw, h: th }); cy += th; });
      x += cw; rw -= cw;
    } else {
      const ch = sum / rw; let cx = x;
      row.forEach((r, k) => { const tw = areas[k]! / ch; out.push({ r, x: cx, y, w: tw, h: ch }); cx += tw; });
      y += ch; rh -= ch;
    }
  }
  return out;
}

function heatColor(metric: HeatMetric, r: Row): string {
  let v: number, full: number;
  if (metric === 'funding') { v = r.apr; full = 60; }
  else if (metric === 'change') { v = r.change; full = 8; }
  else { v = r.turnover - 1.5; full = 3; }
  const a = Math.min(1, Math.abs(v) / full);
  const base = v >= 0 ? '47,227,194' : '237,112,136';
  return `rgba(${base},${(0.12 + a * 0.62).toFixed(2)})`;
}

function paintHeat() {
  const host = $('#heat');
  if (!host) return;
  const items = rows().sort((a, b) => b.oi - a.oi).slice(0, 60);
  if (!items.length) { host.innerHTML = skeleton(1); return; }
  const w = host.clientWidth || 600, h = 360;
  host.style.height = `${h}px`;
  host.innerHTML = treemap(items, w, h).map(({ r, x, y, w: tw, h: th }) => {
    const label = st.heat === 'funding' ? `${r.apr >= 0 ? '+' : ''}${r.apr.toFixed(0)}%` : st.heat === 'change' ? pct(r.change, 1) : `${r.turnover.toFixed(1)}x`;
    const big = tw > 54 && th > 38;
    return `<div class="tile" data-m="${esc(r.market)}" style="left:${x}px;top:${y}px;width:${tw}px;height:${th}px;background:${heatColor(st.heat, r)}" title="${esc(r.market)}: OI ${compactUsd(r.oi)}, funding ${fundingPct(r.funding)}, 24h ${pct(r.change)}">${big ? `<b>${esc(r.market)}</b><span>${label}</span>` : ''}</div>`;
  }).join('');
}

function paintOpps() {
  const el = $('#opps');
  if (!el) return;
  const r = rows().filter((x) => x.oi > 2_000_000);
  const pay = [...r].sort((a, b) => b.apr - a.apr).slice(0, 4);
  const get = [...r].sort((a, b) => a.apr - b.apr).slice(0, 4);
  const card = (x: Row, text: string) => `<a class="opp" href="#/trade/${encodeURIComponent(x.market)}"><b>${esc(x.market)}</b><span class="${cls(x.apr)}">${pct(x.apr, 1)} APR</span><span class="muted small">${text}</span></a>`;
  el.innerHTML = `<h3 class="sub">Shorts collect (longs crowded)</h3>${pay.map((x) => card(x, `Short earns ${fundingPct(x.funding)}/h on ${compactUsd(x.oi)} OI`)).join('')}
    <h3 class="sub">Longs collect (shorts crowded)</h3>${get.map((x) => card(x, `Long earns ${fundingPct(Math.abs(x.funding))}/h on ${compactUsd(x.oi)} OI`)).join('')}
    <p class="muted small">Funding is only one input. Check the trend and the price before you lean on it. Markets under $2M OI are excluded.</p>`;
}

function paintAll() {
  const el = $('#all');
  if (!el) return;
  const q = st.q.trim().toLowerCase();
  const val = (r: Row, k: SortKey): number | string => k === 'market' ? r.market : k === 'markPx' ? r.markPx : k === 'change' ? r.change : k === 'funding' ? r.funding : k === 'oi' ? r.oi : k === 'vol' ? r.vol : k === 'turnover' ? r.turnover : r.premium;
  const list = rows().filter((r) => !q || r.market.toLowerCase().includes(q)).sort((a, b) => {
    const x = val(a, st.sort), y = val(b, st.sort);
    return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * (st.sort === 'market' ? -st.dir : st.dir);
  });
  if (!list.length) { el.innerHTML = empty('No markets match', 'Clear the search to see every perpetual.'); return; }
  const th = (k: SortKey, l: string) => `<th data-k="${k}" class="sortable ${st.sort === k ? 'sorted' : ''}" aria-sort="${st.sort === k ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  el.innerHTML = `<table class="tbl hover"><thead><tr>${th('market', 'Market')}${th('markPx', 'Price')}${th('change', '24h')}${th('funding', 'Funding /h')}<th>APR</th>${th('oi', 'Open interest')}${th('vol', '24h volume')}${th('turnover', 'Vol / OI')}${th('premium', 'Premium')}</tr></thead><tbody>${list.map((r) => `
    <tr data-m="${esc(r.market)}"><td><b>${esc(r.market)}</b> <span class="muted small">${r.maxLeverage}x</span></td><td>${px(r.markPx)}</td><td class="${cls(r.change)}">${pct(r.change)}</td><td class="${cls(r.funding)}">${fundingPct(r.funding)}</td><td class="${cls(r.apr)}">${pct(r.apr, 1)}</td><td>${compactUsd(r.oi)}</td><td>${compactUsd(r.vol)}</td><td>${r.turnover.toFixed(2)}x</td><td class="${cls(r.premium)}">${pct(r.premium * 100, 3)}</td></tr>`).join('')}</tbody></table>`;
}

async function loadVenues() {
  try {
    st.venues = await predictedFundings();
    st.venueErr = '';
  } catch (err) {
    st.venueErr = err instanceof Error ? err.message : 'Request failed';
  }
  paintVenues();
}

function paintVenues() {
  const el = $('#venues');
  if (!el) return;
  if (st.venueErr && !st.venues) { el.innerHTML = errorBox(st.venueErr, 'venue-retry'); $('#venue-retry')!.onclick = () => void loadVenues(); return; }
  if (!st.venues) return;
  const oi = new Map(rows().map((r) => [r.market, r.oi]));
  const data = Object.entries(st.venues).map(([coin, vs]) => {
    const by = Object.fromEntries(vs.map((v) => [v.venue, v.hourly]));
    const vals = vs.map((v) => v.hourly);
    return { coin, hl: by.HlPerp, bin: by.BinPerp, byb: by.BybitPerp, spread: vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : 0, oi: oi.get(coin) ?? 0, hi: vs.reduce((a, b) => (b.hourly > a.hourly ? b : a)), lo: vs.reduce((a, b) => (b.hourly < a.hourly ? b : a)) };
  }).filter((d) => d.oi > 5_000_000 && d.bin != null).sort((a, b) => b.spread - a.spread).slice(0, 14);
  const cell = (v?: number) => (v == null ? '<td class="muted">-</td>' : `<td class="${cls(v)}">${pct(fundingApr(v), 1)}</td>`);
  const names: Record<string, string> = { HlPerp: 'Hyperliquid', BinPerp: 'Binance', BybitPerp: 'Bybit' };
  el.innerHTML = `<table class="tbl hover"><thead><tr><th>Market</th><th>Hyperliquid</th><th>Binance</th><th>Bybit</th><th>Spread APR</th><th>Edge</th></tr></thead><tbody>${data.map((d) => `
    <tr data-fm="${esc(d.coin)}"><td><b>${esc(d.coin)}</b></td>${cell(d.hl)}${cell(d.bin)}${cell(d.byb)}<td><b>${pct(fundingApr(d.spread), 1, false)}</b></td><td class="muted small">Short ${names[d.hi.venue]}, long ${names[d.lo.venue]}</td></tr>`).join('')}</tbody></table>
    <p class="muted small pad">Rates are normalised to one hour from each venue's own funding interval, then annualised. A spread is a funding-capture idea, not a risk-free trade: basis, fees and liquidation risk apply on every leg.</p>`;
}

async function loadHistory() {
  const host = $('#fh-chart');
  if (!host) return;
  const market = st.fundMarket;
  try {
    const pts = await fundingHistory(market, 7);
    if (st.fundMarket !== market || !$('#fh-chart')) return;
    if (!pts.length) { host.innerHTML = empty('No funding history', `${market} has no funding records in the last 7 days.`); return; }
    if (!chart) { host.innerHTML = ''; chart = baseChart(host); }
    const series = chart.addSeries(LineSeries, { color: COLORS.accent, lineWidth: 2, priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%` } });
    series.setData(pts.map((p) => ({ time: (p.time / 1000) as UTCTimestamp, value: fundingApr(p.rate) })));
    chart.timeScale().fitContent();
    const avg = pts.reduce((a, p) => a + p.rate, 0) / pts.length;
    $('#fh-note')!.textContent = `${market}: 7-day average ${pct(fundingApr(avg), 1)} APR (${fundingPct(avg)} per hour). Annualised hourly funding.`;
    const prev = (host as any).__series as ReturnType<IChartApi['addSeries']> | undefined;
    if (prev) chart.removeSeries(prev);
    (host as any).__series = series;
  } catch (err) {
    host.innerHTML = errorBox(err instanceof Error ? err.message : 'Request failed', 'fh-retry');
    chart?.remove(); chart = null;
    $('#fh-retry')!.onclick = () => { host.innerHTML = skeleton(1); void loadHistory(); };
  }
}
