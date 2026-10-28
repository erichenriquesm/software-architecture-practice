import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { MarketDataCore } from '../../../../src/infra/composition.js';
import { buildMarketDataCore } from '../../../../src/infra/composition.js';
import { projectTrade } from '../../../../src/infra/database/tradeProjector.js';
import { classifyMarketDataFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { declareMatchingLog, matchingLogHandler } from '../../../../src/infra/messaging/matchingLog.js';
import { MatchingLogReplayer } from '../../../../src/infra/messaging/matchingLogReplayer.js';
import { loadEnvelopeValidator } from '../../../../src/infra/platform/messaging/envelope.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { matchingEnvelope, snapshotFixture, tradeFixture } from '../../../support/fixtures.js';
import type { TestBroker } from '../../../support/rabbitmq.js';
import { createTestBroker } from '../../../support/rabbitmq.js';

let database: TestDatabase;
let broker: TestBroker;
let core: MarketDataCore;

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
  core = buildMarketDataCore({ db: database.db, clock: { now: () => new Date('2026-10-28T12:00:00.000Z') } });
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const publishConfirmed = async (routingKey: string, body: object): Promise<void> => {
  const channel = await broker.connection.createConfirmChannel();
  channel.publish(broker.exchange, routingKey, Buffer.from(JSON.stringify(body)));
  await channel.waitForConfirms();
  await channel.close();
};

describe('Projection rebuild from the marketData.matchingLog stream', () => {
  test('Should empty the projections and rebuild them from the first offset, ignoring what no projection uses', async () => {
    // Given
    const log = { stream: `marketData.matchingLog.${randomUUID().slice(0, 8)}`, exchange: broker.exchange };
    await declareMatchingLog(broker.channel, log);
    const trade = tradeFixture({ quantity: '2', price: '84000', executedAt: '2026-10-28T11:00:00.000Z' });
    await publishConfirmed('matching.tradeExecuted.BTC-USD', matchingEnvelope('matching.tradeExecuted', trade));
    await publishConfirmed('matching.tradeExecuted.BTC-USD', matchingEnvelope('matching.tradeExecuted', trade));
    await publishConfirmed('matching.orderRemoved.BTC-USD', matchingEnvelope('matching.orderRemoved', { orderId: randomUUID() }));
    await publishConfirmed('matching.bookSnapshot.BTC-USD', matchingEnvelope('matching.bookSnapshot', snapshotFixture({ sequence: 2, bids: [{ price: '83999', quantity: '3' }] })));
    await publishConfirmed('matching.bookSnapshot.BTC-USD', matchingEnvelope('matching.bookSnapshot', snapshotFixture({ sequence: 1, bids: [{ price: '1', quantity: '1' }] })));
    await publishConfirmed('matching.bookSnapshot.BTC-USD', { not: 'an envelope' });
    const stale = tradeFixture({ quantity: '100', price: '1' });
    await database.db.transaction().execute((trx) => projectTrade(trx, stale));

    // When
    const replayer = new MatchingLogReplayer(database.db, await broker.connection.createChannel(), {
      stream: log.stream,
      handler: matchingLogHandler(core.bookProjector),
      validate: loadEnvelopeValidator(),
      classify: classifyMarketDataFailure,
      idleTimeoutMs: 1_000,
    });
    const result = await replayer.rebuild();

    // Then
    expect(result).toEqual({ applied: 5, skipped: 1 });
    expect(await core.getMarket.execute({ marketId: 'BTC-USD' })).toMatchObject({ min: '84000.00000000', volume: '168000.00000000' });
    expect((await core.getDepth.execute('BTC-USD')).buys).toEqual([{ quantity: '3.00000000', price: '83999.00000000' }]);
    const trades = await core.getTrades.execute({ marketId: 'BTC-USD' });
    expect(trades.map((row) => row.tradeId)).toEqual([trade.tradeId]);
  });
});
