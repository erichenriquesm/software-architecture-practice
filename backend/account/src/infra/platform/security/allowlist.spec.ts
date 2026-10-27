import { describe, expect, test } from 'vitest';
import { InvalidAllowlistError, serviceFromSan, validateAllowlist } from './allowlist.js';

describe('serviceFromSan', () => {
  test.each([
    ['DNS:wallet-api', 'wallet'],
    ['DNS:market-data-api', 'market-data'],
    ['DNS:localhost, DNS:account-api', 'account'],
  ])('Should read %j as %j', (subjectAltName, service) => {
    expect(serviceFromSan(subjectAltName)).toBe(service);
  });

  test.each([undefined, '', 'DNS:wallet', 'DNS:Wallet-api', 'IP Address:10.0.0.1'])(
    'Should not identify a service from %j',
    (subjectAltName) => {
      expect(serviceFromSan(subjectAltName)).toBeNull();
    },
  );
});

describe('validateAllowlist', () => {
  const served = ['/trading.account.v1.AccountService/Exists'];

  test('Should accept an allowlist for served methods', () => {
    const allowlist = { '/trading.account.v1.AccountService/Exists': ['wallet'] };

    expect(validateAllowlist(allowlist, served)).toBe(allowlist);
  });

  test('Should reject an entry for a method the server does not serve', () => {
    expect(() => validateAllowlist({ '/trading.account.v1.AccountService/Delete': ['wallet'] }, served)).toThrowError(
      InvalidAllowlistError,
    );
  });
});
