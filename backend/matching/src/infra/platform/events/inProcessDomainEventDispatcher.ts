import type { DomainEventDispatcher } from '../../../application/contracts/domainEventDispatcher.js';
import type { DomainEvent } from '../../../domain/domainEvents/domainEvent.js';

export type TransactionalHandler<TEvent extends DomainEvent = DomainEvent> = (event: TEvent) => Promise<void>;

export class InProcessDomainEventDispatcher implements DomainEventDispatcher {
  private readonly handlers = new Map<string, TransactionalHandler[]>();

  on<TEvent extends DomainEvent>(type: TEvent['type'], handler: TransactionalHandler<TEvent>): this {
    const registered = this.handlers.get(type) ?? [];
    registered.push(handler as TransactionalHandler);
    this.handlers.set(type, registered);
    return this;
  }

  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers.get(event.type) ?? []) await handler(event);
    }
  }
}
