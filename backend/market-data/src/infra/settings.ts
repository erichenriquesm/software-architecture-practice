import { networkInterfaces } from 'node:os';
import type { PostgresSettings } from './database/postgres.js';
import { MissingConfigurationError, numberEnv, requiredEnv } from './platform/config/env.js';
import type { RateLimitPolicy } from './platform/http/rateLimit/slidingWindow.js';

export const apiPortSetting = (): number => numberEnv('API_PORT', 3000);

export const healthPortSetting = (): number => numberEnv('HEALTH_PORT', 3001);

export const postgresSettings = (): PostgresSettings => ({
  host: requiredEnv('DATABASE_HOST'),
  port: numberEnv('DATABASE_PORT', 5432),
  database: requiredEnv('DATABASE_NAME'),
  user: requiredEnv('DATABASE_USER'),
  password: requiredEnv('DATABASE_PASSWORD'),
});

export interface RedisSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

export const redisSettings = (): RedisSettings => ({
  host: requiredEnv('REDIS_HOST'),
  port: numberEnv('REDIS_PORT', 6379),
  username: requiredEnv('REDIS_USER'),
  password: requiredEnv('REDIS_PASSWORD'),
});

const unitMs: ReadonlyMap<string, number> = new Map([
  ['s', 1_000],
  ['m', 60_000],
  ['h', 3_600_000],
]);
const limitFormat = /^(\d+)\/(\d+)([smh])$/;

const durationFormat = /^(\d+)([smh])$/;

/** Reads a duration written as "<amount><unit>", e.g. "10s" or "2m". */
export const durationSetting = (key: string, fallback: string, env: NodeJS.ProcessEnv = process.env): number => {
  const match = durationFormat.exec(env[key] ?? fallback);
  if (!match) throw new MissingConfigurationError(key);
  const [, amount, unit] = match;
  return Number(amount) * (unitMs.get(String(unit)) ?? 0);
};

/** Reads a rate limit written as "<requests>/<window>", e.g. "5/1h" or "600/1m". */
export const rateLimitSetting = (key: string, fallback: string, env: NodeJS.ProcessEnv = process.env): Omit<RateLimitPolicy, 'name'> => {
  const match = limitFormat.exec(env[key] ?? fallback);
  if (!match) throw new MissingConfigurationError(key);
  const [, limit, amount, unit] = match;
  return { limit: Number(limit), windowMs: Number(amount) * (unitMs.get(String(unit)) ?? 0) };
};

export const trustedProxySubnets = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal && address.cidr !== null)
    .map((address) => String(address.cidr));
