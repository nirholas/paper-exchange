import type { Config, Position, Side } from './types.js';

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export const usd = (n: number) => round(n, 6);
export const roundSize = (n: number, dp: number) => Math.floor(n * 10 ** dp + 1e-9) / 10 ** dp;

/** Price a market order fills at when no order book is available: `side` is the order side (long buys, short sells), moved against the taker by slippage plus size impact. */
export function marketFillPrice(mid: number, side: Side, notional: number, cfg: Config): number {
  const bps = cfg.slippageBps + notional / cfg.impactUsdPerBp;
  return mid * (1 + (side === 'long' ? 1 : -1) * (bps / 10_000));
}

export function fee(notional: number, bps: number): number {
  return usd((notional * bps) / 10_000);
}

export function unrealizedPnl(side: Side, entry: number, mark: number, size: number): number {
  return (side === 'long' ? mark - entry : entry - mark) * size;
}

/**
 * Mark price at which equity (margin plus PnL) falls to the maintenance requirement, `mmr` of current notional.
 * Uses the position's live margin, so funding paid or received moves it.
 */
export function liquidationPrice(side: Side, entry: number, size: number, margin: number, mmr: number): number {
  return side === 'long' ? (size * entry - margin) / (size * (1 - mmr)) : (size * entry + margin) / (size * (1 + mmr));
}

export function positionEquity(p: Position, mark: number): number {
  return p.margin + unrealizedPnl(p.side, p.entryPrice, mark, p.size);
}

export function isLiquidated(p: Position, mark: number, mmr: number): boolean {
  if (mark <= 0) return true;
  const liq = liquidationPrice(p.side, p.entryPrice, p.size, p.margin, mmr);
  return p.side === 'long' ? mark <= liq : mark >= liq;
}

export function wouldTriggerStop(side: Side, stopLoss: number | null, takeProfit: number | null, mark: number): 'stop_loss' | 'take_profit' | null {
  if (stopLoss !== null && (side === 'long' ? mark <= stopLoss : mark >= stopLoss)) return 'stop_loss';
  if (takeProfit !== null && (side === 'long' ? mark >= takeProfit : mark <= takeProfit)) return 'take_profit';
  return null;
}

/**
 * Volume-weighted fill price for taking `size` base units from one side of the book.
 * Returns null when the visible book is too thin to fill the whole order.
 */
export function bookFillPrice(levels: [number, number][], size: number): number | null {
  let remaining = size;
  let cost = 0;
  for (const [px, sz] of levels) {
    const take = Math.min(remaining, sz);
    cost += take * px;
    remaining -= take;
    if (remaining <= 1e-12) return cost / size;
  }
  return null;
}

/** Funding owed by a position over `elapsedMs` at an hourly `rate`. Positive means the position pays. */
export function fundingPayment(side: Side, size: number, mark: number, rate: number, elapsedMs: number): number {
  const owed = size * mark * rate * (elapsedMs / 3_600_000);
  return side === 'long' ? owed : -owed;
}
