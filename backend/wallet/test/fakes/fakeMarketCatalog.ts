import type { MarketCatalog } from '../../src/application/contracts/marketCatalog.js';
import { InvalidWalletDataError } from '../../src/domain/errors.js';
import type { AssetId } from '../../src/domain/valueObjects/assetId.js';
import type { MarketId } from '../../src/domain/valueObjects/marketId.js';

/** Same content as markets.json: BTC with 8 decimals, USD with 2, one active market BTC-USD. */
export class FakeMarketCatalog implements MarketCatalog {
  private readonly precisions = new Map([
    ['BTC', 8],
    ['USD', 2],
  ]);

  precisionOf(asset: AssetId): number {
    const precision = this.precisions.get(asset.value);
    if (precision === undefined) throw new InvalidWalletDataError('assetId', 'unknown asset');
    return precision;
  }

  ensureMarket(market: MarketId): void {
    if (market.value !== 'BTC-USD') throw new InvalidWalletDataError('marketId', 'unknown market');
  }
}
