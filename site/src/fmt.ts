export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Hyperliquid shows prices with up to five significant figures. */
export function px(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  const dec = abs >= 10_000 ? 0 : abs >= 1_000 ? 1 : abs >= 100 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : abs >= 0.1 ? 5 : abs >= 0.01 ? 6 : 7;
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function usd(v: number | null | undefined, dec = 2): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function signedUsd(v: number, dec = 2): string {
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${usd(Math.abs(v), dec)}`;
}

export function compact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

export const compactUsd = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '-' : `$${compact(v)}`);

export function pct(v: number | null | undefined, dec = 2, sign = true): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${sign && v > 0 ? '+' : ''}${v.toFixed(dec)}%`;
}

/** Hourly funding rate as Hyperliquid prints it. */
export const fundingPct = (rate: number | null | undefined) => (rate == null ? '-' : `${(rate * 100).toFixed(4)}%`);

/** Hourly rate annualised: 24 * 365. */
export const fundingApr = (rate: number) => rate * 24 * 365 * 100;

export function size(v: number, dec: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
export const dateTime = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const OPENING = new Set(['open', 'add']);
/** Closing fills carry the order side, which is opposite the position they close. This returns the position's side. */
export const positionSide = (t: { side: 'long' | 'short'; kind: string }): 'long' | 'short' =>
  OPENING.has(t.kind) ? t.side : t.side === 'long' ? 'short' : 'long';
