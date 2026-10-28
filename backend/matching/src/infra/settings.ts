import type { PostgresSettings } from './database/postgres.js';
import { MissingConfigurationError, numberEnv, requiredEnv } from './platform/config/env.js';

export const healthPortSetting = (): number => numberEnv('HEALTH_PORT', 3001);

export const postgresSettings = (): PostgresSettings => ({
  host: requiredEnv('DATABASE_HOST'),
  port: numberEnv('DATABASE_PORT', 5432),
  database: requiredEnv('DATABASE_NAME'),
  user: requiredEnv('DATABASE_USER'),
  password: requiredEnv('DATABASE_PASSWORD'),
});

const unitMs: ReadonlyMap<string, number> = new Map([
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000],
]);

const durationFormat = /^(\d+)([smh])$/;

/** Reads a duration written as "<amount><unit>", e.g. "10s" or "2m". */
export const durationSetting = (key: string, fallback: string, env: NodeJS.ProcessEnv = process.env): number => {
  const match = durationFormat.exec(env[key] ?? fallback);
  if (!match) throw new MissingConfigurationError(key);
  const [, amount, unit] = match;
  return Number(amount) * (unitMs.get(String(unit)) ?? 0);
};
