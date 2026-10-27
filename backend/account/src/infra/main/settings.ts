import { networkInterfaces } from 'node:os';
import type { PostgresSettings } from '../adapters/outbound/persistence/postgres.js';
import { readSecretFile, requiredEnv } from '../platform/security/secrets.js';

export const serviceNameSetting = (): string => requiredEnv('SERVICE_NAME');

export const httpPortSetting = (): number => Number(process.env.HTTP_PORT ?? 3000);

export const postgresSettings = (): PostgresSettings => ({
  host: requiredEnv('DATABASE_HOST'),
  database: requiredEnv('DATABASE_NAME'),
  user: requiredEnv('DATABASE_USER'),
  password: readSecretFile('DATABASE_PASSWORD_FILE'),
});

export const trustedProxySubnets = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal && address.cidr !== null)
    .map((address) => String(address.cidr));
