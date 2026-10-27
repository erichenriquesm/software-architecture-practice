import type { AccountCreated } from '../../../../domain/account.js';
import type { InProcessDomainEventDispatcher } from '../../../platform/events/inProcessDomainEventDispatcher.js';
import { createEnvelope } from '../../../platform/messaging/envelope.js';
import { appendToOutbox } from '../../../platform/messaging/outbox.js';
import type { SchemaValidator } from '../../../platform/messaging/schemas.js';
import { loadSchemaValidator } from '../../../platform/messaging/schemas.js';
import { currentCorrelation } from '../../../platform/observability/correlation.js';
import type { KyselyTransactionRunner } from '../../../platform/persistence/transactions.js';
import type { Database } from '../persistence/database.js';

export const accountEventsExchange = 'account.events';

export interface AccountCreatedPayload {
  readonly accountId: string;
}

export const registerAccountIntegrationEvents = (
  dispatcher: InProcessDomainEventDispatcher,
  runner: KyselyTransactionRunner<Database>,
  validateAccountCreated: SchemaValidator<AccountCreatedPayload> = loadSchemaValidator(
    'contracts/published/events/account.created.v1.schema.json',
  ),
): void => {
  dispatcher.on<AccountCreated>('AccountCreated', async (event) => {
    const payload = validateAccountCreated({ accountId: event.accountId });
    const correlation = currentCorrelation();
    const envelope = createEnvelope(
      { type: 'account.created', version: 1, producer: 'account', correlationId: correlation.correlationId, causationId: correlation.causationId, payload },
      () => event.occurredAt,
    );
    await appendToOutbox(runner.transaction(), { routingKey: 'account.created', envelope });
  });
};
