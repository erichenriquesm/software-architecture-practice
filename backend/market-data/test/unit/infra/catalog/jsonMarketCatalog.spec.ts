import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { JsonMarketCatalog } from '../../../../src/infra/catalog/jsonMarketCatalog.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

describe('JsonMarketCatalog', () => {
  test('Should read the depth precisions of BTC-USD from markets.json', () => {
    // When
    const catalog = JsonMarketCatalog.load();

    // Then
    expect(catalog.depthPrecisionOf('BTC-USD')).toEqual({ min: -2, max: 5 });
    expect(catalog.depthPrecisionOf('ETH-USD')).toBeUndefined();
  });

  test('Should refuse to start with a catalog that breaks its schema', () => {
    // Given
    const file = join(mkdtempSync(join(tmpdir(), 'catalog-')), 'markets.json');
    writeFileSync(file, JSON.stringify({ version: 1, assets: [], markets: [] }));

    // When & Then
    expect(() => JsonMarketCatalog.load(file)).toThrowError(ContractViolationError);
  });
});
