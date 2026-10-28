import type { VoidReason } from '../valueObjects/orderStatus.js';
import type { DomainEvent } from './domainEvent.js';

export interface OrderVoided extends DomainEvent {
  readonly type: 'OrderVoided';
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly reason: VoidReason;
}
