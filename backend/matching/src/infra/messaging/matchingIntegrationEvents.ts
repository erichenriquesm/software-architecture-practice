import type { BookChanged } from '../../domain/domainEvents/bookChanged.js';
import type { DomainEvent } from '../../domain/domainEvents/domainEvent.js';
import type { OrderCancelRejected } from '../../domain/domainEvents/orderCancelRejected.js';
import type { OrderRemoved } from '../../domain/domainEvents/orderRemoved.js';
import type { TradeExecuted } from '../../domain/domainEvents/tradeExecuted.js';
import type { Database } from '../database/database.js';
import type { KyselyTransactionRunner } from '../database/kyselyTransactionRunner.js';
import type { InProcessDomainEventDispatcher } from '../platform/events/inProcessDomainEventDispatcher.js';
import { createEnvelope } from '../platform/messaging/envelope.js';
import { appendToOutbox } from '../platform/messaging/outbox.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';
import { currentCorrelation } from '../platform/observability/correlation.js';

export const matchingEventsExchange = 'matching.events';

interface MarketEvent extends DomainEvent {
  readonly marketId: string;
}

/** Maps a domain event to its published contract and writes it to the outbox, routed by market. */
const publisher = <TEvent extends MarketEvent>(runner: KyselyTransactionRunner<Database>, type: string, payloadOf: (event: TEvent) => Record<string, unknown>) => {
  const validate = loadSchemaValidator<Record<string, unknown>>(`src/infra/contracts/published/events/${type}.v1.schema.json`);
  return async (event: TEvent): Promise<void> => {
    const correlation = currentCorrelation();
    const envelope = createEnvelope(
      { type, version: 1, producer: 'matching', correlationId: correlation.correlationId, causationId: correlation.causationId, payload: validate(payloadOf(event)) },
      () => event.occurredAt,
    );
    await appendToOutbox(runner.transaction(), { routingKey: `${type}.${event.marketId}`, envelope });
  };
};

export const registerMatchingIntegrationEvents = (dispatcher: InProcessDomainEventDispatcher, runner: KyselyTransactionRunner<Database>): void => {
  dispatcher.on<TradeExecuted>(
    'TradeExecuted',
    publisher(runner, 'matching.tradeExecuted', ({ type: _type, occurredAt, ...trade }: TradeExecuted) => ({ ...trade, executedAt: occurredAt.toISOString() })),
  );
  dispatcher.on<OrderRemoved>('OrderRemoved', publisher(runner, 'matching.orderRemoved', ({ type: _type, occurredAt: _at, ...removed }: OrderRemoved) => removed));
  dispatcher.on<OrderCancelRejected>(
    'OrderCancelRejected',
    publisher(runner, 'matching.orderCancelRejected', ({ type: _type, occurredAt: _at, ...rejected }: OrderCancelRejected) => rejected),
  );
  dispatcher.on<BookChanged>(
    'BookChanged',
    publisher(runner, 'matching.bookSnapshot', ({ marketId, sequence, bids, asks }: BookChanged) => ({ marketId, sequence, bids, asks })),
  );
};
