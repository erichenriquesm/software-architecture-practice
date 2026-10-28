import { Decimal } from 'decimal.js';

/** Enough significant digits for numeric(36,8): no rounding ever happens in sums, buckets or differences. */
export const Exact = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });

export const scale = 8;
