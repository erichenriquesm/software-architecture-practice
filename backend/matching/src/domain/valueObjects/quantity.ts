import { Decimal } from 'decimal.js';
import { InvalidBookDataError } from '../errors.js';
import type { Price } from './price.js';

const scale = 8;
const decimalText = /^\d+(\.\d+)?$/;

/** A non-negative amount of an asset, exact up to 8 decimal places. */
export class Quantity {
  private constructor(private readonly amount: Decimal) {}

  static from(value: string): Quantity {
    if (!decimalText.test(value)) throw new InvalidBookDataError('quantity', 'must be a non-negative decimal string');
    return Quantity.of(new Decimal(value));
  }

  static zero(): Quantity {
    return new Quantity(new Decimal(0));
  }

  private static of(amount: Decimal): Quantity {
    if (amount.isNegative()) throw new InvalidBookDataError('quantity', 'cannot be negative');
    if (amount.decimalPlaces() > scale) throw new InvalidBookDataError('quantity', `has more than ${scale} decimal places`);
    return new Quantity(amount);
  }

  plus(other: Quantity): Quantity {
    return Quantity.of(this.amount.plus(other.amount));
  }

  minus(other: Quantity): Quantity {
    return Quantity.of(this.amount.minus(other.amount));
  }

  times(price: Price): Quantity {
    return Quantity.of(this.amount.times(price.value));
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isLessThan(other: Quantity): boolean {
    return this.amount.lessThan(other.amount);
  }

  min(other: Quantity): Quantity {
    return this.isLessThan(other) ? this : other;
  }

  isGreaterThan(other: Quantity): boolean {
    return this.amount.greaterThan(other.amount);
  }

  equals(other: Quantity): boolean {
    return this.amount.equals(other.amount);
  }

  isMultipleOf(step: Quantity): boolean {
    return this.amount.mod(step.amount).isZero();
  }

  fitsPrecision(decimalPlaces: number): boolean {
    return this.amount.decimalPlaces() <= decimalPlaces;
  }

  toString(): string {
    return this.amount.toFixed(scale);
  }
}
