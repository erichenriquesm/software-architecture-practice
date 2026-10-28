import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './database.js';

export interface ExecutedTrade {
  readonly tradeId: string;
  readonly marketId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly executedAt: string;
}

const minute = 60_000;

export const minuteOf = (instant: Date): Date => new Date(Math.floor(instant.getTime() / minute) * minute);

const insertTrade = async (trx: Transaction<Database>, trade: ExecutedTrade, executedAt: Date): Promise<boolean> => {
  const result = await trx
    .insertInto('trade_view')
    .values({
      trade_id: trade.tradeId,
      market_id: trade.marketId,
      buy_order_id: trade.buyOrderId,
      sell_order_id: trade.sellOrderId,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      executed_at: executedAt,
    })
    .onConflict((conflict) => conflict.column('trade_id').doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
};

const earlier = sql`(excluded.open_at, excluded.open_trade_id) < (candle_1m_view.open_at, candle_1m_view.open_trade_id)`;
const later = sql`(excluded.close_at, excluded.close_trade_id) > (candle_1m_view.close_at, candle_1m_view.close_trade_id)`;

/**
 * Commutative upsert: extremes, sums and the open/close chosen by (executedAt, tradeId) give the same candle
 * whatever order the trades of the minute arrive in. Every expression reads the row as it was before the update.
 */
const addToCandle = async (trx: Transaction<Database>, trade: ExecutedTrade, executedAt: Date): Promise<void> => {
  await trx
    .insertInto('candle_1m_view')
    .values({
      market_id: trade.marketId,
      bucket_start: minuteOf(executedAt),
      open_price: trade.price,
      open_at: executedAt,
      open_trade_id: trade.tradeId,
      close_price: trade.price,
      close_at: executedAt,
      close_trade_id: trade.tradeId,
      min_price: trade.price,
      max_price: trade.price,
      volume: sql<string>`${trade.quantity}::numeric * ${trade.price}::numeric`,
      trade_count: 1,
    })
    .onConflict((conflict) =>
      conflict.columns(['market_id', 'bucket_start']).doUpdateSet({
        open_price: sql`case when ${earlier} then excluded.open_price else candle_1m_view.open_price end`,
        open_at: sql`case when ${earlier} then excluded.open_at else candle_1m_view.open_at end`,
        open_trade_id: sql`case when ${earlier} then excluded.open_trade_id else candle_1m_view.open_trade_id end`,
        close_price: sql`case when ${later} then excluded.close_price else candle_1m_view.close_price end`,
        close_at: sql`case when ${later} then excluded.close_at else candle_1m_view.close_at end`,
        close_trade_id: sql`case when ${later} then excluded.close_trade_id else candle_1m_view.close_trade_id end`,
        min_price: sql`least(candle_1m_view.min_price, excluded.min_price)`,
        max_price: sql`greatest(candle_1m_view.max_price, excluded.max_price)`,
        volume: sql`candle_1m_view.volume + excluded.volume`,
        trade_count: sql`candle_1m_view.trade_count + 1`,
      }),
    )
    .execute();
};

/**
 * trade_view and candle_1m_view in the caller's transaction. The candle only counts a trade that has just entered
 * trade_view, so neither a redelivery nor a replay of the stream adds its volume twice. Returns whether it was new.
 */
export const projectTrade = async (trx: Transaction<Database>, trade: ExecutedTrade): Promise<boolean> => {
  const executedAt = new Date(trade.executedAt);
  if (!(await insertTrade(trx, trade, executedAt))) return false;
  await addToCandle(trx, trade, executedAt);
  return true;
};
