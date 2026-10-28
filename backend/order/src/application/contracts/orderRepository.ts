import type { Order } from '../../domain/entities/order.js';
import type { OrderId } from '../../domain/valueObjects/orderId.js';

export interface OrderRepository {
  findById(orderId: OrderId): Promise<Order | undefined>;
  /** Saves the order and its read model together. Throws ConcurrentOrderUpdateError when the stored version moved. */
  save(order: Order): Promise<void>;
}
