import type { Kysely } from 'kysely';
import type { TradeDao } from '../../application/contracts/tradeDao.js';
import type { TradeView } from '../../application/dtos/tradeView.js';
import type { Database } from './database.js';

const columns = ['trade_id as tradeId', 'buy_order_id as buyOrderId', 'sell_order_id as sellOrderId', 'side', 'quantity', 'price', 'executed_at'] as const;

export class KyselyTradeDao implements TradeDao {
  constructor(private readonly db: Kysely<Database>) {}

  async listRecent(marketId: string, limit: number, before?: Date): Promise<TradeView[]> {
    let query = this.db.selectFrom('trade_view').select(columns).where('market_id', '=', marketId);
    if (before) query = query.where('executed_at', '<', before);
    const rows = await query.orderBy('executed_at', 'desc').orderBy('trade_id', 'desc').limit(limit).execute();
    return rows.map(({ executed_at: executedAt, ...trade }) => ({ ...trade, timestamp: executedAt.toISOString() }));
  }
}
