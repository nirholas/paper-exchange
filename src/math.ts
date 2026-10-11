import type { Config, Position, Side } from './types.js';

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export const usd = (n: number) => round(n, 6);
export const roundSize = (n: number, dp: number) => Math.floor(n * 10 ** dp + 1e-9) / 10 ** dp;

/** Price a market order actually fills at: mid moved against the taker by slippage plus size impact. */
export function marketFillPrice(mid: number, side: Side, closing: boolean, notional: number, cfg: Config): number {
  const buying = (side === 'long') !== closing;
  const bps = cfg.slippageBps + notional / cfg.impactUsdPerBp;
  return mid * (1 + (buying ? 1 : -1) * (bps / 10_000));
}

export function fee(notional: number, bps: number): number {
  return usd((notional * bps) / 10_000);
}

export function unrealizedPnl(side: Side, entry: number, mark: number, size: number): number {
  return (side === 'long' ? mark - entry : entry - mark) * size;
}

/** Mark price at which the position's equity falls to its maintenance margin. */
export function liquidationPrice(side: Side, entry: number, leverage: number, mmr: number): number {
  return side === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function positionEquity(p: Position, mark: number): number {
  return p.margin + unrealizedPnl(p.side, p.entryPrice, mark, p.size);
}

export function isLiquidated(p: Position, mark: number, mmr: number): boolean {
  return mark <= 0 || (p.side === 'long' ? mark <= liquidationPrice(p.side, p.entryPrice, p.leverage, mmr) : mark >= liquidationPrice(p.side, p.entryPrice, p.leverage, mmr));
}

export function wouldTriggerStop(side: Side, stopLoss: number | null, takeProfit: number | null, mark: number): 'stop_loss' | 'take_profit' | null {
  if (stopLoss !== null && (side === 'long' ? mark <= stopLoss : mark >= stopLoss)) return 'stop_loss';
  if (takeProfit !== null && (side === 'long' ? mark >= takeProfit : mark <= takeProfit)) return 'take_profit';
  return null;
}
