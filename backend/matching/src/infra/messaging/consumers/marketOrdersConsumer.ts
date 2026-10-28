import type { ExecuteOrderInput } from '../../../application/dtos/executeOrderDto.js';
import type { ExecuteOrder } from '../../../application/usecases/executeOrder.js';
import type { RemoveOrder } from '../../../application/usecases/removeOrder.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface CancelRequestedPayload {
  readonly orderId: string;
  readonly marketId: string;
}

/**
 * One queue per market with accepts and cancels together, so they never swap places; a single active
 * consumer, prefetch 1 and in-process retry (no delay queues): skipping an order would break time priority.
 */
export const marketOrdersQueue = (marketId: string): ConsumerQueue => ({
  queue: `matching.orders.${marketId}`,
  bindings: [
    { exchange: 'order.events', routingKey: `order.accepted.${marketId}` },
    { exchange: 'order.events', routingKey: `order.cancelRequested.${marketId}` },
  ],
  retryMode: 'inProcess',
  singleActiveConsumer: true,
});

export interface MarketOrdersUseCases {
  readonly executeOrder: ExecuteOrder;
  readonly removeOrder: RemoveOrder;
}

export const marketOrdersHandler = (useCases: MarketOrdersUseCases): MessageHandler => {
  const accepted = consumedEvent<ExecuteOrderInput>('order.accepted');
  const cancelRequested = consumedEvent<CancelRequestedPayload>('order.cancelRequested');
  return async (envelope) => {
    const correlation = correlationFrom(envelope.correlationId, envelope.eventId);
    if (envelope.type === 'order.cancelRequested') {
      const { orderId, marketId } = cancelRequested(envelope);
      return withCorrelation(correlation, () => useCases.removeOrder.execute(orderId, marketId));
    }
    const order = accepted(envelope);
    const executeOrderInput: ExecuteOrderInput = {
      orderId: order.orderId,
      accountId: order.accountId,
      marketId: order.marketId,
      side: order.side,
      quantity: order.quantity,
      price: order.price,
      acceptedAt: order.acceptedAt,
    };
    return withCorrelation(correlation, () => useCases.executeOrder.execute(executeOrderInput));
  };
};
