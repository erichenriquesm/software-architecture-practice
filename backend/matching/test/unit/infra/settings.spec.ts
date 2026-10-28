import { describe, expect, test } from 'vitest';
import { durationSetting } from '../../../src/infra/settings.js';

describe('durationSetting', () => {
  test.each([
    ['10s', 10_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
  ])('Should read %j', (value, expected) => {
    // When & Then
    expect(durationSetting('SOME_DURATION', '1s', { SOME_DURATION: value })).toBe(expected);
  });

  test('Should use the fallback when absent and reject a malformed value', () => {
    // When & Then
    expect(durationSetting('SOME_DURATION', '5s', {})).toBe(5_000);
    expect(() => durationSetting('SOME_DURATION', '5s', { SOME_DURATION: 'soon' })).toThrowError('SOME_DURATION');
  });
});
