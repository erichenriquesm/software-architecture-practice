import { createDatabase } from './database/postgres.js';
import { loadMigrationFiles, makeMigration } from './database/migrationFiles.js';
import { Migrator } from './database/migrator.js';
import { postgresSettings } from './settings.js';

/*
 * Laravel-style commands (run inside the service's api container; see the service Makefile):
 *   npm run migrate                 run the pending migrations as one batch
 *   npm run migrate:rollback        undo the last batch
 *   npm run migrate:status          list every migration and whether it ran
 *   npm run migrate:fresh           drop all tables and migrate again (refused when NODE_ENV=production)
 *   npm run make:migration -- name  create migrations/<timestamp>_name.ts
 */
const [command = 'migrate', argument] = process.argv.slice(2);

const print = (verb: string, names: readonly string[]): void => {
  if (names.length === 0) console.log('nothing to do');
  for (const name of names) console.log(`${verb}: ${name}`);
};

const run = async (migrator: Migrator): Promise<void> => {
  if (command === 'migrate') return print('migrated', await migrator.migrate());
  if (command === 'rollback') return print('rolled back', await migrator.rollback());
  if (command === 'fresh') return print('migrated', await migrator.fresh());
  if (command === 'status') {
    for (const migration of await migrator.status()) {
      console.log(`${migration.ran ? `[ran, batch ${migration.batch}]` : '[pending]     '} ${migration.name}`);
    }
    return;
  }
  throw new Error(`unknown command "${command}" (use migrate, rollback, status, fresh or make)`);
};

if (command === 'make') {
  console.log(`created: ${await makeMigration(String(argument), new Date())}`);
  process.exit(0);
}
if (command === 'fresh' && process.env.NODE_ENV === 'production') {
  console.error('migrate:fresh drops every table and is refused when NODE_ENV=production');
  process.exit(1);
}

const db = createDatabase<unknown>(postgresSettings());
try {
  await run(new Migrator(db, () => loadMigrationFiles()));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
