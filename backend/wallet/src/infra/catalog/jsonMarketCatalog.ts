import { readFileSync } from 'node:fs';
import type { MarketCatalog } from '../../application/contracts/marketCatalog.js';
import { InvalidWalletDataError } from '../../domain/errors.js';
import type { AssetId } from '../../domain/valueObjects/assetId.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';

interface CatalogFile {
  readonly assets: readonly { readonly assetId: string; readonly precision: number }[];
  readonly markets: readonly { readonly marketId: string; readonly status: string }[];
}

/** markets.json, validated against its schema when the service starts: an invalid catalog stops the service. */
export class JsonMarketCatalog implements MarketCatalog {
  private constructor(
    private readonly precisions: ReadonlyMap<string, number>,
    private readonly activeMarkets: ReadonlySet<string>,
  ) {}

  static load(file = 'src/infra/contracts/markets.json', schemaFile = 'src/infra/contracts/markets.schema.json'): JsonMarketCatalog {
    const catalog = loadSchemaValidator<CatalogFile>(schemaFile)(JSON.parse(readFileSync(file, 'utf8')));
    return new JsonMarketCatalog(
      new Map(catalog.assets.map((asset) => [asset.assetId, asset.precision])),
      new Set(catalog.markets.filter((market) => market.status === 'active').map((market) => market.marketId)),
    );
  }

  precisionOf(asset: AssetId): number {
    const precision = this.precisions.get(asset.value);
    if (precision === undefined) throw new InvalidWalletDataError('assetId', `${asset.value} is not traded on this platform`);
    return precision;
  }

  ensureMarket(market: MarketId): void {
    if (!this.activeMarkets.has(market.value)) throw new InvalidWalletDataError('marketId', `${market.value} is not an active market`);
  }
}
