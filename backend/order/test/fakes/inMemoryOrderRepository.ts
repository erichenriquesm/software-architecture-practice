import type { OrderRepository } from '../../src/application/contracts/orderRepository.js';
import type { OrderState } from '../../src/domain/entities/order.js';
import { Order } from '../../src/domain/entities/order.js';
import { ConcurrentOrderUpdateError } from '../../src/domain/errors.js';
import type { OrderId } from '../../src/domain/valueObjects/orderId.js';

/** Keeps a copy of each saved order and checks the version like the real repository. */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly stored = new Map<string, OrderState>();
  conflictsToSimulate = 0;

  async findById(orderId: OrderId): Promise<Order | undefined> {
    const state = this.stored.get(orderId.value);
    return state ? Order.restore(state) : undefined;
  }

  async save(order: Order): Promise<void> {
    const state = order.snapshot;
    const current = this.stored.get(state.orderId.value)?.version ?? 0;
    if (this.conflictsToSimulate > 0 || current !== state.version) {
      this.conflictsToSimulate = Math.max(0, this.conflictsToSimulate - 1);
      throw new ConcurrentOrderUpdateError(state.orderId.value);
    }
    this.stored.set(state.orderId.value, { ...state, version: order.nextVersion });
  }
}
