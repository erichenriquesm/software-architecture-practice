import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('outbox')
      .addColumn('id', 'bigserial', (column) => column.primaryKey())
      .addColumn('event_id', 'uuid', (column) => column.notNull().unique())
      .addColumn('type', 'text', (column) => column.notNull())
      .addColumn('routing_key', 'text', (column) => column.notNull())
      .addColumn('envelope', 'jsonb', (column) => column.notNull())
      .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn('published_at', 'timestamptz')
      .execute();
    await db.schema.createIndex('outbox_unpublished').on('outbox').column('id').where(sql.ref('published_at'), 'is', null).execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('outbox').execute();
  }
}
