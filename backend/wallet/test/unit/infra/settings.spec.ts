import { describe, expect, test } from 'vitest';
import { rateLimitSetting } from '../../../src/infra/settings.js';

describe('rateLimitSetting', () => {
  test.each([
    ['5/1h', { limit: 5, windowMs: 3_600_000 }],
    ['600/1m', { limit: 600, windowMs: 60_000 }],
    ['50/10s', { limit: 50, windowMs: 10_000 }],
  ])('Should read %j', (value, expected) => {
    // When & Then
    expect(rateLimitSetting('RATE_LIMITS_TEST', '1/1s', { RATE_LIMITS_TEST: value })).toEqual(expected);
  });

  test('Should use the fallback when the variable is absent, and reject a malformed value', () => {
    // When & Then
    expect(rateLimitSetting('RATE_LIMITS_TEST', '3/1h', {})).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(() => rateLimitSetting('RATE_LIMITS_TEST', '3/1h', { RATE_LIMITS_TEST: 'many' })).toThrowError('RATE_LIMITS_TEST');
  });
});
