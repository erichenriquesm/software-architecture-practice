import { InvalidAccountDataError } from './errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export class AccountId {
  private constructor(readonly value: string) {}

  static from(value: string): AccountId {
    if (!uuid.test(value)) throw new InvalidAccountDataError('accountId', 'must be a uuid');
    return new AccountId(value.toLowerCase());
  }
}

export class FullName {
  private constructor(readonly value: string) {}

  static from(value: string): FullName {
    const parts = value.trim().split(/\s+/).filter((part) => part.length > 0);
    if (parts.length < 2) throw new InvalidAccountDataError('name', 'must have a first name and a surname');
    return new FullName(parts.join(' '));
  }
}

export class Email {
  private constructor(readonly value: string) {}

  static from(value: string): Email {
    const normalized = value.trim().toLowerCase();
    if (!emailPattern.test(normalized)) throw new InvalidAccountDataError('email', 'must be a valid email');
    return new Email(normalized);
  }
}

const checkDigit = (digits: readonly number[], weightStart: number): number => {
  const sum = digits.reduce((total, digit, index) => total + digit * (weightStart - index), 0);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
};

export class Cpf {
  private constructor(readonly value: string) {}

  static from(value: string): Cpf {
    const digitsOnly = value.replace(/\D/g, '');
    if (digitsOnly.length !== 11 || /^(\d)\1{10}$/.test(digitsOnly)) throw new InvalidAccountDataError('document', 'must be a valid CPF');
    const digits = [...digitsOnly].map(Number);
    const first = checkDigit(digits.slice(0, 9), 10);
    const second = checkDigit(digits.slice(0, 10), 11);
    if (digits[9] !== first || digits[10] !== second) throw new InvalidAccountDataError('document', 'must be a valid CPF');
    return new Cpf(digitsOnly);
  }
}

export class Password {
  private constructor(readonly value: string) {}

  static from(value: string): Password {
    const strong = value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
    if (!strong) throw new InvalidAccountDataError('password', 'must have 8+ characters with lowercase, uppercase and a number');
    return new Password(value);
  }
}

export class PasswordHash {
  private constructor(readonly value: string) {}

  static from(value: string): PasswordHash {
    if (!value.startsWith('$argon2id$')) throw new InvalidAccountDataError('passwordHash', 'must be an argon2id hash');
    return new PasswordHash(value);
  }
}
