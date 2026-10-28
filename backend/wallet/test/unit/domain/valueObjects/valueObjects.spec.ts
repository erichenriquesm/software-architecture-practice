import { describe, expect, test } from 'vitest';
import { InvalidWalletDataError } from '../../../../src/domain/errors.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { Price } from '../../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../../src/domain/valueObjects/side.js';

describe('Quantity', () => {
  test('Should keep exact decimals with 8 places', () => {
    // When & Then
    expect(Quantity.from('0.1').plus(Quantity.from('0.2')).toString()).toBe('0.30000000');
    expect(Quantity.from('0.00001').times(Price.from('0.01')).toString()).toBe('0.00000010');
  });

  test.each(['-1', 'abc', '1e5', '0.000000001', ''])('Should reject %j', (value) => {
    // When & Then
    expect(() => Quantity.from(value)).toThrowError(InvalidWalletDataError);
  });

  test('Should never become negative', () => {
    // When & Then
    expect(() => Quantity.from('1').minus(Quantity.from('2'))).toThrowError(InvalidWalletDataError);
  });

  test('Should tell whether it fits an asset precision', () => {
    // When & Then
    expect(Quantity.from('1.25').fitsPrecision(2)).toBe(true);
    expect(Quantity.from('1.255').fitsPrecision(2)).toBe(false);
  });
});

describe('Price, Side and MarketId', () => {
  test.each(['0', '-1', '1.123456789'])('Should reject the price %j', (value) => {
    // When & Then
    expect(() => Price.from(value)).toThrowError(InvalidWalletDataError);
  });

  test('Should accept only buy and sell', () => {
    // When & Then
    expect(Side.from('buy').isBuy()).toBe(true);
    expect(() => Side.from('hold')).toThrowError(InvalidWalletDataError);
  });

  test('Should split BASE-QUOTE into the traded and the paying asset', () => {
    // When
    const market = MarketId.from('BTC-USD');

    // Then
    expect([market.base.value, market.quote.value]).toEqual(['BTC', 'USD']);
    expect(() => MarketId.from('BTCUSD')).toThrowError(InvalidWalletDataError);
  });
});
