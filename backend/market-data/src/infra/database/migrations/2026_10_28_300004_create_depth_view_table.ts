import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('depth_view')
      .addColumn('market_id', 'text', (column) => column.notNull())
      .addColumn('precision', 'smallint', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('quantity', sql`numeric(36, 8)`, (column) => column.notNull())
      .addPrimaryKeyConstraint('depth_view_pkey', ['market_id', 'precision', 'side', 'price'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('depth_view').execute();
  }
}
