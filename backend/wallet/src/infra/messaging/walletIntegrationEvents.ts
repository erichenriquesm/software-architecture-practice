import type { BalanceChanged } from '../../domain/domainEvents/balanceChanged.js';
import type { DomainEvent } from '../../domain/domainEvents/domainEvent.js';
import type { FundsReservationRejected } from '../../domain/domainEvents/fundsReservationRejected.js';
import type { FundsReserved } from '../../domain/domainEvents/fundsReserved.js';
import type { Database } from '../database/database.js';
import type { KyselyTransactionRunner } from '../database/kyselyTransactionRunner.js';
import type { InProcessDomainEventDispatcher } from '../platform/events/inProcessDomainEventDispatcher.js';
import { createEnvelope } from '../platform/messaging/envelope.js';
import { appendToOutbox } from '../platform/messaging/outbox.js';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';
import { currentCorrelation } from '../platform/observability/correlation.js';

export const walletEventsExchange = 'wallet.events';

/** Maps a domain event to its published contract and writes it to the outbox, in the same transaction. */
const publisher = <TEvent extends DomainEvent>(
  runner: KyselyTransactionRunner<Database>,
  type: string,
  payloadOf: (event: TEvent) => Record<string, unknown>,
) => {
  const validate = loadSchemaValidator<Record<string, unknown>>(`src/infra/contracts/published/events/${type}.v1.schema.json`);
  return async (event: TEvent): Promise<void> => {
    const correlation = currentCorrelation();
    const envelope = createEnvelope(
      { type, version: 1, producer: 'wallet', correlationId: correlation.correlationId, causationId: correlation.causationId, payload: validate(payloadOf(event)) },
      () => event.occurredAt,
    );
    await appendToOutbox(runner.transaction(), { routingKey: type, envelope });
  };
};

export const registerWalletIntegrationEvents = (dispatcher: InProcessDomainEventDispatcher, runner: KyselyTransactionRunner<Database>): void => {
  dispatcher.on<FundsReserved>(
    'FundsReserved',
    publisher(runner, 'wallet.fundsReserved', (event: FundsReserved) => ({
      orderId: event.orderId,
      accountId: event.accountId,
      assetId: event.assetId,
      amount: event.amount,
    })),
  );
  dispatcher.on<FundsReservationRejected>(
    'FundsReservationRejected',
    publisher(runner, 'wallet.fundsReservationRejected', (event: FundsReservationRejected) => ({
      orderId: event.orderId,
      accountId: event.accountId,
      reason: event.reason,
    })),
  );
  dispatcher.on<BalanceChanged>(
    'BalanceChanged',
    publisher(runner, 'wallet.balanceChanged', (event: BalanceChanged) => ({
      accountId: event.accountId,
      assetId: event.assetId,
      available: event.available,
      reserved: event.reserved,
      version: event.version,
    })),
  );
};
