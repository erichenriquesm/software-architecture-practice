import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('book_state_view')
      .addColumn('market_id', 'text', (column) => column.primaryKey())
      .addColumn('sequence', 'bigint', (column) => column.notNull())
      .addColumn('best_bid', sql`numeric(36, 8)`)
      .addColumn('best_ask', sql`numeric(36, 8)`)
      .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('book_state_view').execute();
  }
}
