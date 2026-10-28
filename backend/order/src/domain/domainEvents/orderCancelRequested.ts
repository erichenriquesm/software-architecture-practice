import type { DomainEvent } from './domainEvent.js';

export interface OrderCancelRequested extends DomainEvent {
  readonly type: 'OrderCancelRequested';
  readonly orderId: string;
  readonly marketId: string;
}
