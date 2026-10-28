import { InvalidAccountDataError } from '../errors.js';

export class FullName {
  private constructor(readonly value: string) {}

  static from(value: string): FullName {
    const parts = value.trim().split(/\s+/).filter((part) => part.length > 0);
    if (parts.length < 2) throw new InvalidAccountDataError('name', 'must have a first name and a surname');
    return new FullName(parts.join(' '));
  }
}
