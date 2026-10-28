import { describe, expect, test } from 'vitest';
import { accountBalancesReturning } from '../../../test/fakes/fakeAccountBalances.js';
import { FakeAccountDao } from '../../../test/fakes/fakeAccountDao.js';
import { AccountNotFoundError } from '../../domain/errors.js';
import type { AccountView } from '../dtos/accountView.js';
import { GetAccount } from './getAccount.js';

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const accountView: AccountView = { accountId, name: 'Ana Souza', email: 'ana@example.com', document: '52998224725' };

describe('Use case: GetAccount', () => {
  test('Should return the account with quantity = available + reserved and the balances status', async () => {
    // Given
    const getAccount = new GetAccount(
      new FakeAccountDao(accountView),
      accountBalancesReturning({ status: 'ok', balances: [{ assetId: 'USD', available: '100.5', reserved: '20.25' }] }),
    );

    // When
    const getAccountOutput = await getAccount.execute({ accountId });

    // Then
    expect(getAccountOutput).toEqual({
      ...accountView,
      assets: [{ assetId: 'USD', quantity: '120.75000000', available: '100.50000000', reserved: '20.25000000' }],
      balancesStatus: 'ok',
    });
  });

  test('Should still answer with an empty asset list when balances are unavailable', async () => {
    // Given
    const getAccount = new GetAccount(new FakeAccountDao(accountView), accountBalancesReturning({ status: 'unavailable', balances: [] }));

    // When
    const getAccountOutput = await getAccount.execute({ accountId });

    // Then
    expect(getAccountOutput.assets).toEqual([]);
    expect(getAccountOutput.balancesStatus).toBe('unavailable');
  });

  test('Should fail with AccountNotFoundError for an unknown account', async () => {
    // Given
    const getAccount = new GetAccount(new FakeAccountDao(), accountBalancesReturning({ status: 'ok', balances: [] }));

    // When & Then
    await expect(getAccount.execute({ accountId })).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
