import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DependencyProbe } from '../http/health.js';
import type { Database } from './database.js';

export interface PostgresSettings {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export const createDatabase = <TDatabase = Database>(settings: PostgresSettings): Kysely<TDatabase> =>
  new Kysely<TDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ ...settings, max: 10, connectionTimeoutMillis: 2_000 }),
    }),
  });

export class PostgresProbe implements DependencyProbe {
  readonly dependency = 'postgres';

  constructor(private readonly db: Kysely<Database>) {}

  async isHealthy(): Promise<boolean> {
    await sql`select 1`.execute(this.db);
    return true;
  }
}
