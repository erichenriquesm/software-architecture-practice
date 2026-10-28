import type { ColumnType, Generated } from 'kysely';

type Numeric = ColumnType<string, string, string>;
type NullableNumeric = ColumnType<string | null, string | null, string | null>;
type BigInt = ColumnType<string, number, number>;

export interface Database {
  trade_view: TradeViewTable;
  candle_1m_view: Candle1mViewTable;
  book_state_view: BookStateViewTable;
  depth_view: DepthViewTable;
  inbox: InboxTable;
}

export interface TradeViewTable {
  trade_id: string;
  market_id: string;
  buy_order_id: string;
  sell_order_id: string;
  side: string;
  quantity: Numeric;
  price: Numeric;
  executed_at: Date;
}

export interface Candle1mViewTable {
  market_id: string;
  bucket_start: Date;
  open_price: Numeric;
  open_at: Date;
  open_trade_id: string;
  close_price: Numeric;
  close_at: Date;
  close_trade_id: string;
  min_price: Numeric;
  max_price: Numeric;
  volume: Numeric;
  trade_count: number;
}

export interface BookStateViewTable {
  market_id: string;
  sequence: BigInt;
  best_bid: NullableNumeric;
  best_ask: NullableNumeric;
  updated_at: Date;
}

export interface DepthViewTable {
  market_id: string;
  precision: number;
  side: string;
  price: Numeric;
  quantity: Numeric;
}

export interface InboxTable {
  consumer: string;
  message_key: string;
  processed_at: Generated<Date>;
}
