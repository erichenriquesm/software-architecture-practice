import { describe, expect, test } from 'vitest';
import { InvalidServiceNameError, ServiceName } from './serviceName.js';

describe('ServiceName', () => {
  test('Should accept a kebab-case name', () => {
    // Given
    const value = 'market-data';

    // When
    const serviceName = ServiceName.from(value);

    // Then
    expect(serviceName.value).toBe('market-data');
  });

  test.each(['Wallet', 'market_data', '-wallet', 'wallet-', ''])('Should reject %j', (value) => {
    // When & Then
    expect(() => ServiceName.from(value)).toThrowError(InvalidServiceNameError);
  });
});
