import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { InvalidMigrationError, loadMigrationFiles, makeMigration, timestampOf } from '../../../../src/infra/database/migrationFiles.js';

const emptyDirectory = () => mkdtempSync(join(tmpdir(), 'migrations-'));

describe('make:migration', () => {
  test('Should name the file <timestamp>_<name>.ts in UTC, like Laravel', () => {
    // When & Then
    expect(timestampOf(new Date('2026-10-28T09:05:07Z'))).toBe('2026_10_28_090507');
  });

  test('Should create a class with up() and down()', async () => {
    // Given
    const directory = emptyDirectory();

    // When
    const path = await makeMigration('create_wallet_table', new Date('2026-10-28T09:05:07Z'), directory);

    // Then
    expect(basename(path)).toBe('2026_10_28_090507_create_wallet_table.ts');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('export default class implements Migration');
    expect(content).toContain('async up(db: Kysely<unknown>)');
    expect(content).toContain('async down(db: Kysely<unknown>)');
  });

  test.each(['CreateWallet', 'create-wallet', '', '1_create'])('Should refuse the name %j', async (name) => {
    // When & Then
    await expect(makeMigration(name, new Date(), emptyDirectory())).rejects.toBeInstanceOf(InvalidMigrationError);
  });

  test('Should never overwrite an existing migration', async () => {
    // Given
    const directory = emptyDirectory();
    const now = new Date('2026-10-28T09:05:07Z');
    await makeMigration('create_wallet_table', now, directory);

    // When & Then
    await expect(makeMigration('create_wallet_table', now, directory)).rejects.toThrowError(/EEXIST/);
  });
});

describe('Loading migration files', () => {
  test('Should load the real migrations in timestamp order', async () => {
    // When
    const files = await loadMigrationFiles();

    // Then
    expect(files.map((file) => file.name)).toEqual([...files.map((file) => file.name)].sort());
    expect(files.map((file) => file.name)).toContain('2026_10_28_300003_create_trade_table');
  });

  test('Should ignore files that do not follow the naming pattern', async () => {
    // Given
    const directory = emptyDirectory();
    writeFileSync(join(directory, 'notes.ts'), 'export default 1;');

    // When & Then
    await expect(loadMigrationFiles(directory)).resolves.toEqual([]);
  });

  test('Should refuse a migration file without up() and down()', async () => {
    // Given
    const directory = emptyDirectory();
    writeFileSync(join(directory, '2026_10_28_000001_broken.ts'), 'export default class { async up() {} }');

    // When & Then
    await expect(loadMigrationFiles(directory)).rejects.toBeInstanceOf(InvalidMigrationError);
  });
});
