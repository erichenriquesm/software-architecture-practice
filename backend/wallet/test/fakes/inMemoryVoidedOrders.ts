import type { VoidedOrders } from '../../src/application/contracts/voidedOrders.js';
import type { OrderId } from '../../src/domain/valueObjects/orderId.js';

export class InMemoryVoidedOrders implements VoidedOrders {
  readonly voided = new Set<string>();

  async isVoided(orderId: OrderId): Promise<boolean> {
    return this.voided.has(orderId.value);
  }

  async markVoided(orderId: OrderId): Promise<void> {
    this.voided.add(orderId.value);
  }
}
