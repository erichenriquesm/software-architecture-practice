import type { TradeDao } from '../../src/application/contracts/tradeDao.js';
import type { TradeView } from '../../src/application/dtos/tradeView.js';

export class FakeTradeDao implements TradeDao {
  readonly calls: { marketId: string; limit: number; before: Date | undefined }[] = [];

  constructor(private readonly trades: readonly TradeView[] = []) {}

  async listRecent(marketId: string, limit: number, before?: Date): Promise<TradeView[]> {
    this.calls.push({ marketId, limit, before });
    return this.trades.slice(0, limit);
  }
}
