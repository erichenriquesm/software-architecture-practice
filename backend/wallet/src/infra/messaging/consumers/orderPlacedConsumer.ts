import type { ReserveFundsInput } from '../../../application/dtos/reserveFundsDto.js';
import type { ReserveFunds } from '../../../application/usecases/reserveFunds.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

export const orderPlacedQueue: ConsumerQueue = {
  queue: 'wallet.orderPlaced',
  bindings: [{ exchange: 'order.events', routingKey: 'order.placed' }],
  retryMode: 'delayQueues',
};

export const orderPlacedHandler = (reserveFunds: ReserveFunds): MessageHandler => {
  const payloadOf = consumedEvent<ReserveFundsInput>('order.placed');
  return async (envelope) => {
    const order = payloadOf(envelope);
    const reserveFundsInput: ReserveFundsInput = {
      orderId: order.orderId,
      accountId: order.accountId,
      marketId: order.marketId,
      side: order.side,
      quantity: order.quantity,
      price: order.price,
    };
    await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () => reserveFunds.execute(reserveFundsInput));
  };
};
