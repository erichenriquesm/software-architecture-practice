import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('trade')
      .addColumn('trade_id', 'uuid', (column) => column.primaryKey())
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('buy_order_id', 'uuid', (column) => column.notNull())
      .addColumn('sell_order_id', 'uuid', (column) => column.notNull())
      .addColumn('buy_account_id', 'uuid', (column) => column.notNull())
      .addColumn('sell_account_id', 'uuid', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('executed_at', 'timestamptz', (column) => column.notNull())
      .addColumn('book_sequence', 'bigint', (column) => column.notNull())
      .addCheckConstraint('trade_not_self', sql`buy_account_id <> sell_account_id`)
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('trade').execute();
  }
}
