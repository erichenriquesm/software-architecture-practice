import { readFileSync } from 'node:fs';
import type { DepthPrecisionRange, MarketCatalog } from '../../application/contracts/marketCatalog.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';

interface MarketEntry {
  readonly marketId: string;
  readonly depthPrecision: DepthPrecisionRange;
  readonly status: string;
}

interface CatalogFile {
  readonly markets: readonly MarketEntry[];
}

/** markets.json, validated against its schema when the service starts: an invalid catalog stops the service. */
export class JsonMarketCatalog implements MarketCatalog {
  private constructor(private readonly precisions: ReadonlyMap<string, DepthPrecisionRange>) {}

  static load(file = 'src/infra/contracts/markets.json', schemaFile = 'src/infra/contracts/markets.schema.json'): JsonMarketCatalog {
    const catalog = loadSchemaValidator<CatalogFile>(schemaFile)(JSON.parse(readFileSync(file, 'utf8')));
    const active = catalog.markets.filter((market) => market.status === 'active');
    return new JsonMarketCatalog(new Map(active.map((market) => [market.marketId, market.depthPrecision])));
  }

  depthPrecisionOf(marketId: string): DepthPrecisionRange | undefined {
    return this.precisions.get(marketId);
  }
}
