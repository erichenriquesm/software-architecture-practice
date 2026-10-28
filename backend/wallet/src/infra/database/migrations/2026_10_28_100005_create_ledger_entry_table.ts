import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('ledger_entry')
      .addColumn('id', 'bigserial', (column) => column.primaryKey())
      .addColumn('account_id', 'uuid', (column) => column.notNull())
      .addColumn('asset_id', 'text', (column) => column.notNull())
      .addColumn('available_delta', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('reserved_delta', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('reason', 'text', (column) => column.notNull())
      .addColumn('reference_id', 'text')
      .addColumn('wallet_version', 'bigint', (column) => column.notNull())
      .addColumn('created_at', 'timestamptz', (column) => column.notNull())
      .execute();
    await db.schema.createIndex('ledger_entry_account').on('ledger_entry').columns(['account_id', 'id']).execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('ledger_entry').execute();
  }
}
