import type { Kysely } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('book')
      .addColumn('market_id', 'text', (column) => column.primaryKey())
      .addColumn('sequence', 'bigint', (column) => column.notNull())
      .addColumn('next_priority', 'bigint', (column) => column.notNull())
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('book').execute();
  }
}
