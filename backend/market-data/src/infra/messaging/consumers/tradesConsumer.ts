import type { ExecutedTrade } from '../../database/tradeProjector.js';
import { projectTrade } from '../../database/tradeProjector.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { consumedEvent } from './consumedEvent.js';

export const tradesQueue: ConsumerQueue = {
  queue: 'marketData.trades',
  bindings: [{ exchange: 'matching.events', routingKey: 'matching.tradeExecuted.*' }],
  retryMode: 'delayQueues',
};

const tradeOf = consumedEvent<ExecutedTrade>('matching.tradeExecuted');

/** trade_view + candle_1m_view in the consumer's transaction, next to the inbox row of the eventId. */
export const tradesHandler: MessageHandler = async (envelope, trx) => {
  await projectTrade(trx, tradeOf(envelope));
};
