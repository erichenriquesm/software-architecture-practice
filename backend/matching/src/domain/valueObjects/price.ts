import { Decimal } from 'decimal.js';
import { InvalidBookDataError } from '../errors.js';

const decimalText = /^\d+(\.\d{1,8})?$/;

/** A positive price, exact up to 8 decimal places. */
export class Price {
  private constructor(readonly value: Decimal) {}

  static from(value: string): Price {
    if (!decimalText.test(value) || new Decimal(value).isZero()) {
      throw new InvalidBookDataError('price', 'must be a positive decimal string with up to 8 decimal places');
    }
    return new Price(new Decimal(value));
  }

  isMultipleOf(tick: Price): boolean {
    return this.value.mod(tick.value).isZero();
  }

  /** Negative when this price is lower, zero when equal, positive when higher. */
  compareTo(other: Price): number {
    return this.value.comparedTo(other.value);
  }

  isGreaterThan(other: Price): boolean {
    return this.value.greaterThan(other.value);
  }

  toString(): string {
    return this.value.toFixed(8);
  }
}
