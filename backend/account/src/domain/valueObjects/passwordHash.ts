import { InvalidAccountDataError } from '../errors.js';

export class PasswordHash {
  private constructor(readonly value: string) {}

  static from(value: string): PasswordHash {
    if (!value.startsWith('$argon2id$')) throw new InvalidAccountDataError('passwordHash', 'must be an argon2id hash');
    return new PasswordHash(value);
  }
}
