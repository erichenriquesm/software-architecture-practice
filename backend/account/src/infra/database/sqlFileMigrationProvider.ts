import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly directory: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.sql')).sort();
    const entries = await Promise.all(files.map(async (file) => [file, await this.migrationFor(file)] as const));
    return Object.fromEntries(entries);
  }

  private async migrationFor(file: string): Promise<Migration> {
    const statements = await readFile(join(this.directory, file), 'utf8');
    return { up: async (db) => void (await sql.raw(statements).execute(db)) };
  }
}
