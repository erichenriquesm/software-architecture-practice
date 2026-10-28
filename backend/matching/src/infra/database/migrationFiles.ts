import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Migration, MigrationFile } from './migrator.js';

/** Where the migration classes live: src/infra/database/migrations (dev) or dist/infra/database/migrations (image). */
export const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

const fileName = /^(\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+)\.(ts|js)$/;
const migrationName = /^[a-z][a-z0-9_]*$/;

export class InvalidMigrationError extends Error {
  constructor(reason: string) {
    super(`Invalid migration: ${reason}`);
    this.name = 'InvalidMigrationError';
  }
}

const isMigration = (candidate: unknown): candidate is Migration =>
  typeof candidate === 'object' &&
  candidate !== null &&
  typeof (candidate as Migration).up === 'function' &&
  typeof (candidate as Migration).down === 'function';

const load = async (directory: string, file: string, name: string): Promise<MigrationFile> => {
  const module = (await import(pathToFileURL(join(directory, file)).href)) as { default?: new () => unknown };
  if (typeof module.default !== 'function') throw new InvalidMigrationError(`${file} must export a default class`);
  const migration = new module.default();
  if (!isMigration(migration)) throw new InvalidMigrationError(`${file} must have up() and down()`);
  return { name, migration };
};

export const loadMigrationFiles = async (directory: string = migrationsDirectory): Promise<MigrationFile[]> => {
  const entries = (await readdir(directory))
    .filter((file) => !file.endsWith('.d.ts'))
    .map((file) => ({ file, match: fileName.exec(file) }))
    .filter((entry) => entry.match !== null)
    .sort((first, second) => first.file.localeCompare(second.file));
  return Promise.all(entries.map((entry) => load(directory, entry.file, String(entry.match?.[1]))));
};

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const timestampOf = (now: Date): string =>
  `${now.getUTCFullYear()}_${twoDigits(now.getUTCMonth() + 1)}_${twoDigits(now.getUTCDate())}_` +
  `${twoDigits(now.getUTCHours())}${twoDigits(now.getUTCMinutes())}${twoDigits(now.getUTCSeconds())}`;

const template = `import type { Kysely } from 'kysely';
import type { Migration } from '../migrator.js';

export default class implements Migration {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.createTable('table_name').addColumn('id', 'uuid', (column) => column.primaryKey()).execute();
  }

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('table_name').execute();
  }
}
`;

/** `make:migration create_account_table` -> migrations/2026_10_28_120000_create_account_table.ts */
export const makeMigration = async (name: string, now: Date, directory: string = migrationsDirectory): Promise<string> => {
  if (!migrationName.test(name)) throw new InvalidMigrationError(`name must be snake_case, got "${name}"`);
  const path = join(directory, `${timestampOf(now)}_${name}.ts`);
  await writeFile(path, template, { flag: 'wx' });
  return path;
};
