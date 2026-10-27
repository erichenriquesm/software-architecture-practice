import { describe, expect, test } from 'vitest';
import { ContractViolationError } from '../../../../platform/messaging/schemas.js';
import { BalancesFallbackChain } from './balancesFallbackChain.js';
import { translateWalletBalances } from './walletAcl.js';

const usd = { assetId: 'USD', available: '10.00000000', reserved: '0.00000000' };
const failing = { balancesOf: async () => Promise.reject(new Error('wallet down')) };

describe('BalancesFallbackChain', () => {
  test('Should answer from the projection when it has balances', async () => {
    // Given
    const chain = new BalancesFallbackChain({ listByAccount: async () => [usd] }, failing);

    // When & Then
    await expect(chain.of('a-1')).resolves.toEqual({ status: 'ok', balances: [usd] });
  });

  test('Should ask the wallet when the projection is still empty', async () => {
    // Given
    const chain = new BalancesFallbackChain({ listByAccount: async () => [] }, { balancesOf: async () => [usd] });

    // When & Then
    await expect(chain.of('a-1')).resolves.toEqual({ status: 'live', balances: [usd] });
  });

  test('Should degrade without failing when the projection is empty and the wallet is down', async () => {
    // Given
    const degraded: string[] = [];
    const chain = new BalancesFallbackChain({ listByAccount: async () => [] }, failing, (accountId) => degraded.push(accountId));

    // When & Then
    await expect(chain.of('a-1')).resolves.toEqual({ status: 'unavailable', balances: [] });
    expect(degraded).toEqual(['a-1']);
  });

  test('Should fall through to the wallet when the projection itself fails', async () => {
    // Given
    const chain = new BalancesFallbackChain({ listByAccount: async () => Promise.reject(new Error('db down')) }, { balancesOf: async () => [usd] });

    // When & Then
    await expect(chain.of('a-1')).resolves.toMatchObject({ status: 'live' });
  });
});

describe('Wallet ACL', () => {
  test('Should translate wallet balances into account asset balances', () => {
    expect(translateWalletBalances({ balances: [{ assetId: 'BTC', available: '0.5', reserved: '0.1' }] })).toEqual([
      { assetId: 'BTC', available: '0.5', reserved: '0.1' },
    ]);
  });

  test.each([
    ['a negative amount', { assetId: 'BTC', available: '-1', reserved: '0' }],
    ['too many decimals', { assetId: 'BTC', available: '0.123456789', reserved: '0' }],
    ['a lowercase asset', { assetId: 'btc', available: '1', reserved: '0' }],
    ['a missing field', { assetId: 'BTC', available: '1' }],
  ])('Should reject a response with %s', (_case, balance) => {
    expect(() => translateWalletBalances({ balances: [balance] })).toThrowError(ContractViolationError);
  });
});
