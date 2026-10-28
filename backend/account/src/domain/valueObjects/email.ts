import { InvalidAccountDataError } from '../errors.js';

const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export class Email {
  private constructor(readonly value: string) {}

  static from(value: string): Email {
    const normalized = value.trim().toLowerCase();
    if (!emailPattern.test(normalized)) throw new InvalidAccountDataError('email', 'must be a valid email');
    return new Email(normalized);
  }
}
