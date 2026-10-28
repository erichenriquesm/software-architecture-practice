import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { MarketStatsDao } from '../../application/contracts/marketStatsDao.js';
import type { TopOfBookView, TradeStatsView } from '../../application/dtos/marketStatsView.js';
import type { Database } from './database.js';

interface StatsRow {
  readonly min: string | null;
  readonly max: string | null;
  readonly volume: string;
}

const statsOf = (row: StatsRow | undefined): TradeStatsView => ({ min: row?.min ?? null, max: row?.max ?? null, volume: row?.volume ?? '0' });

export class KyselyMarketStatsDao implements MarketStatsDao {
  constructor(private readonly db: Kysely<Database>) {}

  async candleStats(marketId: string, from: Date, to: Date): Promise<TradeStatsView> {
    const row = await this.db
      .selectFrom('candle_1m_view')
      .select([sql<string | null>`min(min_price)`.as('min'), sql<string | null>`max(max_price)`.as('max'), sql<string>`coalesce(sum(volume), 0)`.as('volume')])
      .where('market_id', '=', marketId)
      .where('bucket_start', '>=', from)
      .where('bucket_start', '<', to)
      .executeTakeFirst();
    return statsOf(row);
  }

  async tradeStats(marketId: string, from: Date, to: Date): Promise<TradeStatsView> {
    const row = await this.db
      .selectFrom('trade_view')
      .select([sql<string | null>`min(price)`.as('min'), sql<string | null>`max(price)`.as('max'), sql<string>`coalesce(sum(quantity * price), 0)`.as('volume')])
      .where('market_id', '=', marketId)
      .where('executed_at', '>=', from)
      .where('executed_at', '<', to)
      .executeTakeFirst();
    return statsOf(row);
  }

  async topOfBook(marketId: string): Promise<TopOfBookView | undefined> {
    const row = await this.db
      .selectFrom('book_state_view')
      .select(['best_bid as bestBid', 'best_ask as bestAsk', 'updated_at as updatedAt'])
      .where('market_id', '=', marketId)
      .executeTakeFirst();
    return row;
  }

  async lastTradeAt(marketId: string): Promise<Date | undefined> {
    const row = await this.db
      .selectFrom('trade_view')
      .select('executed_at')
      .where('market_id', '=', marketId)
      .orderBy('executed_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.executed_at;
  }
}
