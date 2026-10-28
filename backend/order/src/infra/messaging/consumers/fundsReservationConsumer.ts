import type { AcceptOrder } from '../../../application/usecases/acceptOrder.js';
import type { RejectOrder } from '../../../application/usecases/rejectOrder.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface FundsReservedPayload {
  readonly orderId: string;
}

interface FundsReservationRejectedPayload {
  readonly orderId: string;
  readonly reason: string;
}

export const fundsReservationQueue: ConsumerQueue = {
  queue: 'order.fundsReservation',
  bindings: [
    { exchange: 'wallet.events', routingKey: 'wallet.fundsReserved' },
    { exchange: 'wallet.events', routingKey: 'wallet.fundsReservationRejected' },
  ],
  retryMode: 'delayQueues',
};

export interface FundsReservationUseCases {
  readonly acceptOrder: AcceptOrder;
  readonly rejectOrder: RejectOrder;
}

/** Answer of the wallet to saga S2 step 2: the reservation was made (accept) or refused (reject). */
export const fundsReservationHandler = (useCases: FundsReservationUseCases): MessageHandler => {
  const reserved = consumedEvent<FundsReservedPayload>('wallet.fundsReserved');
  const rejected = consumedEvent<FundsReservationRejectedPayload>('wallet.fundsReservationRejected');
  return async (envelope) => {
    const correlation = correlationFrom(envelope.correlationId, envelope.eventId);
    if (envelope.type === 'wallet.fundsReservationRejected') {
      const { orderId, reason } = rejected(envelope);
      return withCorrelation(correlation, () => useCases.rejectOrder.execute(orderId, reason));
    }
    const { orderId } = reserved(envelope);
    return withCorrelation(correlation, () => useCases.acceptOrder.execute(orderId));
  };
};
