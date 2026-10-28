import { Migrator } from 'kysely/migration';
import { createDatabase } from './database/postgres.js';
import { SqlFileMigrationProvider } from './database/sqlFileMigrationProvider.js';
import { migratorSettings } from './settings.js';

const db = createDatabase(migratorSettings());

const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(process.env.MIGRATIONS_DIR ?? 'migrations') });
const { error, results } = await migrator.migrateToLatest();

for (const result of results ?? []) console.log(`migration ${result.migrationName}: ${result.status}`);
await db.destroy();

if (error) {
  console.error(error);
  process.exit(1);
}
