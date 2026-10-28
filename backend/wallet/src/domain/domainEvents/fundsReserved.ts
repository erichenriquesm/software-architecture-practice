import type { DomainEvent } from './domainEvent.js';

export interface FundsReserved extends DomainEvent {
  readonly type: 'FundsReserved';
  readonly orderId: string;
  readonly accountId: string;
  readonly assetId: string;
  readonly amount: string;
}
