import { InvalidOrderDataError } from '../../domain/errors.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { RejectReason } from '../../domain/valueObjects/orderStatus.js';
import type { OrderStore } from './orderStore.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';

const rejectReasons: readonly RejectReason[] = ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND'];

/** Saga S2 compensation: the wallet refused the reservation; the order ends rejected with the reason. */
export class RejectOrder implements UseCase<[orderId: string, reason: string], void> {
  constructor(private readonly orderStore: OrderStore) {}

  async execute(rawOrderId: string, reason: string): Promise<void> {
    const orderId = OrderId.from(rawOrderId);
    const rejectReason = rejectReasons.find((candidate) => candidate === reason);
    if (!rejectReason) throw new InvalidOrderDataError('reason', `unknown rejection ${reason}`);
    await retryOnConflict(() => this.orderStore.change(orderId, (order) => order.markRejected(rejectReason)));
  }
}
