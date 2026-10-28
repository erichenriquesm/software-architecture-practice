import type { DomainEvent } from '../../domain/domainEvents/domainEvent.js';

export interface DomainEventDispatcher {
  dispatch(events: readonly DomainEvent[]): Promise<void>;
}
