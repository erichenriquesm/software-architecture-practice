import type { BookProjector, BookSnapshot } from '../../database/bookProjector.js';
import type { MessageHandler } from '../../platform/messaging/consumer.js';
import type { ConsumerQueue } from '../../platform/messaging/topology.js';
import { consumedEvent } from './consumedEvent.js';

export const bookQueue: ConsumerQueue = {
  queue: 'marketData.book',
  bindings: [{ exchange: 'matching.events', routingKey: 'matching.bookSnapshot.*' }],
  retryMode: 'delayQueues',
};

const snapshotOf = consumedEvent<BookSnapshot>('matching.bookSnapshot');

/** Runs without inbox (see the worker): the sequence already makes applying a snapshot twice harmless. */
export const bookHandler =
  (projector: BookProjector): MessageHandler =>
  async (envelope, trx) => {
    await projector.project(trx, snapshotOf(envelope), new Date(envelope.occurredAt));
  };
