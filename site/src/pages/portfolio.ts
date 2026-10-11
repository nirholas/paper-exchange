import { AreaSeries, type UTCTimestamp } from 'lightweight-charts';
import type { Trade } from '../../../src/types.js';
import { baseChart, COLORS } from '../charts.js';
import { cls, dateTime, esc, pct, positionSide, px, signedUsd, size as fmtSize, usd } from '../fmt.js';
import { account, exchange, exportBackup, id, importBackup, onChange } from '../state.js';
import { $, empty, toast, type Page } from '../ui.js';

let off: (() => void)[] = [];
let chart: ReturnType<typeof baseChart> | null = null;

const CLOSING = new Set(['close', 'reduce', 'liquidation', 'stop_loss', 'take_profit']);

const page: Page = {
  mount(root) {
    root.innerHTML = `<div class="dash"><header class="dash-head"><div><h1>Portfolio</h1><p class="muted">Your paper account, measured the way a trading journal should. Stored in this browser.</p></div>
      <div class="row"><button class="btn" id="exp">Export backup</button><label class="btn" for="imp">Import backup</label><input type="file" id="imp" accept="application/json" hidden></div></header>
      <section class="kpis" id="p-kpis"></section>
      <div class="grid2"><section class="panel"><div class="panel-head"><h2>Realized equity curve</h2><span class="muted small">Starting balance plus realized PnL after fees</span></div><div class="chart-host short" id="p-chart"></div></section>
      <section class="panel"><div class="panel-head"><h2>By market</h2></div><div class="tbl-wrap" id="p-markets"></div></section></div>
      <section class="panel"><div class="panel-head"><h2>Journal</h2><span class="muted small">Closed trades, newest first</span></div><div class="tbl-wrap" id="p-journal"></div></section></div>`;
    $('#exp')!.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([exportBackup()], { type: 'application/json' }));
      a.download = `paper-exchange-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
    };
    $('#imp')!.addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try { importBackup(await f.text()); } catch (err) { toast(err instanceof Error ? err.message : 'Import failed.', 'err'); }
    });
    off.push(onChange(paint));
    paint();
  },
  unmount() { off.forEach((f) => f()); off = []; chart?.remove(); chart = null; },
};
export default page;

function paint() {
  if (!$('#p-kpis') || !account) return;
  const all = exchange.trades(id(), 5000);
  const closed = all.filter((t) => CLOSING.has(t.kind)).reverse();
  const wins = closed.filter((t) => t.realizedPnl > 0), losses = closed.filter((t) => t.realizedPnl < 0);
  const gw = wins.reduce((a, t) => a + t.realizedPnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const kpi = (l: string, v: string, sub = '', tone = '') => `<div class="kpi"><label>${l}</label><b class="${tone}">${v}</b><span class="muted small">${sub}</span></div>`;
  $('#p-kpis')!.innerHTML = [
    kpi('Equity', usd(account.equity), `${pct(account.totalReturnPct)} since start`, cls(account.totalReturnPct)),
    kpi('Realized PnL', signedUsd(account.realizedPnl), 'after fees', cls(account.realizedPnl)),
    kpi('Win rate', closed.length ? pct((wins.length / closed.length) * 100, 1, false) : '-', `${wins.length}W / ${losses.length}L`),
    kpi('Profit factor', gl ? (gw / gl).toFixed(2) : gw ? 'No losses' : '-', 'gross wins / gross losses'),
    kpi('Avg win / loss', wins.length || losses.length ? `${usd(wins.length ? gw / wins.length : 0, 0)} / ${usd(losses.length ? gl / losses.length : 0, 0)}` : '-', 'per closed trade'),
    kpi('Net funding', signedUsd(-account.fundingPaid), `Fees ${usd(account.feesPaid)}`, cls(-account.fundingPaid)),
    kpi('Liquidations', String(account.liquidations), `${account.tradeCount} fills`, account.liquidations ? 'down' : ''),
  ].join('');

  const host = $('#p-chart')!;
  if (!closed.length) host.innerHTML = empty('No closed trades yet', 'Close a position and your realized equity curve starts here.');
  else {
    if (!chart || !host.querySelector('.tv-lightweight-charts')) { host.innerHTML = ''; chart = baseChart(host); }
    const startEq = account.startingBalance;
    let eq = startEq;
    const pts = [{ time: Math.floor(closed[0]!.createdAt / 1000) - 1, value: startEq }, ...closed.map((t) => ({ time: Math.floor(t.createdAt / 1000), value: (eq += t.realizedPnl) }))];
    const dedup = pts.filter((p, i) => i === pts.length - 1 || p.time !== pts[i + 1]!.time);
    const s = chart.addSeries(AreaSeries, { lineColor: eq >= startEq ? COLORS.up : COLORS.down, topColor: eq >= startEq ? 'rgba(47,227,194,0.28)' : 'rgba(237,112,136,0.28)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2 });
    s.setData(dedup.map((p) => ({ time: p.time as UTCTimestamp, value: +p.value.toFixed(2) })));
    chart.timeScale().fitContent();
  }

  const byMarket = new Map<string, { n: number; w: number; pnl: number }>();
  for (const t of closed) { const m = byMarket.get(t.market) ?? { n: 0, w: 0, pnl: 0 }; m.n++; m.pnl += t.realizedPnl; if (t.realizedPnl > 0) m.w++; byMarket.set(t.market, m); }
  $('#p-markets')!.innerHTML = byMarket.size
    ? `<table class="tbl"><thead><tr><th>Market</th><th>Trades</th><th>Win rate</th><th>PnL</th></tr></thead><tbody>${[...byMarket].sort((a, b) => b[1].pnl - a[1].pnl).map(([m, v]) => `<tr><td><b>${esc(m)}</b></td><td>${v.n}</td><td>${((v.w / v.n) * 100).toFixed(0)}%</td><td class="${cls(v.pnl)}">${signedUsd(v.pnl)}</td></tr>`).join('')}</tbody></table>`
    : empty('Nothing to break down', 'Per-market results appear after your first closed trade.');

  $('#p-journal')!.innerHTML = closed.length
    ? `<table class="tbl"><thead><tr><th>Closed</th><th>Market</th><th>Side</th><th>Exit</th><th>Entry</th><th>Size</th><th>Lev</th><th>Result</th><th>PnL</th><th></th></tr></thead><tbody>${[...closed].reverse().slice(0, 200).map(journalRow).join('')}</tbody></table>`
    : empty('Your journal is empty', 'Every close, stop-out, take-profit and liquidation is logged with entry, exit, leverage and PnL.', '<a class="btn primary" href="#/trade">Open the terminal</a>');
}

const KIND: Record<string, string> = { close: 'Closed', reduce: 'Reduced', liquidation: 'Liquidated', stop_loss: 'Stop loss', take_profit: 'Take profit' };

function journalRow(t: Trade): string {
  const margin = (t.size * t.entryPrice) / t.leverage;
  return `<tr><td class="muted">${dateTime(t.createdAt)}</td><td><b>${esc(t.market)}</b></td><td class="${positionSide(t) === 'long' ? 'up' : 'down'}">${positionSide(t) === 'long' ? 'Long' : 'Short'}</td><td>${px(t.price)}</td><td>${px(t.entryPrice)}</td><td>${fmtSize(t.size, 4)}</td><td>${t.leverage}x</td><td>${KIND[t.kind] ?? t.kind}</td><td class="${cls(t.realizedPnl)}">${signedUsd(t.realizedPnl)} (${pct((t.realizedPnl / margin) * 100)})</td><td class="acts"><a class="btn sm" href="#/cards/trade:${encodeURIComponent(t.id)}">Card</a></td></tr>`;
}
