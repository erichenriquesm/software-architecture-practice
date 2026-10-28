import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('inbox')
      .addColumn('consumer', 'text', (column) => column.notNull())
      .addColumn('message_key', 'text', (column) => column.notNull())
      .addColumn('processed_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint('inbox_pkey', ['consumer', 'message_key'])
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('inbox').execute();
  }
}
