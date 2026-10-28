import type { OrderStatus } from '../../domain/valueObjects/orderStatus.js';
import type { OrderView } from '../dtos/orderView.js';

export interface OrderDao {
  findById(orderId: string): Promise<OrderView | undefined>;
  listByAccount(accountId: string, status?: OrderStatus): Promise<OrderView[]>;
  /** Orders still waiting for the wallet that were created before `cutoff` (saga S2 timeout). */
  listPendingCreatedBefore(cutoff: Date): Promise<string[]>;
}
