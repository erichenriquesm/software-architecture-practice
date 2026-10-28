import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { Clock } from '../contracts/clock.js';
import type { OrderStore } from './orderStore.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';

/** Pivot of saga S2: the wallet reserved the funds, the order goes to the book. */
export class AcceptOrder implements UseCase<[orderId: string], void> {
  constructor(
    private readonly orderStore: OrderStore,
    private readonly clock: Clock,
  ) {}

  async execute(rawOrderId: string): Promise<void> {
    const orderId = OrderId.from(rawOrderId);
    await retryOnConflict(() => this.orderStore.change(orderId, (order) => order.markReserved(this.clock.now())));
  }
}
