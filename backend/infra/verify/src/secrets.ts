import { readFileSync } from 'node:fs';

const secretsDir = process.env.SECRETS_DIR ?? '/run/secrets';

export const readSecret = (name: string): string => readFileSync(`${secretsDir}/${name}`, 'utf8').trim();
