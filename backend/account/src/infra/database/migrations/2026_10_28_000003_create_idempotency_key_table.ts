import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('idempotency_key')
      .addColumn('scope', 'text', (column) => column.notNull())
      .addColumn('key', 'text', (column) => column.notNull())
      .addColumn('request_hash', 'text', (column) => column.notNull())
      .addColumn('state', 'text', (column) => column.notNull())
      .addColumn('status_code', 'integer')
      .addColumn('response_body', 'jsonb')
      .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
      .addPrimaryKeyConstraint('idempotency_key_pkey', ['scope', 'key'])
      .execute();
    await db.schema.createIndex('idempotency_key_expired').on('idempotency_key').column('expires_at').execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('idempotency_key').execute();
  }
}
