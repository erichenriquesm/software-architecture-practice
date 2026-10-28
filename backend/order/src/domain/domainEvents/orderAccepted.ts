import type { DomainEvent } from './domainEvent.js';

export interface OrderAccepted extends DomainEvent {
  readonly type: 'OrderAccepted';
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
}
