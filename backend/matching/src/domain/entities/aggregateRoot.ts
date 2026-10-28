import type { DomainEvent } from '../domainEvents/domainEvent.js';

export abstract class AggregateRoot<TEvent extends DomainEvent = DomainEvent> {
  private recordedEvents: TEvent[] = [];

  protected recordEvent(event: TEvent): void {
    this.recordedEvents.push(event);
  }

  pullEvents(): TEvent[] {
    const events = this.recordedEvents;
    this.recordedEvents = [];
    return events;
  }
}
