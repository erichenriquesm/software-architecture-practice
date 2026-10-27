import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MissingConfigurationError, readSecretFile, requiredEnv } from './secrets.js';

describe('Secrets and configuration', () => {
  test('Should read a secret from the file named by the *_FILE variable, without trailing newline', () => {
    // Given
    const file = join(mkdtempSync(join(tmpdir(), 'secrets-')), 'db-password');
    writeFileSync(file, 's3cret\n');

    // When
    const secret = readSecretFile('DATABASE_PASSWORD_FILE', { DATABASE_PASSWORD_FILE: file });

    // Then
    expect(secret).toBe('s3cret');
  });

  test('Should fail with the missing key when a required variable is absent or empty', () => {
    // When & Then
    expect(() => requiredEnv('DATABASE_HOST', {})).toThrowError(MissingConfigurationError);
    expect(() => requiredEnv('DATABASE_HOST', { DATABASE_HOST: '' })).toThrowError('DATABASE_HOST');
  });
});
