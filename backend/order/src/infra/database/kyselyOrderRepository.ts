import type { Clock } from '../../application/contracts/clock.js';
import type { OrderRepository } from '../../application/contracts/orderRepository.js';
import { Order } from '../../domain/entities/order.js';
import { ConcurrentOrderUpdateError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { RejectReason, RemovalReason, ReservationState, VoidReason } from '../../domain/valueObjects/orderStatus.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { Selectable } from 'kysely';
import type { Database, OrderTable } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';
import { projectOrderView } from './orderViewProjector.js';

const orderOf = (row: Selectable<OrderTable>): Order =>
  Order.restore({
    orderId: OrderId.from(row.order_id),
    accountId: AccountId.from(row.account_id),
    marketId: MarketId.from(row.market_id),
    side: Side.from(row.side),
    quantity: Quantity.from(row.quantity),
    price: Price.from(row.price),
    fillQuantity: Quantity.from(row.fill_quantity),
    fillValue: Quantity.from(row.fill_value),
    reservation: row.reservation as ReservationState,
    voidReason: row.void_reason as VoidReason | null,
    rejectReason: row.reject_reason as RejectReason | null,
    cancelRequested: row.cancel_requested,
    removedQuantity: row.removed_quantity === null ? null : Quantity.from(row.removed_quantity),
    removalReason: row.removal_reason as RemovalReason | null,
    createdAt: row.created_at,
    version: Number(row.version),
  });

const rowOf = (order: Order) => {
  const state = order.snapshot;
  return {
    order_id: state.orderId.value,
    market_id: state.marketId.value,
    account_id: state.accountId.value,
    side: state.side.value,
    quantity: state.quantity.toString(),
    price: state.price.toString(),
    fill_quantity: state.fillQuantity.toString(),
    fill_value: state.fillValue.toString(),
    reservation: state.reservation,
    void_reason: state.voidReason,
    reject_reason: state.rejectReason,
    removal_reason: state.removalReason,
    cancel_requested: state.cancelRequested,
    removed_quantity: state.removedQuantity?.toString() ?? null,
    created_at: state.createdAt,
    version: order.nextVersion,
  };
};

/** Saves the order with an optimistic version check and, in the same transaction, its order_view row. */
export class KyselyOrderRepository implements OrderRepository {
  constructor(
    private readonly runner: KyselyTransactionRunner<Database>,
    private readonly clock: Clock,
  ) {}

  async findById(orderId: OrderId): Promise<Order | undefined> {
    const row = await this.runner.executor().selectFrom('order').selectAll().where('order_id', '=', orderId.value).executeTakeFirst();
    return row ? orderOf(row) : undefined;
  }

  async save(order: Order): Promise<void> {
    const saved = order.snapshot.version === 0 ? await this.insert(order) : await this.update(order);
    if (!saved) throw new ConcurrentOrderUpdateError(order.snapshot.orderId.value);
    await projectOrderView(this.runner.executor(), order, this.clock.now());
  }

  private async insert(order: Order): Promise<boolean> {
    const result = await this.runner
      .executor()
      .insertInto('order')
      .values(rowOf(order))
      .onConflict((conflict) => conflict.column('order_id').doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  private async update(order: Order): Promise<boolean> {
    const { order_id: orderId, ...changes } = rowOf(order);
    const result = await this.runner
      .executor()
      .updateTable('order')
      .set(changes)
      .where('order_id', '=', orderId)
      .where('version', '=', String(order.snapshot.version))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}
