import { Exact, scale } from './exact.js';

/** Best ask − best bid; null while one side of the book is empty. */
export const spread = (bestBid: string | null, bestAsk: string | null): string | null => {
  if (bestBid === null || bestAsk === null) return null;
  return new Exact(bestAsk).minus(bestBid).toFixed(scale);
};
