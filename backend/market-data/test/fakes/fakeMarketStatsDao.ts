import type { MarketStatsDao } from '../../src/application/contracts/marketStatsDao.js';
import type { TopOfBookView, TradeStatsView } from '../../src/application/dtos/marketStatsView.js';

const empty: TradeStatsView = { min: null, max: null, volume: '0' };

export interface FakeMarketStats {
  readonly candles?: TradeStatsView;
  readonly trades?: TradeStatsView;
  readonly topOfBook?: TopOfBookView;
  readonly lastTradeAt?: Date;
}

/** Answers the same stats for every range and records which ranges were asked from which source. */
export class FakeMarketStatsDao implements MarketStatsDao {
  readonly ranges: { source: 'candles' | 'trades'; from: string; to: string }[] = [];

  constructor(private readonly stats: FakeMarketStats = {}) {}

  async candleStats(_marketId: string, from: Date, to: Date): Promise<TradeStatsView> {
    this.ranges.push({ source: 'candles', from: from.toISOString(), to: to.toISOString() });
    return this.stats.candles ?? empty;
  }

  async tradeStats(_marketId: string, from: Date, to: Date): Promise<TradeStatsView> {
    this.ranges.push({ source: 'trades', from: from.toISOString(), to: to.toISOString() });
    return this.stats.trades ?? empty;
  }

  async topOfBook(): Promise<TopOfBookView | undefined> {
    return this.stats.topOfBook;
  }

  async lastTradeAt(): Promise<Date | undefined> {
    return this.stats.lastTradeAt;
  }
}
