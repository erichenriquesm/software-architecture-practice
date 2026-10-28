import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('reservation')
      .addColumn('order_id', 'uuid', (column) => column.primaryKey())
      .addColumn('account_id', 'uuid', (column) => column.notNull().references('wallet.account_id'))
      .addColumn('asset_id', 'text', (column) => column.notNull())
      .addColumn('side', 'text', (column) => column.notNull())
      .addColumn('limit_price', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('remaining', sql`numeric(36, 8)`, (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('created_at', 'timestamptz', (column) => column.notNull())
      .addCheckConstraint('reservation_remaining_not_negative', sql`remaining >= 0`)
      .execute();
    await db.schema
      .createIndex('reservation_open')
      .on('reservation')
      .column('account_id')
      .where(sql.ref('status'), '=', 'open')
      .execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('reservation').execute();
  }
}
