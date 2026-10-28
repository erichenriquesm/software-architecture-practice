import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('candle_1m_view')
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('bucket_start', 'timestamptz', (column) => column.notNull())
      .addColumn('open_price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('open_at', 'timestamptz', (column) => column.notNull())
      .addColumn('open_trade_id', 'uuid', (column) => column.notNull())
      .addColumn('close_price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('close_at', 'timestamptz', (column) => column.notNull())
      .addColumn('close_trade_id', 'uuid', (column) => column.notNull())
      .addColumn('min_price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('max_price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('volume', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('trade_count', 'integer', (column) => column.notNull())
      .addPrimaryKeyConstraint('candle_1m_view_pkey', ['market_id', 'bucket_start'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('candle_1m_view').execute();
  }
}
