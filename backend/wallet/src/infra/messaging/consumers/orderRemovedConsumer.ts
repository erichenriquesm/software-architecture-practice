import type { ReleaseReservationInput } from '../../../application/dtos/releaseReservationDto.js';
import type { ReleaseReservation } from '../../../application/usecases/releaseReservation.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface OrderRemovedPayload {
  readonly orderId: string;
  readonly accountId: string;
  readonly remainingQuantity: string;
}

export const orderRemovedQueue: ConsumerQueue = {
  queue: 'wallet.orderRemoved',
  bindings: [{ exchange: 'matching.events', routingKey: 'matching.orderRemoved.*' }],
  retryMode: 'delayQueues',
};

export const orderRemovedHandler = (releaseReservation: ReleaseReservation): MessageHandler => {
  const payloadOf = consumedEvent<OrderRemovedPayload>('matching.orderRemoved');
  return async (envelope) => {
    const removed = payloadOf(envelope);
    const releaseReservationInput: ReleaseReservationInput = {
      orderId: removed.orderId,
      accountId: removed.accountId,
      remainingQuantity: removed.remainingQuantity,
    };
    await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () =>
      releaseReservation.execute(releaseReservationInput),
    );
  };
};
