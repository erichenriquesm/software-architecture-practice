import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestBroker } from '../../../support/rabbitmq.js';
import { createTestBroker } from '../../../support/rabbitmq.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import type { OrderCore } from '../../../../src/infra/composition.js';
import { buildOrderCore } from '../../../../src/infra/composition.js';
import { classifyOrderFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { matchingResultsHandler, matchingResultsUnits } from '../../../../src/infra/messaging/consumers/matchingResultsConsumer.js';
import { Consumer } from '../../../../src/infra/platform/messaging/consumer.js';
import { createEnvelope, loadEnvelopeValidator } from '../../../../src/infra/platform/messaging/envelope.js';
import type { ConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';
import { declareConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';

let database: TestDatabase;
let broker: TestBroker;
let core: OrderCore;

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
  core = buildOrderCore({ db: database.db });
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const acceptedOrder = async (side: string, accountId: string): Promise<string> => {
  const orderId = await core.placeOrder.execute({ accountId, marketId: 'BTC-USD', side, quantity: '2', price: '100' });
  await core.acceptOrder.execute(orderId);
  return orderId;
};

describe('order.matchingResults consumer', () => {
  test('Should fill both orders of a trade once, even when the same event is delivered twice', async () => {
    // Given
    const buyOrderId = await acceptedOrder('buy', randomUUID());
    const sellOrderId = await acceptedOrder('sell', randomUUID());
    const definition: ConsumerQueue = {
      queue: broker.uniqueName('order.matchingResults'),
      bindings: [{ exchange: broker.exchange, routingKey: 'matching.#' }],
      retryMode: 'delayQueues',
      retryTiers: [],
    };
    await declareConsumerQueue(broker.channel, definition);
    const consumer = new Consumer(core.runner, await broker.connection.createChannel(), {
      definition,
      handler: matchingResultsHandler(core),
      units: matchingResultsUnits,
      validate: loadEnvelopeValidator(),
      classify: classifyOrderFailure,
    });
    await consumer.start();
    const trade = createEnvelope({
      type: 'matching.tradeExecuted',
      version: 1,
      producer: 'matching',
      correlationId: randomUUID(),
      payload: {
        tradeId: randomUUID(),
        marketId: 'BTC-USD',
        buyOrderId,
        sellOrderId,
        buyAccountId: randomUUID(),
        sellAccountId: randomUUID(),
        side: 'sell',
        quantity: '1.5',
        price: '100',
        executedAt: '2026-10-28T12:00:00.000Z',
        bookSequence: 1,
      },
    });

    // When
    broker.channel.publish(broker.exchange, 'matching.tradeExecuted.BTC-USD', Buffer.from(JSON.stringify(trade)));
    broker.channel.publish(broker.exchange, 'matching.tradeExecuted.BTC-USD', Buffer.from(JSON.stringify(trade)));

    // Then
    await expect.poll(async () => (await core.getOrder.execute(sellOrderId)).fillQuantity, { timeout: 10_000 }).toBe('1.50000000');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const buy = await core.getOrder.execute(buyOrderId);
    const sell = await core.getOrder.execute(sellOrderId);
    expect([buy.fillQuantity, buy.status, buy.fillPrice]).toEqual(['1.50000000', 'partiallyFilled', '100.00000000']);
    expect([sell.fillQuantity, sell.status]).toEqual(['1.50000000', 'partiallyFilled']);
    await consumer.stop();
  });
});
