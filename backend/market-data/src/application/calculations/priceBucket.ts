import { Exact, scale } from './exact.js';

/** bucket = floor(price / 10^precision) × 10^precision; precision −2 is the tick itself (no aggregation). */
export const priceBucket = (price: string, precision: number): string => {
  const width = new Exact(10).pow(precision);
  return new Exact(price).div(width).floor().times(width).toFixed(scale);
};
