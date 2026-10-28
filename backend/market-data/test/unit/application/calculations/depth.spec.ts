import { describe, expect, test } from 'vitest';
import { aggregateDepth } from '../../../../src/application/calculations/aggregateDepth.js';
import { priceBucket } from '../../../../src/application/calculations/priceBucket.js';
import { spread } from '../../../../src/application/calculations/spread.js';

describe('priceBucket', () => {
  test.each([
    ['84500', 3, '84000.00000000'],
    ['84600', 3, '84000.00000000'],
    ['84700', 3, '84000.00000000'],
    ['84999.99', 3, '84000.00000000'],
    ['85000', 3, '85000.00000000'],
    ['84567.89', 0, '84567.00000000'],
    ['84567.89', -1, '84567.80000000'],
    ['84567.89', -2, '84567.89000000'],
    ['84567.89', 5, '0.00000000'],
    ['184567.89', 5, '100000.00000000'],
  ])('Should put %s at precision %i in the bucket %s', (price, precision, bucket) => {
    // When & Then
    expect(priceBucket(price, precision)).toBe(bucket);
  });
});

describe('aggregateDepth', () => {
  test('Should sum two orders of 10 at 84500 into one level of 20 (objective example)', () => {
    // Given
    const asks = [
      { price: '84500', quantity: '10' },
      { price: '84500', quantity: '10' },
    ];

    // When
    const levels = aggregateDepth(asks, -2, 'sell');

    // Then
    expect(levels).toEqual([{ quantity: '20.00000000', price: '84500.00000000' }]);
  });

  test('Should group 4 units at 84500, 84600 and 84700 into 12 units at 84000 with precision 3 (objective example)', () => {
    // Given
    const bids = [
      { price: '84500', quantity: '4' },
      { price: '84600', quantity: '4' },
      { price: '84700', quantity: '4' },
    ];

    // When
    const levels = aggregateDepth(bids, 3, 'buy');

    // Then
    expect(levels).toEqual([{ quantity: '12.00000000', price: '84000.00000000' }]);
  });

  test('Should list buys from the highest price and sells from the lowest', () => {
    // Given
    const levels = [
      { price: '100.5', quantity: '1' },
      { price: '102', quantity: '2' },
      { price: '101', quantity: '0.00000001' },
    ];

    // When
    const buys = aggregateDepth(levels, -2, 'buy').map((level) => level.price);
    const sells = aggregateDepth(levels, -2, 'sell').map((level) => level.price);

    // Then
    expect(buys).toEqual(['102.00000000', '101.00000000', '100.50000000']);
    expect(sells).toEqual(['100.50000000', '101.00000000', '102.00000000']);
  });

  test('Should answer no levels for an empty side', () => {
    // When & Then
    expect(aggregateDepth([], 0, 'buy')).toEqual([]);
  });
});

describe('spread', () => {
  test('Should be the best ask minus the best bid', () => {
    // When & Then
    expect(spread('84000.50', '84001')).toBe('0.50000000');
  });

  test.each([
    ['no bids', null, '84001'],
    ['no asks', '84000', null],
  ])('Should be null with %s', (_case, bestBid, bestAsk) => {
    // When & Then
    expect(spread(bestBid, bestAsk)).toBeNull();
  });
});
