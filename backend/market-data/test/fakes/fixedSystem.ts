import type { Clock } from '../../src/application/contracts/clock.js';

export const fixedClock = (now: Date): Clock => ({ now: () => now });
