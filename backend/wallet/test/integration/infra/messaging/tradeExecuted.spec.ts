import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestBroker } from '../../../support/rabbitmq.js';
import { createTestBroker } from '../../../support/rabbitmq.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { FakeAccountGateway } from '../../../fakes/fakeAccountGateway.js';
import type { WalletCore } from '../../../../src/infra/composition.js';
import { buildWalletCore } from '../../../../src/infra/composition.js';
import { classifyWalletFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { tradeExecutedHandler, tradeExecutedUnits } from '../../../../src/infra/messaging/consumers/tradeExecutedConsumer.js';
import { Consumer } from '../../../../src/infra/platform/messaging/consumer.js';
import { createEnvelope, loadEnvelopeValidator } from '../../../../src/infra/platform/messaging/envelope.js';
import type { ConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';
import { deadLetterQueue, declareConsumerQueue } from '../../../../src/infra/platform/messaging/topology.js';

let database: TestDatabase;
let broker: TestBroker;
let core: WalletCore;
const buyer = randomUUID();
const seller = randomUUID();

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
  core = buildWalletCore({ db: database.db, accountGateway: new FakeAccountGateway([buyer, seller]) });
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const balanceOf = async (accountId: string, assetId: string) =>
  (await database.db.selectFrom('balance').select('available').where('account_id', '=', accountId).where('asset_id', '=', assetId).executeTakeFirst())
    ?.available;

describe('wallet.tradeExecuted consumer', () => {
  test('Should settle each side in its own transaction and, on redelivery, redo only the side that failed', async () => {
    // Given: the buyer reserved; the seller has no reservation yet, so its side fails
    const buyOrderId = randomUUID();
    const sellOrderId = randomUUID();
    await core.deposit.execute({ accountId: buyer, assetId: 'USD', quantity: '1000' });
    await core.reserveFunds.execute({ orderId: buyOrderId, accountId: buyer, marketId: 'BTC-USD', side: 'buy', quantity: '2', price: '100' });
    await core.deposit.execute({ accountId: seller, assetId: 'BTC', quantity: '2' });

    const definition: ConsumerQueue = {
      queue: broker.uniqueName('wallet.tradeExecuted'),
      bindings: [{ exchange: broker.exchange, routingKey: 'matching.tradeExecuted.BTC-USD' }],
      retryMode: 'delayQueues',
      retryTiers: [],
    };
    await declareConsumerQueue(broker.channel, definition);
    const consumer = new Consumer(core.runner, await broker.connection.createChannel(), {
      definition,
      handler: tradeExecutedHandler(core.settleTradeSide),
      units: tradeExecutedUnits,
      validate: loadEnvelopeValidator(),
      classify: classifyWalletFailure,
    });
    await consumer.start();
    const envelope = createEnvelope({
      type: 'matching.tradeExecuted',
      version: 1,
      producer: 'matching',
      correlationId: randomUUID(),
      payload: {
        tradeId: randomUUID(),
        marketId: 'BTC-USD',
        buyOrderId,
        sellOrderId,
        buyAccountId: buyer,
        sellAccountId: seller,
        side: 'buy',
        quantity: '2',
        price: '90',
        executedAt: '2026-10-28T12:00:00.000Z',
        bookSequence: 1,
      },
    });

    // When: the first delivery settles the buyer, fails on the seller and parks the message in the DLQ
    broker.channel.publish(broker.exchange, 'matching.tradeExecuted.BTC-USD', Buffer.from(JSON.stringify(envelope)));
    await broker.nextMessage(deadLetterQueue(definition.queue));

    // Then
    expect(await balanceOf(buyer, 'BTC')).toBe('2.00000000');
    expect(await balanceOf(buyer, 'USD')).toBe('820.00000000');

    // When: the seller's reservation now exists and the same message is delivered again (DLQ replay)
    await core.reserveFunds.execute({ orderId: sellOrderId, accountId: seller, marketId: 'BTC-USD', side: 'sell', quantity: '2', price: '90' });
    broker.channel.publish(broker.exchange, 'matching.tradeExecuted.BTC-USD', Buffer.from(JSON.stringify(envelope)));
    await expect.poll(() => balanceOf(seller, 'USD'), { timeout: 10_000 }).toBe('180.00000000');

    // Then: the buyer was not settled a second time
    expect(await balanceOf(buyer, 'BTC')).toBe('2.00000000');
    expect(await balanceOf(buyer, 'USD')).toBe('820.00000000');
    await consumer.stop();
  });
});
