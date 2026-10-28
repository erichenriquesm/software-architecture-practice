import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from '../../src/infra/database/database.js';
import { loadMigrationFiles } from '../../src/infra/database/migrationFiles.js';
import { Migrator } from '../../src/infra/database/migrator.js';

const adminUrl = (): string => process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5432/postgres';

const kyselyFor = (connectionString: string): Kysely<Database> => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // `drop database ... with (force)` ends idle connections on purpose when a test file finishes
  pool.on('error', () => undefined);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
};

export interface TestDatabase {
  readonly db: Kysely<Database>;
  readonly url: string;
  destroy(): Promise<void>;
}

/** A brand-new database per test file, migrated from zero with the real migrations. */
export const createTestDatabase = async (options: { migrate?: boolean } = {}): Promise<TestDatabase> => {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = kyselyFor(adminUrl());
  await sql.raw(`create database ${name}`).execute(admin);

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const db = kyselyFor(url.toString());
  if (options.migrate ?? true) await new Migrator(db as Kysely<unknown>, () => loadMigrationFiles()).migrate();

  return {
    db,
    url: url.toString(),
    destroy: async () => {
      await db.destroy();
      await sql.raw(`drop database ${name} with (force)`).execute(admin);
      await admin.destroy();
    },
  };
};
