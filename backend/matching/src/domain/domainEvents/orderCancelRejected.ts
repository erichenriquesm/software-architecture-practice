import type { DomainEvent } from './domainEvent.js';

export interface OrderCancelRejected extends DomainEvent {
  readonly type: 'OrderCancelRejected';
  readonly orderId: string;
  readonly marketId: string;
  readonly reason: 'NOT_IN_BOOK';
}
