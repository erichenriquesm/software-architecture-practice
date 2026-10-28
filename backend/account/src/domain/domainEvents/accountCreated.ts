import type { DomainEvent } from './domainEvent.js';

export interface AccountCreated extends DomainEvent {
  readonly type: 'AccountCreated';
  readonly accountId: string;
}
