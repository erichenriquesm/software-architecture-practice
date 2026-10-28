import { describe, expect, test } from 'vitest';
import { FakeAccountDao } from '../../../test/fakes/fakeAccountDao.js';
import { InvalidAccountDataError } from '../../domain/errors.js';
import { AccountExists } from './accountExists.js';

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const accountExists = new AccountExists(new FakeAccountDao({ accountId, name: 'Ana Souza', email: 'ana@example.com', document: '52998224725' }));

describe('Use case: AccountExists', () => {
  test('Should say whether the account exists', async () => {
    // When & Then
    await expect(accountExists.execute({ accountId })).resolves.toEqual({ exists: true });
    await expect(accountExists.execute({ accountId: '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a70' })).resolves.toEqual({ exists: false });
  });

  test('Should reject an id that is not a uuid', async () => {
    // When & Then
    await expect(accountExists.execute({ accountId: 'abc' })).rejects.toBeInstanceOf(InvalidAccountDataError);
  });
});
