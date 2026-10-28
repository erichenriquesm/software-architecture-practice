import { describe, expect, test } from 'vitest';
import { Account } from '../../../../src/domain/entities/account.js';
import { InvalidAccountDataError } from '../../../../src/domain/errors.js';
import { AccountId } from '../../../../src/domain/valueObjects/accountId.js';
import { Cpf } from '../../../../src/domain/valueObjects/cpf.js';
import { Email } from '../../../../src/domain/valueObjects/email.js';
import { FullName } from '../../../../src/domain/valueObjects/fullName.js';
import { Password } from '../../../../src/domain/valueObjects/password.js';
import { PasswordHash } from '../../../../src/domain/valueObjects/passwordHash.js';

const validCpf = '529.982.247-25';
const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

describe('FullName', () => {
  test('Should accept a first name and a surname, collapsing extra spaces', () => {
    expect(FullName.from('  Ana   Souza ').value).toBe('Ana Souza');
  });

  test.each(['Ana', '   ', ''])('Should reject %j', (value) => {
    expect(() => FullName.from(value)).toThrowError(InvalidAccountDataError);
  });
});

describe('Email', () => {
  test('Should normalize to lowercase', () => {
    expect(Email.from(' Ana.Souza@Example.COM ').value).toBe('ana.souza@example.com');
  });

  test.each(['ana', 'ana@', 'ana@example', '@example.com'])('Should reject %j', (value) => {
    expect(() => Email.from(value)).toThrowError(InvalidAccountDataError);
  });
});

describe('Cpf', () => {
  test('Should accept a valid CPF with or without punctuation and keep only digits', () => {
    expect(Cpf.from(validCpf).value).toBe('52998224725');
    expect(Cpf.from('52998224725').value).toBe('52998224725');
  });

  test.each(['529.982.247-24', '111.111.111-11', '000.000.000-00', '123', '5299822472512'])('Should reject %j', (value) => {
    expect(() => Cpf.from(value)).toThrowError(InvalidAccountDataError);
  });
});

describe('Password', () => {
  test('Should accept 8+ characters with lowercase, uppercase and a number', () => {
    expect(Password.from('Abcdefg1').value).toBe('Abcdefg1');
  });

  test.each([
    ['too short', 'Abcde1'],
    ['no uppercase', 'abcdefg1'],
    ['no lowercase', 'ABCDEFG1'],
    ['no number', 'Abcdefgh'],
  ])('Should reject a password with %s', (_rule, value) => {
    expect(() => Password.from(value)).toThrowError(InvalidAccountDataError);
  });
});

describe('PasswordHash', () => {
  test('Should only hold an argon2id hash', () => {
    expect(PasswordHash.from(hash).value).toBe(hash);
    expect(() => PasswordHash.from('plain-text')).toThrowError(InvalidAccountDataError);
  });
});

describe('Account', () => {
  test('Should record AccountCreated when signing up', () => {
    // Given
    const now = new Date('2026-10-27T12:00:00Z');
    const id = AccountId.from('0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69');

    // When
    const account = Account.signUp({
      id,
      name: FullName.from('Ana Souza'),
      email: Email.from('ana@example.com'),
      document: Cpf.from(validCpf),
      passwordHash: PasswordHash.from(hash),
      now,
    });

    // Then
    expect(account.pullEvents()).toEqual([{ type: 'AccountCreated', accountId: id.value, occurredAt: now }]);
    expect(account.pullEvents()).toEqual([]);
  });
});
