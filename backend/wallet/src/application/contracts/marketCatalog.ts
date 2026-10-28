import type { AssetId } from '../../domain/valueObjects/assetId.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';

/** The static market catalog (markets.json). Unknown assets or markets are rejected with InvalidWalletDataError. */
export interface MarketCatalog {
  precisionOf(asset: AssetId): number;
  ensureMarket(market: MarketId): void;
}
