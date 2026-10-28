import { describe, expect, test } from 'vitest';
import { InvalidOrderDataError } from '../../../../src/domain/errors.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { Price } from '../../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../../src/domain/valueObjects/quantity.js';
import { JsonMarketCatalog } from '../../../../src/infra/catalog/jsonMarketCatalog.js';

describe('JsonMarketCatalog', () => {
  test('Should read the BTC-USD filters of markets.json and refuse an unknown market', () => {
    // Given
    const filters = JsonMarketCatalog.load().filtersOf(MarketId.from('BTC-USD'));

    // When & Then
    expect(() => filters.validate(Quantity.from('0.001'), Price.from('83000.01'))).not.toThrow();
    expect(() => filters.validate(Quantity.from('0.001'), Price.from('1'))).toThrowError(InvalidOrderDataError);
    expect(() => JsonMarketCatalog.load().filtersOf(MarketId.from('ETH-USD'))).toThrowError(InvalidOrderDataError);
  });
});
