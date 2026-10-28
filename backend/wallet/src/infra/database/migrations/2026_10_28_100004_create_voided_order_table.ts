import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('voided_order')
      .addColumn('order_id', 'uuid', (column) => column.primaryKey())
      .addColumn('voided_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('voided_order').execute();
  }
}
