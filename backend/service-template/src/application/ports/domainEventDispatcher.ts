import type { DomainEvent } from '../../domain/aggregateRoot.js';

export interface DomainEventDispatcher {
  dispatch(events: readonly DomainEvent[]): Promise<void>;
}
