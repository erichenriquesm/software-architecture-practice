import type { MarketCatalog } from '../../src/application/contracts/marketCatalog.js';
import { InvalidOrderDataError } from '../../src/domain/errors.js';
import { MarketFilters } from '../../src/domain/valueObjects/marketFilters.js';
import type { MarketId } from '../../src/domain/valueObjects/marketId.js';
import { Price } from '../../src/domain/valueObjects/price.js';
import { Quantity } from '../../src/domain/valueObjects/quantity.js';

/** Same filters as markets.json for BTC-USD. */
export class FakeMarketCatalog implements MarketCatalog {
  filtersOf(market: MarketId): MarketFilters {
    if (market.value !== 'BTC-USD') throw new InvalidOrderDataError('marketId', 'unknown market');
    return new MarketFilters(Price.from('0.01'), Quantity.from('0.00001'), Quantity.from('0.00001'), Quantity.from('5'));
  }
}
