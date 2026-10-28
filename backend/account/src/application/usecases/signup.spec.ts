import { describe, expect, test } from 'vitest';
import { FakeAccountRepository } from '../../../test/fakes/fakeAccountRepository.js';
import { FakePasswordHasher } from '../../../test/fakes/fakePasswordHasher.js';
import { fixedClock, fixedIds } from '../../../test/fakes/fixedSystem.js';
import { RecordingDomainEventDispatcher } from '../../../test/fakes/recordingDomainEventDispatcher.js';
import { RecordingTransactionRunner } from '../../../test/fakes/recordingTransactionRunner.js';
import { DuplicateEmailError, InvalidAccountDataError } from '../../domain/errors.js';
import { Signup } from './signup.js';

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const fixedNow = new Date('2026-10-27T12:00:00Z');
const signupInput = { name: 'Ana Souza', email: 'Ana@Example.com', document: '529.982.247-25', password: 'Abcdefg1' };

const buildSignup = (takenEmails: readonly string[] = []) => {
  const repository = new FakeAccountRepository(takenEmails);
  const transactionRunner = new RecordingTransactionRunner();
  const dispatcher = new RecordingDomainEventDispatcher();
  const signup = new Signup(repository, new FakePasswordHasher(), transactionRunner, dispatcher, fixedIds(accountId), fixedClock(fixedNow));
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
