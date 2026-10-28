import { InvalidQueryError } from '../errors.js';

/** [from, to): `from` inclusive, `to` exclusive. */
export interface MarketPeriod {
  readonly from: Date;
  readonly to: Date;
}

export interface PeriodSegment extends MarketPeriod {
  readonly source: 'candles' | 'trades';
}

const minute = 60_000;
const day = 24 * 60 * minute;
const isoInstant = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Date rolls 2026-02-30 over to March 2 instead of refusing it.
const isRealDay = (value: string): boolean => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDate() === day;
};

export const parseInstant = (field: string, value: string): Date => {
  const instant = new Date(value);
  const valid = isoInstant.test(value) && isRealDay(value) && !Number.isNaN(instant.getTime());
  if (!valid) throw new InvalidQueryError(field, 'must be an ISO 8601 date');
  return instant;
};

const endOf = (endDate: string | undefined, now: Date): Date => (endDate === undefined ? now : parseInstant('endDate', endDate));

/** Without a start, the period is the rolling 24 h before its end (Binance's 24 h ticker), not the calendar day. */
export const marketPeriod = (startDate: string | undefined, endDate: string | undefined, now: Date): MarketPeriod => {
  const to = endOf(endDate, now);
  const from = startDate === undefined ? new Date(to.getTime() - day) : parseInstant('startDate', startDate);
  if (from.getTime() >= to.getTime()) throw new InvalidQueryError('startDate', 'must be before endDate');
  return { from, to };
};

const floorMinute = (instant: Date): Date => new Date(Math.floor(instant.getTime() / minute) * minute);
const ceilMinute = (instant: Date): Date => new Date(Math.ceil(instant.getTime() / minute) * minute);

/** Whole minutes come from the candles; only the partial minutes at both edges are read trade by trade. */
export const splitByMinute = (period: MarketPeriod): PeriodSegment[] => {
  const firstWholeMinute = ceilMinute(period.from);
  const lastWholeMinute = floorMinute(period.to);
  if (firstWholeMinute.getTime() >= lastWholeMinute.getTime()) return [{ source: 'trades', ...period }];
  const segments: PeriodSegment[] = [
    { source: 'trades', from: period.from, to: firstWholeMinute },
    { source: 'candles', from: firstWholeMinute, to: lastWholeMinute },
    { source: 'trades', from: lastWholeMinute, to: period.to },
  ];
  return segments.filter((segment) => segment.from.getTime() < segment.to.getTime());
};

/** The most recent of the instants that exist, as ISO 8601; null when none does. */
export const latestInstant = (...instants: readonly (Date | undefined)[]): string | null => {
  const times = instants.flatMap((instant) => (instant === undefined ? [] : [instant.getTime()]));
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
};
