import type { ApplyFill } from '../../../application/usecases/applyFill.js';
import type { RegisterRemoval } from '../../../application/usecases/registerRemoval.js';
import type { RevertCancelRequest } from '../../../application/usecases/revertCancelRequest.js';
import type { ConsumerUnit, MessageHandler } from '../../platform/messaging/consumer.js';
import type { Envelope } from '../../platform/messaging/envelope.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface TradeExecutedPayload {
  readonly tradeId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly quantity: string;
  readonly price: string;
}

interface OrderRemovedPayload {
  readonly orderId: string;
  readonly remainingQuantity: string;
  readonly reason: string;
}

interface OrderCancelRejectedPayload {
  readonly orderId: string;
}

export const matchingResultsQueue: ConsumerQueue = {
  queue: 'order.matchingResults',
  bindings: [
    { exchange: 'matching.events', routingKey: 'matching.tradeExecuted.*' },
    { exchange: 'matching.events', routingKey: 'matching.orderRemoved.*' },
    { exchange: 'matching.events', routingKey: 'matching.orderCancelRejected.*' },
  ],
  retryMode: 'delayQueues',
};

const tradeOf = consumedEvent<TradeExecutedPayload>('matching.tradeExecuted');
const removalOf = consumedEvent<OrderRemovedPayload>('matching.orderRemoved');
const cancelRejectionOf = consumedEvent<OrderCancelRejectedPayload>('matching.orderCancelRejected');

/** A trade fills two orders (two aggregates): one transaction and one inbox key `eventId:orderId` per order. */
export const matchingResultsUnits = (envelope: Envelope): readonly ConsumerUnit[] => {
  if (envelope.type !== 'matching.tradeExecuted') return [{ key: envelope.eventId, part: null }];
  const trade = tradeOf(envelope);
  return [
    { key: `${envelope.eventId}:${trade.buyOrderId}`, part: trade.buyOrderId },
    { key: `${envelope.eventId}:${trade.sellOrderId}`, part: trade.sellOrderId },
  ];
};

export interface MatchingResultsUseCases {
  readonly applyFill: ApplyFill;
  readonly registerRemoval: RegisterRemoval;
  readonly revertCancelRequest: RevertCancelRequest;
}

const handle = (useCases: MatchingResultsUseCases, envelope: Envelope, part: string | null): Promise<void> => {
  if (envelope.type === 'matching.orderRemoved') {
    const { orderId, remainingQuantity, reason } = removalOf(envelope);
    return useCases.registerRemoval.execute({ orderId, remainingQuantity, reason });
  }
  if (envelope.type === 'matching.orderCancelRejected') return useCases.revertCancelRequest.execute(cancelRejectionOf(envelope).orderId);
  const trade = tradeOf(envelope);
  return useCases.applyFill.execute({ orderId: String(part), tradeId: trade.tradeId, quantity: trade.quantity, price: trade.price });
};

export const matchingResultsHandler =
  (useCases: MatchingResultsUseCases): MessageHandler =>
  async (envelope, _trx, part) =>
    withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () => handle(useCases, envelope, part));
