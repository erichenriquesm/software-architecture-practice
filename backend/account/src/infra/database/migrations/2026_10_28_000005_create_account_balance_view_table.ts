import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('account_balance_view')
      .addColumn('account_id', 'uuid', (column) => column.notNull())
      .addColumn('asset_id', 'text', (column) => column.notNull())
      .addColumn('available', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('reserved', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('version', 'bigint', (column) => column.notNull())
      .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
      .addPrimaryKeyConstraint('account_balance_view_pkey', ['account_id', 'asset_id'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('account_balance_view').execute();
  }
}
