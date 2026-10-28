import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestBroker } from '../../support/rabbitmq.js';
import { createTestBroker } from '../../support/rabbitmq.js';
import type { TestDatabase } from '../../support/database.js';
import { createTestDatabase } from '../../support/database.js';
import { OrderBook } from '../../../src/domain/entities/orderBook.js';
import { AccountId } from '../../../src/domain/valueObjects/accountId.js';
import { MarketId } from '../../../src/domain/valueObjects/marketId.js';
import { OrderId } from '../../../src/domain/valueObjects/orderId.js';
import { Price } from '../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../src/domain/valueObjects/side.js';
import type { MatchingCore } from '../../../src/infra/composition.js';
import { buildMatchingCore } from '../../../src/infra/composition.js';
import { KyselyOrderBookRepository } from '../../../src/infra/database/kyselyOrderBookRepository.js';
import { classifyMatchingFailure } from '../../../src/infra/messaging/consumers/consumedEvent.js';
import { marketOrdersHandler } from '../../../src/infra/messaging/consumers/marketOrdersConsumer.js';
import { Consumer } from '../../../src/infra/platform/messaging/consumer.js';
import { createEnvelope, loadEnvelopeValidator } from '../../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../../src/infra/platform/messaging/schemas.js';
import type { ConsumerQueue } from '../../../src/infra/platform/messaging/topology.js';
import { declareConsumerQueue } from '../../../src/infra/platform/messaging/topology.js';

let database: TestDatabase;
let broker: TestBroker;
let core: MatchingCore;

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
  core = buildMatchingCore({ db: database.db });
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const incoming = (side: string, quantity: string, price: string, account = randomUUID()) => ({
  orderId: OrderId.from(randomUUID()),
  accountId: AccountId.from(account),
  side: Side.from(side),
  quantity: Quantity.from(quantity),
  price: Price.from(price),
  acceptedAt: new Date('2026-10-28T12:00:00Z'),
});

const outboxKeys = async () => (await database.db.selectFrom('outbox').select('routing_key').orderBy('id').execute()).map((row) => row.routing_key);

describe('KyselyOrderBookRepository', () => {
  test('Should reload the same book that was saved: entries, priorities, sequence and trades', async () => {
    // Given
    const repository = new KyselyOrderBookRepository(core.runner);
    const market = MarketId.from('ETH-USD');
    const book = OrderBook.empty(market);
    book.place(incoming('buy', '2', '100'), new Date(), () => randomUUID());
    book.place(incoming('buy', '1', '101'), new Date(), () => randomUUID());
    book.place(incoming('sell', '1.5', '100'), new Date(), () => randomUUID());

    // When
    await core.runner.run(() => repository.save(book));
    const reloaded = await repository.load(market);

    // Then
    expect([reloaded.sequence, reloaded.nextPriority]).toEqual([3, 4]);
    expect([reloaded.bestBid()?.price.toString(), reloaded.bestBid()?.remaining.toString()]).toEqual(['100.00000000', '1.50000000']);
    expect(await database.db.selectFrom('trade').select('quantity').where('market_id', '=', 'ETH-USD').orderBy('book_sequence').execute()).toEqual([
      { quantity: '1.00000000' },
      { quantity: '0.50000000' },
    ]);
  });

  test('Should leave nothing behind when the transaction fails after saving', async () => {
    // Given
    const repository = new KyselyOrderBookRepository(core.runner);
    const market = MarketId.from('SOL-USD');
    const book = OrderBook.empty(market);
    book.place(incoming('sell', '1', '10'), new Date(), () => randomUUID());

    // When
    await expect(
      core.runner.run(async () => {
        await repository.save(book);
        throw new Error('failure after saving');
      }),
    ).rejects.toThrowError('failure after saving');

    // Then
    expect((await repository.load(market)).bestAsk()).toBeUndefined();
  });
});

describe('matching.orders.<market> consumer', () => {
  test('Should process accepts and cancels in arrival order, ignore a repeated accept and publish valid events by market', async () => {
    // Given
    const definition: ConsumerQueue = {
      queue: broker.uniqueName('matching.orders.BTC-USD'),
      bindings: [{ exchange: broker.exchange, routingKey: 'order.#' }],
      retryMode: 'inProcess',
      singleActiveConsumer: true,
    };
    await declareConsumerQueue(broker.channel, definition);
    const consumer = new Consumer(core.runner, await broker.connection.createChannel(), {
      definition,
      handler: marketOrdersHandler(core),
      validate: loadEnvelopeValidator(),
      classify: classifyMatchingFailure,
      prefetch: 1,
      inProcessRetry: { baseMs: 1, capMs: 5, maxAttempts: 3 },
    });
    await consumer.start();
    const [buyId, sellId, restId] = [randomUUID(), randomUUID(), randomUUID()];
    const accepted = (orderId: string, side: string, quantity: string, price: string) =>
      createEnvelope({
        type: 'order.accepted',
        version: 1,
        producer: 'order',
        correlationId: randomUUID(),
        payload: { orderId, accountId: randomUUID(), marketId: 'BTC-USD', side, quantity, price, acceptedAt: '2026-10-28T12:00:00.000Z' },
      });
    const cancel = createEnvelope({ type: 'order.cancelRequested', version: 1, producer: 'order', correlationId: randomUUID(), payload: { orderId: restId, marketId: 'BTC-USD' } });
    const buy = accepted(buyId, 'buy', '1', '100');
    const messages = [buy, buy, accepted(sellId, 'sell', '1', '100'), accepted(restId, 'sell', '2', '105'), cancel];

    // When
    for (const message of messages) broker.channel.publish(broker.exchange, `${message.type}.BTC-USD`, Buffer.from(JSON.stringify(message)));

    // Then
    await expect.poll(outboxKeys, { timeout: 10_000 }).toContain('matching.orderRemoved.BTC-USD');
    const outbox = (await database.db.selectFrom('outbox').select(['routing_key', 'envelope']).where('routing_key', 'like', '%.BTC-USD').orderBy('id').execute()).map(
      (row) => [row.routing_key, (row.envelope as { payload: Record<string, unknown> }).payload] as const,
    );
    expect(outbox.map(([key]) => key)).toEqual([
      'matching.bookSnapshot.BTC-USD',
      'matching.tradeExecuted.BTC-USD',
      'matching.bookSnapshot.BTC-USD',
      'matching.bookSnapshot.BTC-USD',
      'matching.orderRemoved.BTC-USD',
      'matching.bookSnapshot.BTC-USD',
    ]);
    const validateTrade = loadSchemaValidator('src/infra/contracts/published/events/matching.tradeExecuted.v1.schema.json');
    expect(validateTrade(outbox[1]?.[1])).toMatchObject({ buyOrderId: buyId, sellOrderId: sellId, side: 'sell', price: '100.00000000' });
    expect(outbox[4]?.[1]).toMatchObject({ orderId: restId, reason: 'CANCELLED', remainingQuantity: '2.00000000' });
    await consumer.stop();
  });
});
