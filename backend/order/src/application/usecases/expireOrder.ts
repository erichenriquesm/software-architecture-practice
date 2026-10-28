import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { Clock } from '../contracts/clock.js';
import type { OrderStore } from './orderStore.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';

/** Saga S2 timeout: a pending order older than the timeout expires and publishes order.voided. */
export class ExpireOrder implements UseCase<[orderId: string], void> {
  constructor(
    private readonly orderStore: OrderStore,
    private readonly clock: Clock,
    private readonly pendingTimeoutMs: number,
  ) {}

  async execute(rawOrderId: string): Promise<void> {
    const orderId = OrderId.from(rawOrderId);
    await retryOnConflict(() => this.orderStore.change(orderId, (order) => order.expire(this.clock.now(), this.pendingTimeoutMs)));
  }
}
