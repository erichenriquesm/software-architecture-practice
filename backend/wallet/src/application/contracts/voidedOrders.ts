import type { OrderId } from '../../domain/valueObjects/orderId.js';

/**
 * Tombstones of the S2 saga: an order voided before it was reserved must never get a reservation.
 * Both methods run inside the caller's transaction and serialize on the order, so a late reservation
 * and its compensation never interleave.
 */
export interface VoidedOrders {
  isVoided(orderId: OrderId): Promise<boolean>;
  markVoided(orderId: OrderId): Promise<void>;
}
