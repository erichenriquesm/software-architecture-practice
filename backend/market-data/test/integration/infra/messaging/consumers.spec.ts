import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { MarketDataCore } from '../../../../src/infra/composition.js';
import { buildMarketDataCore } from '../../../../src/infra/composition.js';
import { bookHandler } from '../../../../src/infra/messaging/consumers/bookConsumer.js';
import { classifyMarketDataFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { tradesHandler } from '../../../../src/infra/messaging/consumers/tradesConsumer.js';
import type { MessageHandler } from '../../../../src/infra/platform/messaging/consumer.js';
import { Consumer } from '../../../../src/infra/platform/messaging/consumer.js';
import type { Envelope } from '../../../../src/infra/platform/messaging/envelope.js';
import { loadEnvelopeValidator } from '../../../../src/infra/platform/messaging/envelope.js';
import type { ConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';
import { deadLetterQueue, declareConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { matchingEnvelope, snapshotFixture, tradeFixture } from '../../../support/fixtures.js';
import type { TestBroker } from '../../../support/rabbitmq.js';
import { createTestBroker } from '../../../support/rabbitmq.js';

let database: TestDatabase;
let broker: TestBroker;
let core: MarketDataCore;
const consumers: Consumer[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
  core = buildMarketDataCore({ db: database.db });
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()));
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const startConsumer = async (routingKey: string, handler: MessageHandler, inbox: boolean): Promise<ConsumerQueue> => {
  const definition: ConsumerQueue = {
    queue: broker.uniqueName('marketData.test'),
    bindings: [{ exchange: broker.exchange, routingKey }],
    retryMode: 'delayQueues',
    retryTiers: [],
  };
  await declareConsumerQueue(broker.channel, definition);
  const consumer = new Consumer(core.runner, await broker.connection.createChannel(), {
    definition,
    handler,
    inbox,
    validate: loadEnvelopeValidator(),
    classify: classifyMarketDataFailure,
  });
  await consumer.start();
  consumers.push(consumer);
  return definition;
};

const publish = (routingKey: string, envelope: Envelope | object) =>
  broker.channel.publish(broker.exchange, routingKey, Buffer.from(JSON.stringify(envelope)));

const inboxOf = (queue: string) => database.db.selectFrom('inbox').selectAll().where('consumer', '=', queue).execute();

describe('marketData.trades consumer', () => {
  test('Should project a trade once when the same event is delivered twice, with an inbox row', async () => {
    // Given
    const definition = await startConsumer('matching.tradeExecuted.*', tradesHandler, true);
    const trade = tradeFixture({ quantity: '0.5', price: '84000' });
    const envelope = matchingEnvelope('matching.tradeExecuted', trade);

    // When
    publish('matching.tradeExecuted.BTC-USD', envelope);
    publish('matching.tradeExecuted.BTC-USD', envelope);

    // Then
    await expect.poll(async () => (await inboxOf(definition.queue)).length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const candles = await database.db.selectFrom('candle_1m_view').select(['volume', 'trade_count']).execute();
    expect(candles).toEqual([{ volume: '42000.00000000', trade_count: 1 }]);
  });

  test('Should park a payload outside the contract in the DLQ without projecting it', async () => {
    // Given
    const definition = await startConsumer('matching.tradeExecuted.*', tradesHandler, true);
    const broken = matchingEnvelope('matching.tradeExecuted', { ...tradeFixture(), price: 84000 });

    // When
    publish('matching.tradeExecuted.BTC-USD', broken);
    const parked = await broker.nextMessage(deadLetterQueue(definition.queue));

    // Then
    expect(String(parked.properties.headers?.['x-error'])).toContain('matching.tradeExecuted');
    expect(await inboxOf(definition.queue)).toHaveLength(0);
  });
});

describe('marketData.book consumer', () => {
  test('Should apply snapshots without an inbox and keep the newest even when an older one arrives last', async () => {
    // Given
    const definition = await startConsumer('matching.bookSnapshot.*', bookHandler(core.bookProjector), false);
    const newer = matchingEnvelope('matching.bookSnapshot', snapshotFixture({ sequence: 9, asks: [{ price: '90000', quantity: '1' }] }));
    const older = matchingEnvelope('matching.bookSnapshot', snapshotFixture({ sequence: 8, asks: [{ price: '80000', quantity: '1' }] }));

    // When
    publish('matching.bookSnapshot.BTC-USD', newer);
    await expect.poll(async () => (await core.getDepth.execute('BTC-USD')).sequence, { timeout: 10_000 }).toBe(9);
    publish('matching.bookSnapshot.BTC-USD', older);
    publish('matching.bookSnapshot.BTC-USD', newer);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Then
    expect((await core.getDepth.execute('BTC-USD')).sells).toEqual([{ quantity: '1.00000000', price: '90000.00000000' }]);
    expect(await inboxOf(definition.queue)).toHaveLength(0);
  });
});
