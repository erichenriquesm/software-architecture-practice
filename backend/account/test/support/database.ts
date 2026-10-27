import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import type { Database } from '../../src/infra/adapters/outbound/persistence/database.js';
import { SqlFileMigrationProvider } from '../../src/infra/adapters/outbound/persistence/sqlFileMigrationProvider.js';

const adminUrl = (): string => process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:5432/postgres';

const kyselyFor = (connectionString: string): Kysely<Database> =>
  new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 5 }) }) });

export interface TestDatabase {
  readonly db: Kysely<Database>;
  destroy(): Promise<void>;
}

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = kyselyFor(adminUrl());
  await sql.raw(`create database ${name}`).execute(admin);

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const db = kyselyFor(url.toString());
  const { error } = await new Migrator({ db, provider: new SqlFileMigrationProvider('migrations') }).migrateToLatest();
  if (error) throw error;

  return {
    db,
    destroy: async () => {
      await db.destroy();
      await sql.raw(`drop database ${name} with (force)`).execute(admin);
      await admin.destroy();
    },
  };
};
