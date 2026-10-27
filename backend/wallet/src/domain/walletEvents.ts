import type { DomainEvent } from './aggregateRoot.js';

export interface BalanceChanged extends DomainEvent {
  readonly type: 'BalanceChanged';
  readonly accountId: string;
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: number;
}

export interface FundsReserved extends DomainEvent {
  readonly type: 'FundsReserved';
  readonly orderId: string;
  readonly accountId: string;
  readonly assetId: string;
  readonly amount: string;
}

export type ReservationRejection = 'INSUFFICIENT_FUNDS' | 'WALLET_NOT_FOUND';

export interface FundsReservationRejected extends DomainEvent {
  readonly type: 'FundsReservationRejected';
  readonly orderId: string;
  readonly accountId: string;
  readonly reason: ReservationRejection;
}

export type WalletEvent = BalanceChanged | FundsReserved | FundsReservationRejected;

export type MovementReason = 'DEPOSIT' | 'WITHDRAW' | 'RESERVE' | 'SETTLE' | 'RELEASE' | 'VOID';

export interface Movement {
  readonly assetId: string;
  readonly availableDelta: string;
  readonly reservedDelta: string;
  readonly reason: MovementReason;
  readonly referenceId: string;
}
