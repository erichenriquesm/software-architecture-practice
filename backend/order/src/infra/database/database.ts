import type { ColumnType, Generated } from 'kysely';

type Numeric = ColumnType<string, string, string>;
type NullableNumeric = ColumnType<string | null, string | null, string | null>;
type BigInt = ColumnType<string, number, number>;

export interface Database {
  order: OrderTable;
  order_view: OrderViewTable;
  outbox: OutboxTable;
  inbox: InboxTable;
  idempotency_key: IdempotencyKeyTable;
}

export interface OrderTable {
  order_id: string;
  market_id: string;
  account_id: string;
  side: string;
  quantity: Numeric;
  price: Numeric;
  fill_quantity: Numeric;
  fill_value: Numeric;
  reservation: string;
  void_reason: string | null;
  reject_reason: string | null;
  removal_reason: string | null;
  cancel_requested: boolean;
  removed_quantity: NullableNumeric;
  created_at: Date;
  version: BigInt;
}

export interface OrderViewTable {
  order_id: string;
  account_id: string;
  market_id: string;
  side: string;
  quantity: Numeric;
  price: Numeric;
  fill_quantity: Numeric;
  fill_price: NullableNumeric;
  status: string;
  status_reason: string | null;
  timestamp: Date;
  updated_at: Date;
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

export interface IdempotencyKeyTable {
  scope: string;
  key: string;
  request_hash: string;
  state: string;
  status_code: number | null;
  response_body: ColumnType<unknown, string | null, string | null>;
  created_at: Generated<Date>;
  expires_at: Date;
}
