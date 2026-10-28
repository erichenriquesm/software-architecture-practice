import type { BookProjector } from '../database/bookProjector.js';
import type { AmqpConnection } from '../platform/messaging/connection.js';
import type { MessageHandler } from '../platform/messaging/consumer.js';
import { bookHandler } from './consumers/bookConsumer.js';
import { tradesHandler } from './consumers/tradesConsumer.js';

type Channel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

export interface MatchingLog {
  readonly stream: string;
  readonly exchange: string;
}

/** RabbitMQ Stream with every matching event of the last 30 days; only the projection rebuild reads it. */
export const matchingLog: MatchingLog = { stream: 'marketData.matchingLog', exchange: 'matching.events' };

export const declareMatchingLog = async (channel: Channel, log: MatchingLog = matchingLog): Promise<void> => {
  await channel.assertQueue(log.stream, { durable: true, arguments: { 'x-queue-type': 'stream', 'x-max-age': '30D' } });
  await channel.bindQueue(log.stream, log.exchange, 'matching.#');
};

/** The stream also carries events no projection uses (orderRemoved, orderCancelRejected): those are skipped. */
export const matchingLogHandler = (bookProjector: BookProjector): MessageHandler => {
  const book = bookHandler(bookProjector);
  return async (envelope, trx, part) => {
    if (envelope.type === 'matching.tradeExecuted') return tradesHandler(envelope, trx, part);
    if (envelope.type === 'matching.bookSnapshot') return book(envelope, trx, part);
  };
};
