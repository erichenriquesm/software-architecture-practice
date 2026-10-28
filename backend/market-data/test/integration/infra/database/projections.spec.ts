import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { combineStats } from '../../../../src/application/calculations/combineStats.js';
import type { MarketDataCore } from '../../../../src/infra/composition.js';
import { buildMarketDataCore } from '../../../../src/infra/composition.js';
import type { BookSnapshot } from '../../../../src/infra/database/bookProjector.js';
import { KyselyMarketStatsDao } from '../../../../src/infra/database/kyselyMarketStatsDao.js';
import type { ExecutedTrade } from '../../../../src/infra/database/tradeProjector.js';
import { projectTrade } from '../../../../src/infra/database/tradeProjector.js';
import { fixedClock } from '../../../fakes/fixedSystem.js';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import { snapshotFixture, tradeFixture } from '../../../support/fixtures.js';

let database: TestDatabase;
let core: MarketDataCore;

beforeAll(async () => {
  database = await createTestDatabase();
  core = buildMarketDataCore({ db: database.db, clock: fixedClock(new Date('2026-10-28T12:00:00.000Z')) });
});

beforeEach(async () => {
  await sql`truncate table trade_view, candle_1m_view, book_state_view, depth_view, inbox`.execute(database.db);
});

afterAll(() => database.destroy());

const applySnapshot = (snapshot: BookSnapshot, occurredAt = new Date('2026-10-28T10:00:00.000Z')) =>
  database.db.transaction().execute((trx) => core.bookProjector.project(trx, snapshot, occurredAt));

const applyTrade = (trade: ExecutedTrade) => database.db.transaction().execute((trx) => projectTrade(trx, trade));

const candles = () => database.db.selectFrom('candle_1m_view').selectAll().orderBy('bucket_start').execute();

describe('Book projection (book_state_view + depth_view)', () => {
  test('Should pre-aggregate the levels for every precision of the market, from −2 to 5', async () => {
    // Given
    const snapshot = snapshotFixture({
      bids: [
        { price: '84500', quantity: '4' },
        { price: '84600', quantity: '4' },
        { price: '84700', quantity: '4' },
      ],
      asks: [{ price: '84800.25', quantity: '1.5' }],
    });

    // When
    await applySnapshot(snapshot);

    // Then
    const precisions = await database.db.selectFrom('depth_view').select('precision').distinct().orderBy('precision').execute();
    expect(precisions.map((row) => row.precision)).toEqual([-2, -1, 0, 1, 2, 3, 4, 5]);
    const raw = await core.getDepth.execute('BTC-USD');
    expect(raw.buys.map((level) => level.price)).toEqual(['84700.00000000', '84600.00000000', '84500.00000000']);
    expect(await core.getDepth.execute('BTC-USD', 3)).toEqual({
      buys: [{ quantity: '12.00000000', price: '84000.00000000' }],
      sells: [{ quantity: '1.50000000', price: '84000.00000000' }],
      sequence: 1,
      asOf: '2026-10-28T10:00:00.000Z',
    });
  });

  test('Should ignore a snapshot older than the one already applied (last-write-wins by sequence)', async () => {
    // Given
    await applySnapshot(snapshotFixture({ sequence: 5, bids: [{ price: '100', quantity: '5' }] }), new Date('2026-10-28T10:00:05Z'));

    // When
    const applied = await applySnapshot(snapshotFixture({ sequence: 4, bids: [{ price: '90', quantity: '4' }] }), new Date('2026-10-28T10:00:04Z'));
    const repeated = await applySnapshot(snapshotFixture({ sequence: 5, bids: [{ price: '90', quantity: '4' }] }));

    // Then
    expect([applied, repeated]).toEqual([false, false]);
    const depth = await core.getDepth.execute('BTC-USD');
    expect(depth).toEqual({ buys: [{ quantity: '5.00000000', price: '100.00000000' }], sells: [], sequence: 5, asOf: '2026-10-28T10:00:05.000Z' });
  });

  test('Should rewrite the whole depth of a newer snapshot, levels that left the book included', async () => {
    // Given
    await applySnapshot(snapshotFixture({ sequence: 1, bids: [{ price: '100', quantity: '1' }], asks: [{ price: '101', quantity: '1' }] }));

    // When
    await applySnapshot(snapshotFixture({ sequence: 2, bids: [{ price: '99', quantity: '2' }], asks: [] }));

    // Then
    const rows = await database.db.selectFrom('depth_view').select(['side', 'price']).where('precision', '=', -2).execute();
    expect(rows).toEqual([{ side: 'buy', price: '99.00000000' }]);
    expect(await core.getMarket.execute({ marketId: 'BTC-USD' })).toMatchObject({ spread: null });
  });

  test('Should leave the previous depth untouched when writing a new one fails midway', async () => {
    // Given
    await applySnapshot(snapshotFixture({ sequence: 1, bids: [{ price: '100', quantity: '1' }] }));

    // When
    const failing = database.db.transaction().execute(async (trx) => {
      await core.bookProjector.project(trx, snapshotFixture({ sequence: 2, bids: [{ price: '50', quantity: '9' }] }), new Date());
      throw new Error('crash after writing the depth');
    });

    // Then
    await expect(failing).rejects.toThrowError('crash after writing the depth');
    const depth = await core.getDepth.execute('BTC-USD');
    expect([depth.sequence, depth.buys]).toEqual([1, [{ quantity: '1.00000000', price: '100.00000000' }]]);
  });

  test('Should keep the newest snapshot when two are applied at the same time', async () => {
    // Given
    const snapshots = [3, 1, 4, 2].map((sequence) => snapshotFixture({ sequence, bids: [{ price: String(100 + sequence), quantity: '1' }] }));

    // When
    await Promise.all(snapshots.map((snapshot) => applySnapshot(snapshot)));

    // Then
    const depth = await core.getDepth.execute('BTC-USD', 0);
    expect([depth.sequence, depth.buys]).toEqual([4, [{ quantity: '1.00000000', price: '104.00000000' }]]);
  });

  test('Should refuse a snapshot of a market outside the catalog', async () => {
    // When & Then
    await expect(applySnapshot({ marketId: 'ETH-USD', sequence: 1, bids: [], asks: [] })).rejects.toThrowError('ETH-USD');
  });
});

describe('Trade projection (trade_view + candle_1m_view)', () => {
  test('Should count a trade once, even when it comes again under another eventId (replay)', async () => {
    // Given
    const trade = tradeFixture({ quantity: '2', price: '100' });

    // When
    const first = await applyTrade(trade);
    const second = await applyTrade(trade);

    // Then
    expect([first, second]).toEqual([true, false]);
    const [candle] = await candles();
    expect([candle?.volume, candle?.trade_count]).toEqual(['200.00000000', 1]);
  });

  test('Should build the same candle whatever order the trades of the minute arrive in', async () => {
    // Given
    const trades = [
      tradeFixture({ tradeId: '00000000-0000-7000-8000-000000000001', price: '100', quantity: '1', executedAt: '2026-10-28T10:00:01.000Z' }),
      tradeFixture({ tradeId: '00000000-0000-7000-8000-000000000002', price: '105', quantity: '2', executedAt: '2026-10-28T10:00:30.000Z' }),
      tradeFixture({ tradeId: '00000000-0000-7000-8000-000000000003', price: '95', quantity: '0.5', executedAt: '2026-10-28T10:00:30.000Z' }),
      tradeFixture({ tradeId: '00000000-0000-7000-8000-000000000004', price: '101', quantity: '1', executedAt: '2026-10-28T10:00:59.999Z' }),
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
    ];

    // When
    const results = [];
    for (const order of orders) {
      await sql`truncate table trade_view, candle_1m_view`.execute(database.db);
      for (const index of order) await applyTrade(trades[index] as ExecutedTrade);
      results.push(await candles());
    }

    // Then
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toMatchObject([
      {
        bucket_start: new Date('2026-10-28T10:00:00.000Z'),
        open_price: '100.00000000',
        close_price: '101.00000000',
        min_price: '95.00000000',
        max_price: '105.00000000',
        volume: '458.50000000',
        trade_count: 4,
      },
    ]);
  });

  test('Should give GetMarket over a period that cuts minutes the same numbers as a direct scan of trade_view', async () => {
    // Given
    const times = ['09:59:50', '10:00:10', '10:00:59', '10:01:00', '10:02:30', '10:03:59', '10:04:00', '10:04:20', '10:04:45', '10:05:01'];
    for (const [index, time] of times.entries()) {
      await applyTrade(tradeFixture({ price: String(84_000 + index * 37.5), quantity: `0.${index + 1}`, executedAt: `2026-10-28T${time}.000Z` }));
    }
    const from = new Date('2026-10-28T10:00:10.000Z');
    const to = new Date('2026-10-28T10:04:45.000Z');

    // When
    const market = await core.getMarket.execute({ marketId: 'BTC-USD', startDate: from.toISOString(), endDate: to.toISOString() });

    // Then
    const direct = combineStats([await new KyselyMarketStatsDao(database.db).tradeStats('BTC-USD', from, to)]);
    expect({ min: market.min, max: market.max, volume: market.volume }).toEqual(direct);
    expect(direct).toEqual({ min: '84037.50000000', max: '84262.50000000', volume: '294630.00000000' });
  });
});
