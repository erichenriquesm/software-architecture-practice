import { readFileSync } from 'node:fs';

export class MissingConfigurationError extends Error {
  constructor(readonly key: string) {
    super(`Missing configuration: ${key}`);
    this.name = 'MissingConfigurationError';
  }
}

export const requiredEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string => {
  const value = env[key];
  if (value === undefined || value === '') throw new MissingConfigurationError(key);
  return value;
};

export const readSecretFile = (fileKey: string, env: NodeJS.ProcessEnv = process.env): string =>
  readFileSync(requiredEnv(fileKey, env), 'utf8').trim();
