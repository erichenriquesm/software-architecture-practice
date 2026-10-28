import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('trade_view')
      .addColumn('trade_id', 'uuid', (column) => column.primaryKey())
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('buy_order_id', 'uuid', (column) => column.notNull())
      .addColumn('sell_order_id', 'uuid', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('executed_at', 'timestamptz', (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex('trade_view_market_time')
      .on('trade_view')
      .columns(['market_id', 'executed_at desc', 'trade_id desc'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('trade_view').execute();
  }
}
