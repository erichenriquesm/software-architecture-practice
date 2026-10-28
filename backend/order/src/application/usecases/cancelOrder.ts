import { NotOrderOwnerError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { OrderStatus } from '../../domain/valueObjects/orderStatus.js';
import type { Clock } from '../contracts/clock.js';
import type { OrderStore } from './orderStore.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';

/** Pending: cancelled at once (S2 compensation). In the book: cancelling until the matching service answers (S4). */
export class CancelOrder implements UseCase<[orderId: string, accountId: string], OrderStatus> {
  constructor(
    private readonly orderStore: OrderStore,
    private readonly clock: Clock,
  ) {}

  async execute(rawOrderId: string, rawAccountId: string): Promise<OrderStatus> {
    const orderId = OrderId.from(rawOrderId);
    const accountId = AccountId.from(rawAccountId);
    const order = await retryOnConflict(() =>
      this.orderStore.change(orderId, (loaded) => {
        if (!loaded.isOwnedBy(accountId)) throw new NotOrderOwnerError(orderId.value);
        loaded.requestCancel(this.clock.now());
      }),
    );
    return order.status();
  }
}
