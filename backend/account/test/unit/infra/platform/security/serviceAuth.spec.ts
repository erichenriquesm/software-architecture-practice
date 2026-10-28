import grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import {
  authenticatedCaller,
  identify,
  InvalidServiceAuthConfigurationError,
  parseAllowedCallers,
  validateAllowlist,
} from '../../../../../src/infra/platform/security/serviceAuth.js';

describe('parseAllowedCallers', () => {
  test('Should read name:token pairs separated by commas', () => {
    // When
    const callers = parseAllowedCallers('wallet:wallet-grpc-dev, order:order-grpc-dev');

    // Then
    expect([...callers.entries()]).toEqual([
      ['wallet', 'wallet-grpc-dev'],
      ['order', 'order-grpc-dev'],
    ]);
  });

  test('Should accept an empty value as no callers', () => {
    // When & Then
    expect(parseAllowedCallers('').size).toBe(0);
  });

  test.each(['wallet', 'wallet:', ':token', 'wallet:a:b', 'Wallet:token'])('Should reject the malformed entry %j', (value) => {
    // When & Then
    expect(() => parseAllowedCallers(value)).toThrowError(InvalidServiceAuthConfigurationError);
  });
});

describe('authenticatedCaller', () => {
  const callers = parseAllowedCallers('wallet:wallet-grpc-dev');
  const metadataOf = (name: string, token: string) => identify(new grpc.Metadata(), { name, token });

  test('Should identify a known caller with the right token', () => {
    // When & Then
    expect(authenticatedCaller(callers, metadataOf('wallet', 'wallet-grpc-dev'))).toBe('wallet');
  });

  test.each([
    ['wrong token', 'wallet', 'other-token'],
    ['unknown caller', 'order', 'wallet-grpc-dev'],
    ['no headers', '', ''],
  ])('Should not identify a caller with %s', (_case, name, token) => {
    // When & Then
    expect(authenticatedCaller(callers, metadataOf(name, token))).toBeNull();
  });
});

describe('validateAllowlist', () => {
  const served = ['/trading.account.v1.AccountService/Exists'];

  test('Should accept an allowlist for served methods', () => {
    // Given
    const allowlist = { '/trading.account.v1.AccountService/Exists': ['wallet'] };

    // When & Then
    expect(validateAllowlist(allowlist, served)).toBe(allowlist);
  });

  test('Should reject an entry for a method the server does not serve', () => {
    // When & Then
    expect(() => validateAllowlist({ '/trading.account.v1.AccountService/Delete': ['wallet'] }, served)).toThrowError(
      InvalidServiceAuthConfigurationError,
    );
  });
});
