import type { Clock } from '../../src/application/contracts/clock.js';
import type { IdGenerator } from '../../src/application/contracts/idGenerator.js';

export const fixedClock = (now: Date): Clock => ({ now: () => now });

export const fixedIds = (...ids: string[]): IdGenerator => {
  const queue = [...ids];
  return { next: () => queue.shift() ?? 'no-more-ids' };
};
