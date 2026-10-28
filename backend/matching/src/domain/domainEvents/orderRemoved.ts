import type { DomainEvent } from './domainEvent.js';

export type RemovalReason = 'CANCELLED' | 'SELF_TRADE_PREVENTION';

export interface OrderRemoved extends DomainEvent {
  readonly type: 'OrderRemoved';
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly remainingQuantity: string;
  readonly reason: RemovalReason;
}
