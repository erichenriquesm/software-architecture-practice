import type { DomainEvent } from './domainEvent.js';

export type ReservationRejectionReason = 'INSUFFICIENT_FUNDS' | 'WALLET_NOT_FOUND';

export interface FundsReservationRejected extends DomainEvent {
  readonly type: 'FundsReservationRejected';
  readonly orderId: string;
  readonly accountId: string;
  readonly reason: ReservationRejectionReason;
}
