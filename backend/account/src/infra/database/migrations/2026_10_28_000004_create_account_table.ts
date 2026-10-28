import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('account')
      .addColumn('account_id', 'uuid', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('email', 'text', (column) => column.notNull())
      .addColumn('document', 'text', (column) => column.notNull())
      .addColumn('password_hash', 'text', (column) => column.notNull())
      .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
      .execute();
    await db.schema.createIndex('account_email_uq').on('account').unique().expression(sql`lower(email)`).execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('account').execute();
  }
}
