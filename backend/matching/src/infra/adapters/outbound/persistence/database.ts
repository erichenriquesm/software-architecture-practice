import type { ColumnType, Generated } from 'kysely';

export interface Database {
  outbox: OutboxTable;
  inbox: InboxTable;
  idempotency_key: IdempotencyKeyTable;
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
