import { readFileSync } from 'node:fs';
import type { MarketCatalog } from '../../application/contracts/marketCatalog.js';
import { InvalidOrderDataError } from '../../domain/errors.js';
import { MarketFilters } from '../../domain/valueObjects/marketFilters.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';

interface MarketEntry {
  readonly marketId: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQuantity: string;
  readonly minNotional: string;
  readonly status: string;
}

interface CatalogFile {
  readonly markets: readonly MarketEntry[];
}

/** markets.json, validated against its schema when the service starts: an invalid catalog stops the service. */
export class JsonMarketCatalog implements MarketCatalog {
  private constructor(private readonly filters: ReadonlyMap<string, MarketFilters>) {}

  static load(file = 'src/infra/contracts/markets.json', schemaFile = 'src/infra/contracts/markets.schema.json'): JsonMarketCatalog {
    const catalog = loadSchemaValidator<CatalogFile>(schemaFile)(JSON.parse(readFileSync(file, 'utf8')));
    const active = catalog.markets.filter((market) => market.status === 'active');
    return new JsonMarketCatalog(
      new Map(
        active.map((market) => [
          market.marketId,
          new MarketFilters(Price.from(market.tickSize), Quantity.from(market.stepSize), Quantity.from(market.minQuantity), Quantity.from(market.minNotional)),
        ]),
      ),
    );
  }

  filtersOf(market: MarketId): MarketFilters {
    const filters = this.filters.get(market.value);
    if (!filters) throw new InvalidOrderDataError('marketId', `${market.value} is not an active market`);
    return filters;
  }
}
