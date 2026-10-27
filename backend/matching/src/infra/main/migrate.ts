import { Migrator } from 'kysely/migration';
import { createDatabase } from '../adapters/outbound/persistence/postgres.js';
import { SqlFileMigrationProvider } from '../adapters/outbound/persistence/sqlFileMigrationProvider.js';
import { readSecretFile, requiredEnv } from '../platform/security/secrets.js';

const db = createDatabase({
  host: requiredEnv('DATABASE_HOST'),
  database: requiredEnv('DATABASE_NAME'),
  user: requiredEnv('DATABASE_MIGRATOR_USER'),
  password: readSecretFile('DATABASE_MIGRATOR_PASSWORD_FILE'),
});

const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(process.env.MIGRATIONS_DIR ?? 'migrations') });
const { error, results } = await migrator.migrateToLatest();

for (const result of results ?? []) console.log(`migration ${result.migrationName}: ${result.status}`);
await db.destroy();

if (error) {
  console.error(error);
  process.exit(1);
}
