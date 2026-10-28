import type { MarketFilters } from '../../domain/valueObjects/marketFilters.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';

/** The static market catalog (markets.json). An unknown or inactive market is rejected with InvalidOrderDataError. */
export interface MarketCatalog {
  filtersOf(market: MarketId): MarketFilters;
}
