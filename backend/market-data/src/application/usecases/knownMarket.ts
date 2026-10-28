import type { DepthPrecisionRange, MarketCatalog } from '../contracts/marketCatalog.js';
import { MarketNotFoundError } from '../errors.js';

export const knownMarket = (marketCatalog: MarketCatalog, marketId: string): DepthPrecisionRange => {
  const range = marketCatalog.depthPrecisionOf(marketId);
  if (!range) throw new MarketNotFoundError(marketId);
  return range;
};
