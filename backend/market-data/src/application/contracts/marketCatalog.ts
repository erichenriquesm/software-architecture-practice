export interface DepthPrecisionRange {
  readonly min: number;
  readonly max: number;
}

/** The static market catalog (markets.json). */
export interface MarketCatalog {
  /** Depth precisions the market accepts; undefined when the market does not exist or is not active. */
  depthPrecisionOf(marketId: string): DepthPrecisionRange | undefined;
}
