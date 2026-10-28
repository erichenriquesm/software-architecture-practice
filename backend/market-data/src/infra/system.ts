import type { Clock } from '../application/contracts/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
