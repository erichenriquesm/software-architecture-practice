import { describe, expect, test } from 'vitest';
import type { Account } from '../../domain/account.js';
import type { DomainEvent } from '../../domain/aggregateRoot.js';
import { AccountNotFoundError, DuplicateEmailError, InvalidAccountDataError } from '../../domain/errors.js';
import type { Email, Password } from '../../domain/valueObjects.js';
import { PasswordHash } from '../../domain/valueObjects.js';
import type {
  AccountBalances,
  AccountBalancesResult,
  AccountDao,
  AccountRepository,
  AccountView,
  PasswordHasher,
} from '../ports/accountPorts.js';
import type { DomainEventDispatcher } from '../ports/domainEventDispatcher.js';
import type { TransactionRunner } from '../ports/transactionRunner.js';
import { GetAccount } from './getAccount/getAccount.js';
import { Signup } from './signup/signup.js';

class FakeAccountRepository implements AccountRepository {
  readonly saved: Account[] = [];
  constructor(private readonly takenEmails: readonly string[] = []) {}

  async existsByEmail(email: Email): Promise<boolean> {
    return this.takenEmails.includes(email.value);
  }

  async save(account: Account): Promise<void> {
    this.saved.push(account);
  }
}

class FakePasswordHasher implements PasswordHasher {
  async hash(password: Password): Promise<PasswordHash> {
    return PasswordHash.from(`$argon2id$fake$${password.value.length}`);
  }
}

class RecordingTransactionRunner implements TransactionRunner {
  runs = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return work();
  }
}

class RecordingDispatcher implements DomainEventDispatcher {
  readonly dispatched: DomainEvent[] = [];
  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    this.dispatched.push(...events);
  }
}

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const fixedNow = new Date('2026-10-27T12:00:00Z');
const signupInput = { name: 'Ana Souza', email: 'Ana@Example.com', document: '529.982.247-25', password: 'Abcdefg1' };

const buildSignup = (takenEmails: readonly string[] = []) => {
  const repository = new FakeAccountRepository(takenEmails);
  const transactionRunner = new RecordingTransactionRunner();
  const dispatcher = new RecordingDispatcher();
  const signup = new Signup(
    repository,
    new FakePasswordHasher(),
    transactionRunner,
    dispatcher,
    { next: () => accountId },
    { now: () => fixedNow },
  );
  return { signup, repository, transactionRunner, dispatcher };
};

describe('Use case: Signup', () => {
  test('Should create the account, hash the password and dispatch AccountCreated in one transaction', async () => {
    // Given
    const { signup, repository, transactionRunner, dispatcher } = buildSignup();

    // When
    const signupOutput = await signup.execute(signupInput);

    // Then
    expect(signupOutput).toEqual({ accountId });
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.email.value).toBe('ana@example.com');
    expect(repository.saved[0]?.passwordHash.value).not.toContain('Abcdefg1');
    expect(transactionRunner.runs).toBe(1);
    expect(dispatcher.dispatched).toEqual([{ type: 'AccountCreated', accountId, occurredAt: fixedNow }]);
  });

  test('Should refuse an email that is already registered', async () => {
    // Given
    const { signup, repository, dispatcher } = buildSignup(['ana@example.com']);

    // When & Then
    await expect(signup.execute(signupInput)).rejects.toBeInstanceOf(DuplicateEmailError);
    expect(repository.saved).toHaveLength(0);
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  test.each([
    ['name', { name: 'Ana' }],
    ['email', { email: 'ana' }],
    ['document', { document: '111.111.111-11' }],
    ['password', { password: 'weak' }],
  ])('Should reject invalid %s before touching anything', async (field, change) => {
    // Given
    const { signup, repository } = buildSignup();

    // When & Then
    await expect(signup.execute({ ...signupInput, ...change })).rejects.toMatchObject({ field });
    await expect(signup.execute({ ...signupInput, ...change })).rejects.toBeInstanceOf(InvalidAccountDataError);
    expect(repository.saved).toHaveLength(0);
  });
});

const accountView: AccountView = { accountId, name: 'Ana Souza', email: 'ana@example.com', document: '52998224725' };

class FakeAccountDao implements AccountDao {
  constructor(private readonly account?: AccountView) {}
  async findById(id: string): Promise<AccountView | undefined> {
    return this.account?.accountId === id ? this.account : undefined;
  }
  async exists(id: string): Promise<boolean> {
    return this.account?.accountId === id;
  }
}

const balancesReturning = (result: AccountBalancesResult): AccountBalances => ({ of: async () => result });

describe('Use case: GetAccount', () => {
  test('Should return the account with quantity = available + reserved and the balances status', async () => {
    // Given
    const getAccount = new GetAccount(
      new FakeAccountDao(accountView),
      balancesReturning({ status: 'ok', balances: [{ assetId: 'USD', available: '100.5', reserved: '20.25' }] }),
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
    const getAccount = new GetAccount(new FakeAccountDao(accountView), balancesReturning({ status: 'unavailable', balances: [] }));

    // When
    const getAccountOutput = await getAccount.execute({ accountId });

    // Then
    expect(getAccountOutput.assets).toEqual([]);
    expect(getAccountOutput.balancesStatus).toBe('unavailable');
  });

  test('Should fail with AccountNotFoundError for an unknown account', async () => {
    // Given
    const getAccount = new GetAccount(new FakeAccountDao(), balancesReturning({ status: 'ok', balances: [] }));

    // When & Then
    await expect(getAccount.execute({ accountId })).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
