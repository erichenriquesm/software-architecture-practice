import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

/** One migration file: a class with up() and down(), like Laravel's. */
export interface Migration {
  up(db: Kysely<unknown>): Promise<void>;
  down(db: Kysely<unknown>): Promise<void>;
}

export interface MigrationFile {
  readonly name: string;
  readonly migration: Migration;
}

export interface MigrationStatus {
  readonly name: string;
  readonly ran: boolean;
  readonly batch: number | null;
}

interface RanMigration {
  readonly name: string;
  readonly batch: number;
}

const repositoryTable = 'migrations';
const lockKey = 7_700_001;

export class MissingMigrationFileError extends Error {
  constructor(readonly migrationName: string) {
    super(`Migration ${migrationName} ran but its file no longer exists`);
    this.name = 'MissingMigrationFileError';
  }
}

/**
 * Laravel-style migrator: every `migrate` runs the pending files as one batch, `rollback` undoes the last batch.
 * Each command runs in a single transaction (Postgres has transactional DDL) under an advisory lock.
 */
export class Migrator {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly files: () => Promise<readonly MigrationFile[]>,
  ) {}

  async migrate(): Promise<string[]> {
    return this.inTransaction(async (trx) => {
      const ran = new Set((await this.ranMigrations(trx)).map((migration) => migration.name));
      const pending = (await this.files()).filter((file) => !ran.has(file.name));
      const batch = (await this.lastBatch(trx)) + 1;
      for (const file of pending) await this.runUp(trx, file, batch);
      return pending.map((file) => file.name);
    });
  }

  async rollback(): Promise<string[]> {
    return this.inTransaction(async (trx) => {
      const lastBatch = await this.lastBatch(trx);
      const toUndo = (await this.ranMigrations(trx)).filter((migration) => migration.batch === lastBatch).reverse();
      const files = new Map((await this.files()).map((file) => [file.name, file]));
      for (const migration of toUndo) await this.runDown(trx, files.get(migration.name), migration.name);
      return toUndo.map((migration) => migration.name);
    });
  }

  async status(): Promise<MigrationStatus[]> {
    await this.ensureRepository(this.db);
    const ran = new Map((await this.ranMigrations(this.db)).map((migration) => [migration.name, migration.batch]));
    return (await this.files()).map((file) => ({ name: file.name, ran: ran.has(file.name), batch: ran.get(file.name) ?? null }));
  }

  /** Drops every table of the current schema and runs all migrations again. Development only. */
  async fresh(): Promise<string[]> {
    await this.inTransaction(async (trx) => {
      const tables = await sql<{ name: string }>`
        select tablename as name from pg_tables where schemaname = current_schema()`.execute(trx);
      for (const table of tables.rows) await sql`drop table if exists ${sql.id(table.name)} cascade`.execute(trx);
    });
    return this.migrate();
  }

  private async inTransaction<T>(work: (trx: Transaction<unknown>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${lockKey})`.execute(trx);
      await this.ensureRepository(trx);
      return work(trx);
    });
  }

  private async ensureRepository(db: Kysely<unknown>): Promise<void> {
    await sql`
      create table if not exists ${sql.id(repositoryTable)} (
        id serial primary key,
        name text not null unique,
        batch integer not null,
        ran_at timestamptz not null default now()
      )`.execute(db);
  }

  private async ranMigrations(db: Kysely<unknown>): Promise<RanMigration[]> {
    const result = await sql<RanMigration>`
      select name, batch from ${sql.id(repositoryTable)} order by batch, name`.execute(db);
    return result.rows;
  }

  private async lastBatch(db: Kysely<unknown>): Promise<number> {
    const result = await sql<{ batch: number | null }>`select max(batch) as batch from ${sql.id(repositoryTable)}`.execute(db);
    return Number(result.rows[0]?.batch ?? 0);
  }

  private async runUp(trx: Transaction<unknown>, file: MigrationFile, batch: number): Promise<void> {
    await file.migration.up(trx);
    await sql`insert into ${sql.id(repositoryTable)} (name, batch) values (${file.name}, ${batch})`.execute(trx);
  }

  private async runDown(trx: Transaction<unknown>, file: MigrationFile | undefined, name: string): Promise<void> {
    if (!file) throw new MissingMigrationFileError(name);
    await file.migration.down(trx);
    await sql`delete from ${sql.id(repositoryTable)} where name = ${name}`.execute(trx);
  }
}
