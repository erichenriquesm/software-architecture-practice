import type { Decimal } from 'decimal.js';
import type { DepthLevelView } from '../dtos/depthView.js';
import { Exact, scale } from './exact.js';
import { priceBucket } from './priceBucket.js';

export type BookSide = 'buy' | 'sell';

export interface BookLevel {
  readonly price: string;
  readonly quantity: string;
}

/** Sums the quantity of each price bucket; buys come highest price first, sells lowest first. */
export const aggregateDepth = (levels: readonly BookLevel[], precision: number, side: BookSide): DepthLevelView[] => {
  const totals = new Map<string, Decimal>();
  for (const level of levels) {
    const bucket = priceBucket(level.price, precision);
    totals.set(bucket, (totals.get(bucket) ?? new Exact(0)).plus(level.quantity));
  }
  const direction = side === 'buy' ? -1 : 1;
  return [...totals]
    .map(([price, quantity]) => ({ quantity: quantity.toFixed(scale), price }))
    .sort((first, second) => direction * new Exact(first.price).comparedTo(second.price));
};
