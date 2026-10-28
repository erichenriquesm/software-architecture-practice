import { InvalidAccountDataError } from '../errors.js';

export class Password {
  private constructor(readonly value: string) {}

  static from(value: string): Password {
    const strong = value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
    if (!strong) throw new InvalidAccountDataError('password', 'must have 8+ characters with lowercase, uppercase and a number');
    return new Password(value);
  }
}
