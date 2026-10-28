import { Decimal } from 'decimal.js';
import type { Kysely } from 'kysely';
import type { Order } from '../../domain/entities/order.js';
import type { Database } from './database.js';

/** The only inexact number of the service: the average price, rounded half-even to 8 places for reading. */
export const averagePrice = (fillValue: string, fillQuantity: string): string | null => {
  const quantity = new Decimal(fillQuantity);
  if (quantity.isZero()) return null;
  return new Decimal(fillValue).dividedBy(quantity).toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN).toFixed(8);
};

/** Synchronous projection: called by the repository, in the same transaction that saves the order. */
export const projectOrderView = async (db: Kysely<Database>, order: Order, now: Date): Promise<void> => {
  const state = order.snapshot;
  const row = {
    order_id: state.orderId.value,
    account_id: state.accountId.value,
    market_id: state.marketId.value,
    side: state.side.value,
    quantity: state.quantity.toString(),
    price: state.price.toString(),
    fill_quantity: state.fillQuantity.toString(),
    fill_price: averagePrice(state.fillValue.toString(), state.fillQuantity.toString()),
    status: order.status(),
    status_reason: order.statusReason(),
    timestamp: state.createdAt,
    updated_at: now,
  };
  await db
    .insertInto('order_view')
    .values(row)
    .onConflict((conflict) =>
      conflict.column('order_id').doUpdateSet({
        fill_quantity: row.fill_quantity,
        fill_price: row.fill_price,
        status: row.status,
        status_reason: row.status_reason,
        updated_at: row.updated_at,
      }),
    )
    .execute();
};
