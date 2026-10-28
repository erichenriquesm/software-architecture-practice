import type { DomainEventDispatcher } from '../../src/application/contracts/domainEventDispatcher.js';
import type { DomainEvent } from '../../src/domain/domainEvents/domainEvent.js';

export class RecordingDomainEventDispatcher implements DomainEventDispatcher {
  readonly dispatched: DomainEvent[] = [];

  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    this.dispatched.push(...events);
  }
}
