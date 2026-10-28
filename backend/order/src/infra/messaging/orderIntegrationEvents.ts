import type { DomainEvent } from '../../domain/domainEvents/domainEvent.js';
import type { OrderAccepted } from '../../domain/domainEvents/orderAccepted.js';
import type { OrderCancelRequested } from '../../domain/domainEvents/orderCancelRequested.js';
import type { OrderPlaced } from '../../domain/domainEvents/orderPlaced.js';
import type { OrderVoided } from '../../domain/domainEvents/orderVoided.js';
import type { Database } from '../database/database.js';
import type { KyselyTransactionRunner } from '../database/kyselyTransactionRunner.js';
import type { InProcessDomainEventDispatcher } from '../platform/events/inProcessDomainEventDispatcher.js';
import { createEnvelope } from '../platform/messaging/envelope.js';
import { appendToOutbox } from '../platform/messaging/outbox.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';
import { currentCorrelation } from '../platform/observability/correlation.js';

export const orderEventsExchange = 'order.events';

/** Maps a domain event to its published contract and writes it to the outbox, in the same transaction. */
const publisher = <TEvent extends DomainEvent>(
  runner: KyselyTransactionRunner<Database>,
  type: string,
  routingKeyOf: (event: TEvent) => string,
  payloadOf: (event: TEvent) => Record<string, unknown>,
) => {
  const validate = loadSchemaValidator<Record<string, unknown>>(`src/infra/contracts/published/events/${type}.v1.schema.json`);
  return async (event: TEvent): Promise<void> => {
    const correlation = currentCorrelation();
    const envelope = createEnvelope(
      { type, version: 1, producer: 'order', correlationId: correlation.correlationId, causationId: correlation.causationId, payload: validate(payloadOf(event)) },
      () => event.occurredAt,
    );
    await appendToOutbox(runner.transaction(), { routingKey: routingKeyOf(event), envelope });
  };
};

const orderPayload = (event: OrderPlaced | OrderAccepted | OrderVoided) => ({
  orderId: event.orderId,
  accountId: event.accountId,
  marketId: event.marketId,
  side: event.side,
  quantity: event.quantity,
  price: event.price,
});

export const registerOrderIntegrationEvents = (dispatcher: InProcessDomainEventDispatcher, runner: KyselyTransactionRunner<Database>): void => {
  dispatcher.on<OrderPlaced>('OrderPlaced', publisher(runner, 'order.placed', () => 'order.placed', orderPayload));
  dispatcher.on<OrderAccepted>(
    'OrderAccepted',
    publisher(runner, 'order.accepted', (event: OrderAccepted) => `order.accepted.${event.marketId}`, (event: OrderAccepted) => ({
      ...orderPayload(event),
      acceptedAt: event.occurredAt.toISOString(),
    })),
  );
  dispatcher.on<OrderCancelRequested>(
    'OrderCancelRequested',
    publisher(runner, 'order.cancelRequested', (event: OrderCancelRequested) => `order.cancelRequested.${event.marketId}`, (event: OrderCancelRequested) => ({
      orderId: event.orderId,
      marketId: event.marketId,
    })),
  );
  dispatcher.on<OrderVoided>(
    'OrderVoided',
    publisher(runner, 'order.voided', () => 'order.voided', (event: OrderVoided) => ({ ...orderPayload(event), reason: event.reason })),
  );
};
