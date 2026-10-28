import type { CompensateReservation } from '../../../application/usecases/compensateReservation.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface OrderVoidedPayload {
  readonly orderId: string;
  readonly accountId: string;
}

export const orderVoidedQueue: ConsumerQueue = {
  queue: 'wallet.orderVoided',
  bindings: [{ exchange: 'order.events', routingKey: 'order.voided' }],
  retryMode: 'delayQueues',
};

export const orderVoidedHandler = (compensateReservation: CompensateReservation): MessageHandler => {
  const payloadOf = consumedEvent<OrderVoidedPayload>('order.voided');
  return async (envelope) => {
    const { orderId, accountId } = payloadOf(envelope);
    await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () =>
      compensateReservation.execute(orderId, accountId),
    );
  };
};
