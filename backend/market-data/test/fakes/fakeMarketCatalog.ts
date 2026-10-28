import type { DepthPrecisionRange, MarketCatalog } from '../../src/application/contracts/marketCatalog.js';

/** Same depth precisions as markets.json for BTC-USD. */
export class FakeMarketCatalog implements MarketCatalog {
  depthPrecisionOf(marketId: string): DepthPrecisionRange | undefined {
    return marketId === 'BTC-USD' ? { min: -2, max: 5 } : undefined;
  }
}
