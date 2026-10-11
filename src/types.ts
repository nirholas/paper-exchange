export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit';

export interface Market {
  name: string;
  maxLeverage: number;
  /** Decimal places the venue allows for order size. */
  sizeDecimals: number;
}

export interface Config {
  startingBalance: number;
  takerFeeBps: number;
  makerFeeBps: number;
  /** Flat slippage applied to every market fill. */
  slippageBps: number;
  /** Notional (USD) that adds one more bp of price impact. */
  impactUsdPerBp: number;
  /** Maintenance margin as a fraction of notional. */
  maintenanceMarginRate: number;
  maxOpenPositions: number;
  maxOpenOrders: number;
}

export const DEFAULT_CONFIG: Config = {
  startingBalance: 10_000,
  takerFeeBps: 4.5,
  makerFeeBps: 1.5,
  slippageBps: 2,
  impactUsdPerBp: 50_000,
  maintenanceMarginRate: 0.005,
  maxOpenPositions: 20,
  maxOpenOrders: 50,
};

export interface Account {
  id: string;
  name: string;
  balance: number;
  startingBalance: number;
  realizedPnl: number;
  feesPaid: number;
  tradeCount: number;
  liquidations: number;
  createdAt: number;
}

export interface Position {
  accountId: string;
  market: string;
  side: Side;
  /** Size in base units. */
  size: number;
  entryPrice: number;
  margin: number;
  leverage: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
}

export interface Order {
  id: string;
  accountId: string;
  market: string;
  side: Side;
  type: OrderType;
  size: number;
  limitPrice: number;
  leverage: number;
  reduceOnly: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Margin held back from the balance while the order rests. */
  reservedMargin: number;
  status: 'open' | 'filled' | 'cancelled';
  createdAt: number;
}

export type TradeKind = 'open' | 'add' | 'reduce' | 'close' | 'liquidation' | 'stop_loss' | 'take_profit';

export interface Trade {
  id: string;
  accountId: string;
  market: string;
  side: Side;
  kind: TradeKind;
  size: number;
  price: number;
  fee: number;
  realizedPnl: number;
  liquidity: 'taker' | 'maker';
  createdAt: number;
}

export interface PriceFeed {
  markets(): Promise<Market[]>;
  /** Mid prices for every market, keyed by market name. */
  mids(): Promise<Record<string, number>>;
  candles(market: string, interval: string, count: number): Promise<Candle[]>;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class ExchangeError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'unknown_market'
      | 'insufficient_balance'
      | 'limit_exceeded'
      | 'no_position'
      | 'not_found'
      | 'unauthorized'
      | 'price_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}
