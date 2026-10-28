import type { OpenWallet } from '../../../application/usecases/openWallet.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface AccountCreatedPayload {
  readonly accountId: string;
}

export const accountCreatedQueue: ConsumerQueue = {
  queue: 'wallet.accountCreated',
  bindings: [{ exchange: 'account.events', routingKey: 'account.created' }],
  retryMode: 'delayQueues',
};

export const accountCreatedHandler = (openWallet: OpenWallet): MessageHandler => {
  const payloadOf = consumedEvent<AccountCreatedPayload>('account.created');
  return async (envelope) => {
    const { accountId } = payloadOf(envelope);
    await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () => openWallet.execute(accountId));
  };
};
