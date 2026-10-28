import { describe, expect, test } from 'vitest';
import { InvalidQueryError, MarketNotFoundError } from '../../../../src/application/errors.js';
import { GetDepth } from '../../../../src/application/usecases/getDepth.js';
import { GetMarket } from '../../../../src/application/usecases/getMarket.js';
import { GetTrades } from '../../../../src/application/usecases/getTrades.js';
import { FakeDepthDao } from '../../../fakes/fakeDepthDao.js';
import { FakeMarketCatalog } from '../../../fakes/fakeMarketCatalog.js';
import type { FakeMarketStats } from '../../../fakes/fakeMarketStatsDao.js';
import { FakeMarketStatsDao } from '../../../fakes/fakeMarketStatsDao.js';
import { FakeTradeDao } from '../../../fakes/fakeTradeDao.js';
import { fixedClock } from '../../../fakes/fixedSystem.js';

const catalog = new FakeMarketCatalog();
const now = new Date('2026-10-28T12:00:30.000Z');

describe('Use case: GetDepth', () => {
  test('Should read the levels without aggregation (precision −2, the tick) when no precision is given', async () => {
    // Given
    const depthDao = new FakeDepthDao();

    // When
    const depth = await new GetDepth(depthDao, catalog).execute('BTC-USD');

    // Then
    expect(depthDao.calls).toEqual([{ marketId: 'BTC-USD', precision: -2 }]);
    expect(depth).toEqual({ buys: [], sells: [], sequence: 0, asOf: null });
  });

  test.each([-2, 0, 3, 5])('Should accept the precision %i of BTC-USD', async (precision) => {
    // Given
    const depthDao = new FakeDepthDao();

    // When
    await new GetDepth(depthDao, catalog).execute('BTC-USD', precision);

    // Then
    expect(depthDao.calls).toEqual([{ marketId: 'BTC-USD', precision }]);
  });

  test.each([-3, 6, 1.5])('Should refuse the precision %d, outside what the market supports', async (precision) => {
    // When & Then
    await expect(new GetDepth(new FakeDepthDao(), catalog).execute('BTC-USD', precision)).rejects.toBeInstanceOf(InvalidQueryError);
  });

  test('Should refuse a market the catalog does not have', async () => {
    // When & Then
    await expect(new GetDepth(new FakeDepthDao(), catalog).execute('ETH-USD')).rejects.toBeInstanceOf(MarketNotFoundError);
  });
});

describe('Use case: GetTrades', () => {
  test('Should ask the 50 most recent trades by default', async () => {
    // Given
    const tradeDao = new FakeTradeDao();

    // When
    await new GetTrades(tradeDao, catalog).execute({ marketId: 'BTC-USD' });

    // Then
    expect(tradeDao.calls).toEqual([{ marketId: 'BTC-USD', limit: 50, before: undefined }]);
  });

  test('Should page with the before instant', async () => {
    // Given
    const tradeDao = new FakeTradeDao();

    // When
    await new GetTrades(tradeDao, catalog).execute({ marketId: 'BTC-USD', limit: 500, before: '2026-10-28T10:00:00.000Z' });

    // Then
    expect(tradeDao.calls).toEqual([{ marketId: 'BTC-USD', limit: 500, before: new Date('2026-10-28T10:00:00.000Z') }]);
  });

  test.each([
    ['a limit of zero', { limit: 0 }],
    ['a limit above 500', { limit: 501 }],
    ['a fractional limit', { limit: 2.5 }],
    ['a before that is not a date', { before: 'last week' }],
  ])('Should refuse %s', async (_case, query) => {
    // When & Then
    await expect(new GetTrades(new FakeTradeDao(), catalog).execute({ marketId: 'BTC-USD', ...query })).rejects.toBeInstanceOf(InvalidQueryError);
  });

  test('Should refuse an unknown market', async () => {
    // When & Then
    await expect(new GetTrades(new FakeTradeDao(), catalog).execute({ marketId: 'ETH-USD' })).rejects.toBeInstanceOf(MarketNotFoundError);
  });
});

describe('Use case: GetMarket', () => {
  const getMarket = (stats: FakeMarketStats = {}) => {
    const marketStatsDao = new FakeMarketStatsDao(stats);
    return { marketStatsDao, getMarket: new GetMarket(marketStatsDao, catalog, fixedClock(now)) };
  };

  test('Should cover the rolling 24 h: candles for whole minutes, trades for the partial ones at the edges', async () => {
    // Given
    const { marketStatsDao, getMarket: useCase } = getMarket();

    // When
    await useCase.execute({ marketId: 'BTC-USD' });

    // Then
    expect(marketStatsDao.ranges).toEqual([
      { source: 'trades', from: '2026-10-27T12:00:30.000Z', to: '2026-10-27T12:01:00.000Z' },
      { source: 'candles', from: '2026-10-27T12:01:00.000Z', to: '2026-10-28T12:00:00.000Z' },
      { source: 'trades', from: '2026-10-28T12:00:00.000Z', to: '2026-10-28T12:00:30.000Z' },
    ]);
  });

  test('Should combine the pieces, take the spread from the top of the book and answer the latest update as asOf', async () => {
    // Given
    const { getMarket: useCase } = getMarket({
      candles: { min: '84000', max: '85000', volume: '1000' },
      trades: { min: '83900', max: '84500', volume: '10.5' },
      topOfBook: { bestBid: '84100', bestAsk: '84100.25', updatedAt: new Date('2026-10-28T11:59:00Z') },
      lastTradeAt: new Date('2026-10-28T12:00:10Z'),
    });

    // When
    const market = await useCase.execute({ marketId: 'BTC-USD', startDate: '2026-10-28T10:00:15Z', endDate: '2026-10-28T10:05:40Z' });

    // Then
    expect(market).toEqual({
      spread: '0.25000000',
      min: '83900.00000000',
      max: '85000.00000000',
      volume: '1021.00000000',
      asOf: '2026-10-28T12:00:10.000Z',
    });
  });

  test('Should answer an empty market: no spread, no min or max, zero volume and no asOf', async () => {
    // When
    const market = await getMarket().getMarket.execute({ marketId: 'BTC-USD' });

    // Then
    expect(market).toEqual({ spread: null, min: null, max: null, volume: '0.00000000', asOf: null });
  });

  test('Should refuse an unknown market and an inverted period', async () => {
    // When & Then
    await expect(getMarket().getMarket.execute({ marketId: 'ETH-USD' })).rejects.toBeInstanceOf(MarketNotFoundError);
    await expect(
      getMarket().getMarket.execute({ marketId: 'BTC-USD', startDate: '2026-10-28T11:00:00Z', endDate: '2026-10-28T10:00:00Z' }),
    ).rejects.toBeInstanceOf(InvalidQueryError);
  });
});
