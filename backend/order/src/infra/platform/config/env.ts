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

export const numberEnv = (key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number => {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new MissingConfigurationError(key);
  return parsed;
};
