import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { loadMigrationFiles } from '../../../../src/infra/database/migrationFiles.js';
import type { Migration, MigrationFile } from '../../../../src/infra/database/migrator.js';
import { Migrator } from '../../../../src/infra/database/migrator.js';

const tableMigration = (table: string): Migration => ({
  up: async (db) => void (await db.schema.createTable(table).addColumn('id', 'integer').execute()),
  down: async (db) => void (await db.schema.dropTable(table).execute()),
});

let database: TestDatabase;
let db: Kysely<unknown>;

const tables = async (): Promise<string[]> =>
  (await sql<{ name: string }>`select tablename as name from pg_tables where schemaname = current_schema() order by 1`.execute(db)).rows.map(
    (row) => row.name,
  );

beforeEach(async () => {
  database = await createTestDatabase({ migrate: false });
  db = database.db as Kysely<unknown>;
});

afterEach(async () => {
  await database.destroy();
});

describe('Migrator (Laravel-style batches)', () => {
  test('Should run pending files as one batch per migrate and roll back only the last batch', async () => {
    // Given
    const files: MigrationFile[] = [{ name: '2026_01_01_000001_create_first', migration: tableMigration('first') }];
    const migrator = new Migrator(db, async () => files);

    // When
    const firstBatch = await migrator.migrate();
    files.push({ name: '2026_01_01_000002_create_second', migration: tableMigration('second') });
    files.push({ name: '2026_01_01_000003_create_third', migration: tableMigration('third') });
    const secondBatch = await migrator.migrate();
    const nothing = await migrator.migrate();

    // Then
    expect(firstBatch).toEqual(['2026_01_01_000001_create_first']);
    expect(secondBatch).toEqual(['2026_01_01_000002_create_second', '2026_01_01_000003_create_third']);
    expect(nothing).toEqual([]);
    expect(await migrator.status()).toEqual([
      { name: '2026_01_01_000001_create_first', ran: true, batch: 1 },
      { name: '2026_01_01_000002_create_second', ran: true, batch: 2 },
      { name: '2026_01_01_000003_create_third', ran: true, batch: 2 },
    ]);

    // When
    const rolledBack = await migrator.rollback();

    // Then
    expect(rolledBack).toEqual(['2026_01_01_000003_create_third', '2026_01_01_000002_create_second']);
    expect(await tables()).toEqual(['first', 'migrations']);
    expect((await migrator.status()).map((migration) => migration.ran)).toEqual([true, false, false]);
  });

  test('Should leave nothing behind when a migration of the batch fails', async () => {
    // Given
    const broken: Migration = { up: async () => Promise.reject(new Error('boom')), down: async () => undefined };
    const migrator = new Migrator(db, async () => [
      { name: '2026_01_01_000001_create_first', migration: tableMigration('first') },
      { name: '2026_01_01_000002_broken', migration: broken },
    ]);

    // When & Then
    await expect(migrator.migrate()).rejects.toThrowError('boom');
    expect(await tables()).toEqual([]);
  });

  test('Should drop every table and migrate again on fresh', async () => {
    // Given
    const migrator = new Migrator(db, async () => [{ name: '2026_01_01_000001_create_first', migration: tableMigration('first') }]);
    await migrator.migrate();
    await sql`create table leftover (id integer)`.execute(db);

    // When
    const migrated = await migrator.fresh();

    // Then
    expect(migrated).toEqual(['2026_01_01_000001_create_first']);
    expect(await tables()).toEqual(['first', 'migrations']);
  });

  test('Should run the real migrations up and all the way down', async () => {
    // Given
    const migrator = new Migrator(db, () => loadMigrationFiles());

    // When
    await migrator.migrate();
    const created = await tables();
    await migrator.rollback();

    // Then
    expect(created).toEqual(['book', 'book_entry', 'inbox', 'migrations', 'outbox', 'trade']);
    expect(await tables()).toEqual(['migrations']);
  });
});
