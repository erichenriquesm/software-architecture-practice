import type { SettleTradeSideInput } from '../../../application/dtos/settleTradeSideDto.js';
import type { SettleTradeSide } from '../../../application/usecases/settleTradeSide.js';
import type { ConsumerUnit, MessageHandler } from '../../platform/messaging/consumer.js';
import type { Envelope } from '../../platform/messaging/envelope.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../platform/observability/correlation.js';
import { consumedEvent } from './consumedEvent.js';

interface TradeExecutedPayload {
  readonly tradeId: string;
  readonly marketId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly buyAccountId: string;
  readonly sellAccountId: string;
  readonly quantity: string;
  readonly price: string;
}

export const tradeExecutedQueue: ConsumerQueue = {
  queue: 'wallet.tradeExecuted',
  bindings: [{ exchange: 'matching.events', routingKey: 'matching.tradeExecuted.*' }],
  retryMode: 'delayQueues',
};

const payloadOf = consumedEvent<TradeExecutedPayload>('matching.tradeExecuted');

/** Buyer and seller are different wallets (aggregates), so each side is its own transaction and inbox key. */
export const tradeExecutedUnits = (envelope: Envelope): readonly ConsumerUnit[] => {
  const trade = payloadOf(envelope);
  return [
    { key: `${envelope.eventId}:${trade.buyAccountId}:buyer`, part: 'buyer' },
    { key: `${envelope.eventId}:${trade.sellAccountId}:seller`, part: 'seller' },
  ];
};

const sideOf = (trade: TradeExecutedPayload, role: 'buyer' | 'seller'): SettleTradeSideInput => ({
  tradeId: trade.tradeId,
  orderId: role === 'buyer' ? trade.buyOrderId : trade.sellOrderId,
  accountId: role === 'buyer' ? trade.buyAccountId : trade.sellAccountId,
  role,
  marketId: trade.marketId,
  quantity: trade.quantity,
  price: trade.price,
});

export const tradeExecutedHandler =
  (settleTradeSide: SettleTradeSide): MessageHandler =>
  async (envelope, _trx, part) => {
    const role = part === 'seller' ? 'seller' : 'buyer';
    const settleTradeSideInput = sideOf(payloadOf(envelope), role);
    await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () => settleTradeSide.execute(settleTradeSideInput));
  };
