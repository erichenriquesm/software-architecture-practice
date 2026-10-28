import type { ColumnType, Generated } from 'kysely';

type Numeric = ColumnType<string, string, string>;
type BigInt = ColumnType<string, number, number>;

export interface Database {
  wallet: WalletTable;
  balance: BalanceTable;
  reservation: ReservationTable;
  voided_order: VoidedOrderTable;
  ledger_entry: LedgerEntryTable;
  outbox: OutboxTable;
  inbox: InboxTable;
  idempotency_key: IdempotencyKeyTable;
}

export interface WalletTable {
  account_id: string;
  version: BigInt;
  created_at: Generated<Date>;
}

export interface BalanceTable {
  account_id: string;
  asset_id: string;
  available: Numeric;
  reserved: Numeric;
}

export interface ReservationTable {
  order_id: string;
  account_id: string;
  asset_id: string;
  side: string;
  limit_price: Numeric;
  remaining: Numeric;
  status: string;
  created_at: Date;
}

export interface VoidedOrderTable {
  order_id: string;
  voided_at: Generated<Date>;
}

export interface LedgerEntryTable {
  id: Generated<string>;
  account_id: string;
  asset_id: string;
  available_delta: Numeric;
  reserved_delta: Numeric;
  reason: string;
  reference_id: string | null;
  wallet_version: BigInt;
  created_at: Date;
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
