import type { TradeView } from '../dtos/tradeView.js';

export interface TradeDao {
  /** Most recent first; `before` is exclusive. */
  listRecent(marketId: string, limit: number, before?: Date): Promise<TradeView[]>;
}
