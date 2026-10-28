import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('order')
      .addColumn('order_id', 'uuid', (column) => column.primaryKey())
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('account_id', 'uuid', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('fill_quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('fill_value', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('reservation', 'text', (column) => column.notNull())
      .addColumn('void_reason', 'text')
      .addColumn('reject_reason', 'text')
      .addColumn('removal_reason', 'text')
      .addColumn('cancel_requested', 'boolean', (column) => column.notNull())
      .addColumn('removed_quantity', sql`numeric(36, 8)`)
      .addColumn('created_at', 'timestamptz', (column) => column.notNull())
      .addColumn('version', 'bigint', (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex('order_pending')
      .on('order')
      .column('created_at')
      .where(sql.ref('reservation'), '=', 'pending')
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('order').execute();
  }
}
