import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('balance')
      .addColumn('account_id', 'uuid', (column) => column.notNull().references('wallet.account_id'))
      .addColumn('asset_id', 'text', (column) => column.notNull())
      .addColumn('available', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('reserved', sql`numeric(36, 8)`, (column) => column.notNull())
      .addPrimaryKeyConstraint('balance_pkey', ['account_id', 'asset_id'])
      .addCheckConstraint('balance_available_not_negative', sql`available >= 0`)
      .addCheckConstraint('balance_reserved_not_negative', sql`reserved >= 0`)
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('balance').execute();
  }
}
