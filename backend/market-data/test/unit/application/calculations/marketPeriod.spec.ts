import { describe, expect, test } from 'vitest';
import { combineStats } from '../../../../src/application/calculations/combineStats.js';
import { latestInstant, marketPeriod, parseInstant, splitByMinute } from '../../../../src/application/calculations/marketPeriod.js';
import { InvalidQueryError } from '../../../../src/application/errors.js';

const now = new Date('2026-10-28T12:00:30.000Z');
const iso = (period: { from: Date; to: Date }) => [period.from.toISOString(), period.to.toISOString()];

describe('marketPeriod', () => {
  test('Should be the rolling last 24 h without dates, not the calendar day', () => {
    // When & Then
    expect(iso(marketPeriod(undefined, undefined, now))).toEqual(['2026-10-27T12:00:30.000Z', '2026-10-28T12:00:30.000Z']);
  });

  test('Should go from the start until now when only the start is given', () => {
    // When & Then
    expect(iso(marketPeriod('2026-10-28T00:00:00Z', undefined, now))).toEqual(['2026-10-28T00:00:00.000Z', '2026-10-28T12:00:30.000Z']);
  });

  test('Should be the 24 h before the end when only the end is given', () => {
    // When & Then
    expect(iso(marketPeriod(undefined, '2026-10-20T00:00:00Z', now))).toEqual(['2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  });

  test.each([
    ['a start equal to the end', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z'],
    ['a start after the end', '2026-10-28T01:00:00Z', '2026-10-28T00:00:00Z'],
    ['a start that is not a date', 'yesterday', '2026-10-28T00:00:00Z'],
    ['an end that is not ISO 8601', '2026-10-27T00:00:00Z', '10/28/2026'],
    ['an impossible date', '2026-02-30T00:00:00Z', undefined],
  ])('Should refuse %s', (_case, startDate, endDate) => {
    // When & Then
    expect(() => marketPeriod(startDate, endDate, now)).toThrowError(InvalidQueryError);
  });
});

describe('parseInstant', () => {
  test('Should accept a date with or without time and offset', () => {
    // When & Then
    expect(parseInstant('before', '2026-10-28').toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(parseInstant('before', '2026-10-28T09:00:00-03:00').toISOString()).toBe('2026-10-28T12:00:00.000Z');
  });
});

describe('splitByMinute', () => {
  test('Should read the partial minutes from the trades and the whole minutes from the candles', () => {
    // Given
    const period = { from: new Date('2026-10-28T10:00:15Z'), to: new Date('2026-10-28T10:05:40Z') };

    // When
    const segments = splitByMinute(period).map((segment) => [segment.source, segment.from.toISOString(), segment.to.toISOString()]);

    // Then
    expect(segments).toEqual([
      ['trades', '2026-10-28T10:00:15.000Z', '2026-10-28T10:01:00.000Z'],
      ['candles', '2026-10-28T10:01:00.000Z', '2026-10-28T10:05:00.000Z'],
      ['trades', '2026-10-28T10:05:00.000Z', '2026-10-28T10:05:40.000Z'],
    ]);
  });

  test('Should use only the candles for a period of whole minutes', () => {
    // Given
    const period = { from: new Date('2026-10-28T10:00:00Z'), to: new Date('2026-10-28T11:00:00Z') };

    // When & Then
    expect(splitByMinute(period).map((segment) => segment.source)).toEqual(['candles']);
  });

  test.each([
    ['inside one minute', '2026-10-28T10:00:10Z', '2026-10-28T10:00:50Z'],
    ['across one minute boundary', '2026-10-28T10:00:30Z', '2026-10-28T10:01:30Z'],
  ])('Should read only the trades for a period %s', (_case, from, to) => {
    // When
    const segments = splitByMinute({ from: new Date(from), to: new Date(to) });

    // Then
    expect(segments.map((segment) => [segment.source, segment.from.toISOString(), segment.to.toISOString()])).toEqual([
      ['trades', new Date(from).toISOString(), new Date(to).toISOString()],
    ]);
  });
});

describe('combineStats', () => {
  test('Should take the lowest min, the highest max and sum the volumes, ignoring empty pieces', () => {
    // Given
    const parts = [
      { min: '100', max: '120', volume: '1000.5' },
      { min: null, max: null, volume: '0' },
      { min: '90.5', max: '110', volume: '0.0000001' },
    ];

    // When & Then
    expect(combineStats(parts)).toEqual({ min: '90.50000000', max: '120.00000000', volume: '1000.50000010' });
  });

  test('Should have no min or max and zero volume without trades', () => {
    // When & Then
    expect(combineStats([{ min: null, max: null, volume: '0' }])).toEqual({ min: null, max: null, volume: '0.00000000' });
  });
});

describe('latestInstant', () => {
  test('Should be the most recent of the instants that exist, or null', () => {
    // When & Then
    expect(latestInstant(new Date('2026-10-28T10:00:00Z'), undefined, new Date('2026-10-28T11:00:00Z'))).toBe('2026-10-28T11:00:00.000Z');
    expect(latestInstant(undefined, undefined)).toBeNull();
  });
});
