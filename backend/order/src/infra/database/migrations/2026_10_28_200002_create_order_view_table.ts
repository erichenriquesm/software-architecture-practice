import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('order_view')
      .addColumn('order_id', 'uuid', (column) => column.primaryKey())
      .addColumn('account_id', 'uuid', (column) => column.notNull())
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('fill_quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('fill_price', sql`numeric(36, 8)`)
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('status_reason', 'text')
      .addColumn('timestamp', 'timestamptz', (column) => column.notNull())
      .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex('order_view_account')
      .on('order_view')
      .columns(['account_id', 'status', 'timestamp desc'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('order_view').execute();
  }
}
