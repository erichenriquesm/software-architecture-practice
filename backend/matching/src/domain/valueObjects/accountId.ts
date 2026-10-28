import { InvalidBookDataError } from '../errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AccountId {
  private constructor(readonly value: string) {}

  static from(value: string): AccountId {
    if (!uuid.test(value)) throw new InvalidBookDataError('accountId', 'must be a uuid');
    return new AccountId(value.toLowerCase());
  }
}
