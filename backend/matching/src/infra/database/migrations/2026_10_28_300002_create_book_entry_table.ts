import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('book_entry')
      .addColumn('order_id', 'uuid', (column) => column.primaryKey())
      .addColumn('market_id', 'text', (column) => column.notNull().references('book.market_id'))
      .addColumn('account_id', 'uuid', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('remaining', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('priority', 'bigint', (column) => column.notNull())
      .addColumn('accepted_at', 'timestamptz', (column) => column.notNull())
      .addCheckConstraint('book_entry_remaining_positive', sql`remaining > 0`)
      .execute();
    await db.schema.createIndex('book_entry_load').on('book_entry').columns(['market_id', 'side', 'price', 'priority']).execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('book_entry').execute();
  }
}
