import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../application/contracts/clock.js';
import type { IdGenerator } from '../application/contracts/idGenerator.js';

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
