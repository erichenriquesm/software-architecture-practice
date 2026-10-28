import { InvalidBookDataError } from '../errors.js';

export class Side {
  private constructor(readonly value: 'buy' | 'sell') {}

  static from(value: string): Side {
    if (value !== 'buy' && value !== 'sell') throw new InvalidBookDataError('side', 'must be buy or sell');
    return new Side(value);
  }

  isBuy(): boolean {
    return this.value === 'buy';
  }
}
