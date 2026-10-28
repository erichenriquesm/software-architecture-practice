import { describe, expect, test } from 'vitest';
import { InvalidWalletDataError } from '../../../../src/domain/errors.js';
import { AssetId } from '../../../../src/domain/valueObjects/assetId.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { JsonMarketCatalog } from '../../../../src/infra/catalog/jsonMarketCatalog.js';

describe('JsonMarketCatalog', () => {
  test('Should read the asset precisions and active markets of markets.json', () => {
    // Given
    const catalog = JsonMarketCatalog.load();

    // When & Then
    expect(catalog.precisionOf(AssetId.from('BTC'))).toBe(8);
    expect(catalog.precisionOf(AssetId.from('USD'))).toBe(2);
    expect(() => catalog.ensureMarket(MarketId.from('BTC-USD'))).not.toThrow();
    expect(() => catalog.precisionOf(AssetId.from('ETH'))).toThrowError(InvalidWalletDataError);
    expect(() => catalog.ensureMarket(MarketId.from('ETH-USD'))).toThrowError(InvalidWalletDataError);
  });
});
