import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { MarketDataCore } from '../../../../src/infra/composition.js';
import { buildMarketDataApi } from '../../../../src/infra/composition.js';
import { projectTrade } from '../../../../src/infra/database/tradeProjector.js';
import type { RateLimiter } from '../../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { fixedClock } from '../../../fakes/fixedSystem.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { snapshotFixture, tradeFixture } from '../../../support/fixtures.js';

const unlimited: RateLimiter = {
  check: async (check) => ({ allowed: true, remaining: check.policy.limit, resetSeconds: 0, retryAfterSeconds: 0, policy: check.policy }),
};

let database: TestDatabase;
let app: FastifyInstance;
let core: MarketDataCore;

beforeAll(async () => {
  database = await createTestDatabase();
  ({ app, core } = buildMarketDataApi({ db: database.db, rateLimiter: unlimited, clock: fixedClock(new Date('2026-10-28T12:00:00.000Z')) }));
});

beforeEach(async () => {
  await sql`truncate table trade_view, candle_1m_view, book_state_view, depth_view`.execute(database.db);
});

afterAll(async () => {
  await app.close();
  await database.destroy();
});

const get = (url: string) => app.inject({ method: 'GET', url });

const seedTrades = async (count: number) => {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const trade = tradeFixture({ price: String(84_000 + index), executedAt: new Date(Date.UTC(2026, 9, 28, 11, 0, index)).toISOString() });
    await database.db.transaction().execute((trx) => projectTrade(trx, trade));
    ids.push(trade.tradeId);
  }
  return ids;
};

describe('GET /markets/:marketId/depth', () => {
  test('Should answer the levels of the last snapshot with sequence and asOf, aggregated by the precision asked', async () => {
    // Given
    const snapshot = snapshotFixture({
      sequence: 7,
      bids: [
        { price: '84500', quantity: '10' },
        { price: '84999.99', quantity: '1' },
      ],
      asks: [{ price: '85000.01', quantity: '2' }],
    });
    await database.db.transaction().execute((trx) => core.bookProjector.project(trx, snapshot, new Date('2026-10-28T11:30:00.000Z')));

    // When
    const raw = await get('/markets/BTC-USD/depth');
    const grouped = await get('/markets/BTC-USD/depth?precision=3');

    // Then
    expect(raw.statusCode).toBe(200);
    expect(raw.json()).toEqual({
      buys: [
        { quantity: '1.00000000', price: '84999.99000000' },
        { quantity: '10.00000000', price: '84500.00000000' },
      ],
      sells: [{ quantity: '2.00000000', price: '85000.01000000' }],
      sequence: 7,
      asOf: '2026-10-28T11:30:00.000Z',
    });
    expect(grouped.json().buys).toEqual([{ quantity: '11.00000000', price: '84000.00000000' }]);
  });

  test('Should answer an empty book before the first snapshot, 404 for an unknown market and 422 off the precision range', async () => {
    // When & Then
    expect((await get('/markets/BTC-USD/depth')).json()).toEqual({ buys: [], sells: [], sequence: 0, asOf: null });
    expect((await get('/markets/ETH-USD/depth')).statusCode).toBe(404);
    expect((await get('/markets/BTC-USD/depth?precision=-3')).statusCode).toBe(422);
  });
});

describe('GET /markets/:marketId/trades', () => {
  test('Should list the most recent first and page with before', async () => {
    // Given
    const ids = await seedTrades(5);

    // When
    const firstPage = (await get('/markets/BTC-USD/trades?limit=2')).json();
    const secondPage = (await get(`/markets/BTC-USD/trades?limit=2&before=${firstPage[1].timestamp}`)).json();

    // Then
    expect(firstPage.map((trade: { tradeId: string }) => trade.tradeId)).toEqual([ids[4], ids[3]]);
    expect(secondPage.map((trade: { tradeId: string }) => trade.tradeId)).toEqual([ids[2], ids[1]]);
    expect(Object.keys(firstPage[0]).sort()).toEqual(['buyOrderId', 'price', 'quantity', 'sellOrderId', 'side', 'timestamp', 'tradeId']);
    expect(firstPage[0]).toMatchObject({ side: 'sell', quantity: '1.00000000', price: '84004.00000000', timestamp: '2026-10-28T11:00:04.000Z' });
  });
});

describe('GET /markets/:marketId', () => {
  test('Should answer spread, min, max and volume of the rolling 24 h and the latest update as asOf', async () => {
    // Given
    await seedTrades(3);
    await database.db
      .transaction()
      .execute((trx) =>
        core.bookProjector.project(
          trx,
          snapshotFixture({ bids: [{ price: '84000', quantity: '1' }], asks: [{ price: '84000.5', quantity: '1' }] }),
          new Date('2026-10-28T10:00:00.000Z'),
        ),
      );

    // When
    const response = await get('/markets/BTC-USD');

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      spread: '0.50000000',
      min: '84000.00000000',
      max: '84002.00000000',
      volume: '252003.00000000',
      asOf: '2026-10-28T11:00:02.000Z',
    });
  });

  test('Should leave out the trades outside the period asked', async () => {
    // Given
    await seedTrades(3);

    // When
    const response = await get('/markets/BTC-USD?startDate=2026-10-28T11:00:01Z&endDate=2026-10-28T11:00:02Z');

    // Then
    expect(response.json()).toMatchObject({ min: '84001.00000000', max: '84001.00000000', volume: '84001.00000000' });
  });
});
