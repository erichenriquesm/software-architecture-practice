import type { DomainEvent } from './domainEvent.js';

/** Final state of one asset after a change (not a delta), with the wallet version that produced it. */
export interface BalanceChanged extends DomainEvent {
  readonly type: 'BalanceChanged';
  readonly accountId: string;
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: number;
}
