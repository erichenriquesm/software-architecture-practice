import type { ColumnType, Generated } from 'kysely';

type Numeric = ColumnType<string, string, string>;
type BigInt = ColumnType<string, number, number>;

export interface Database {
  book: BookTable;
  book_entry: BookEntryTable;
  trade: TradeTable;
  outbox: OutboxTable;
  inbox: InboxTable;
}

export interface BookTable {
  market_id: string;
  sequence: BigInt;
  next_priority: BigInt;
}

export interface BookEntryTable {
  order_id: string;
  market_id: string;
  account_id: string;
  side: string;
  price: Numeric;
  remaining: Numeric;
  priority: BigInt;
  accepted_at: Date;
}

export interface TradeTable {
  trade_id: string;
  market_id: string;
  buy_order_id: string;
  sell_order_id: string;
  buy_account_id: string;
  sell_account_id: string;
  side: string;
  quantity: Numeric;
  price: Numeric;
  executed_at: Date;
  book_sequence: BigInt;
}

export interface OutboxTable {
  id: Generated<string>;
  event_id: string;
  type: string;
  routing_key: string;
  envelope: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
  published_at: Date | null;
}

export interface InboxTable {
  consumer: string;
  message_key: string;
  processed_at: Generated<Date>;
}
