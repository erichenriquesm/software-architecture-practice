import { describe, expect, test } from 'vitest';
import { MissingConfigurationError, numberEnv, requiredEnv } from '../../../../../src/infra/platform/config/env.js';

describe('Configuration from environment variables', () => {
  test('Should return a required variable that is present', () => {
    // When & Then
    expect(requiredEnv('DATABASE_HOST', { DATABASE_HOST: 'account-db' })).toBe('account-db');
  });

  test('Should fail with the missing key when a required variable is absent or empty', () => {
    // When & Then
    expect(() => requiredEnv('DATABASE_HOST', {})).toThrowError(MissingConfigurationError);
    expect(() => requiredEnv('DATABASE_HOST', { DATABASE_HOST: '' })).toThrowError('DATABASE_HOST');
  });

  test('Should use the fallback for an absent number and reject one that is not a positive integer', () => {
    // When & Then
    expect(numberEnv('API_PORT', 3000, {})).toBe(3000);
    expect(numberEnv('API_PORT', 3000, { API_PORT: '8080' })).toBe(8080);
    expect(() => numberEnv('API_PORT', 3000, { API_PORT: 'abc' })).toThrowError('API_PORT');
  });
});
