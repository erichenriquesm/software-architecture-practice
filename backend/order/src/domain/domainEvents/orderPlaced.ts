import type { DomainEvent } from './domainEvent.js';

export interface OrderPlaced extends DomainEvent {
  readonly type: 'OrderPlaced';
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
}
