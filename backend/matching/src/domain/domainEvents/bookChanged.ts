import type { BookLevel } from '../entities/bookSide.js';
import type { DomainEvent } from './domainEvent.js';

/** Full state of the book levels after a change, with its sequence (not a delta). */
export interface BookChanged extends DomainEvent {
  readonly type: 'BookChanged';
  readonly marketId: string;
  readonly sequence: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}
